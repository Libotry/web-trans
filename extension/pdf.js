import * as pdfjs from './vendor/pdfjs/build/pdf.mjs';
import { extractPage } from './pdf-extract.js';
import { pageState, chunksOf, nextBatch, applyResult, textBytes } from './pdf-state.js';
import { createOverlay } from './pdf-overlay.js';
import { downloadPDF, validateSourceURL } from './pdf-source.js';
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.mjs');
const $ = id => document.getElementById(id);
const MAX_BYTES = 50 * 1024 * 1024, TEXT_BUDGET = 20 * 1024 * 1024;
let doc, loading, renderTask, pdfWorker, nativeWorker, documentId, task, number = 1, generation = 0, view = 0;
let pages = new Map(), paused = false, running = false, restricted = false, limited = false;
let inFlight = 0, hits = 0, knownTokens = 0, hasUsage = false, autoTimer, passwordCallback;
let controls = Promise.resolve(), extracting = new Map(), translatingPage = null, starting = false, openAttempt = 0, controlEpoch = 0;
let sourceSession = null, sourceController = null, sourceEpoch = 0, renderedPage = null;
let overlay = createOverlay({ host: $('overlay'), onNotice: text => { $('overlayNotice').textContent = text; } });
$('readerVersion').textContent = 'v' + chrome.runtime.getManifest().version;
function notice(text, error = false) { $('status').textContent = text; $('status').className = error ? 'error' : ''; }
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '后台未响应；请求结果可能未知，请手动重试。');
  return result;
}
function identity() { return { documentId, taskId: task.taskId, token: task.token, generation: task.generation }; }
function current(localGeneration, localTask) { return generation === localGeneration && task === localTask; }
function updateStats() {
  const all = [...pages.values()].flatMap(chunksOf), local = chunksOf(pages.get(number));
  const done = all.filter(c => c.state === 'done').length, failed = all.filter(c => c.state === 'failed').length;
  $('stats').textContent = `当前页完成 ${local.filter(c => c.state === 'done').length} / ${local.length} 个片段 · 本文件已完成 ${done} 个片段 · 失败 ${failed} 个 · 请求 ${task?.count || 0} / ${task?.limit || '—'} 次 · 缓存命中 ${hits} 个片段${hasUsage ? ' · 已知用量 ' + knownTokens + ' tokens' : ' · token 用量未知'}`;
  $('pause').textContent = paused ? '继续' : '暂停';
  $('pause').disabled = !running; $('stop').disabled = !running && !starting;
  $('translate').disabled = !doc || restricted || !pages.get(number)?.blocks.length;
  $('retry').disabled = !local.some(c => c.state === 'failed') || restricted;
  $('extend').hidden = !limited; $('prev').disabled = number <= 1; $('next').disabled = !doc || number >= doc.numPages;
}
function highlight(block) {
  $('highlights').replaceChildren();
  const page = pages.get(number); if (!page) return;
  const scale = Number($('zoom').value);
  for (const r of block.rects) {
    const node = document.createElement('div'); node.className = 'highlight';
    Object.assign(node.style, { left: r.x * scale + 'px', top: r.y * scale + 'px', width: r.width * scale + 'px', height: r.height * scale + 'px' });
    $('highlights').append(node);
  }
}
function paintText() {
  const page = pages.get(number); $('blocks').replaceChildren(); $('textTitle').textContent = `第 ${number} 页 · 段落对照`;
  $('warning').textContent = [...(restricted ? ['此文档限制复制，首版不提供提取翻译。'] : []), ...(page?.warnings || [])].join(' ');
  if (!page?.blocks.length) { const p = document.createElement('p'); p.textContent = restricted ? '仍可阅读原始页面。' : '本页未提取到可翻译的英文文字；扫描图片、公式和表格不保证识别。'; $('blocks').append(p); }
  for (const [i, block] of (page?.blocks || []).entries()) {
    const card = document.createElement('article'); card.className = 'block';
    const source = document.createElement('button'); source.className = 'source'; source.textContent = `${i + 1}. ${block.text}`; source.title = '点击高亮原文位置（近似）'; source.onclick = () => highlight(block); card.append(source);
    for (const chunk of block.chunks) {
      const translation = document.createElement('p'); translation.className = 'translation';
      translation.textContent = chunk.state === 'done' ? chunk.translation : chunk.state === 'inflight' ? '正在翻译…' : chunk.state === 'failed' ? chunk.error : '等待翻译';
      if (chunk.state === 'failed') translation.classList.add('chunk-error'); card.append(translation);
    }
    $('blocks').append(card);
  }
  updateStats(); paintView();
}
function paintView() {
  const mode = $('mode').value, page = pages.get(number), visible = mode === 'inline' || mode === 'sideBySide';
  $('panes').className = 'panes mode-' + mode;
  $('textPane').hidden = mode !== 'list'; $('translatedPane').hidden = mode !== 'sideBySide';
  $('primaryTitle').textContent = mode === 'inline' ? 'PDF · 页内译文（未完成段落保留原文）' : '原始 PDF';
  const parent = mode === 'sideBySide' ? $('translatedCanvasHost') : $('canvasHost');
  if ($('overlay').parentElement !== parent) parent.append($('overlay'));
  if (!visible || !page || !renderedPage || renderedPage.number !== number || renderedPage.generation !== generation || renderedPage.scale !== Number($('zoom').value)) { overlay.clear(); return; }
  const result = overlay.render({ page, scale: renderedPage.scale, width: renderedPage.width, height: renderedPage.height, fontScale: Number($('fontScale').value), mask: $('mask').checked });
  $('overlayNotice').textContent = result.skipped ? `${result.skipped} 个段落不适合自动覆盖，请切换段落列表核对。` : '译文按近似文字坐标覆盖；可查看原文或展开全文，复杂底图请关闭遮罩。';
}
async function changeMode() {
  overlay.clear(); paintView();
  if (!doc) return;
  const localGeneration = generation, localView = ++view, target = number;
  try {
    await Promise.all([render(target, localGeneration, localView), extract(target, localGeneration)]);
    if (generation === localGeneration && view === localView) { paintText(); notice('本页已在本地解析。显示设置已更新，不会重复调用模型。'); }
  } catch (error) { if (generation === localGeneration && view === localView) fail(error); }
}
async function extract(numberToRead, localGeneration) {
  if (pages.has(numberToRead)) return pages.get(numberToRead);
  if (extracting.has(numberToRead)) return extracting.get(numberToRead);
  if (textBytes(pages) >= TEXT_BUDGET) throw new Error('本文件文字内存预算已满，请结束任务或重新打开文件。');
  const activeDoc = doc;
  const promise = (async () => {
    const page = await activeDoc.getPage(numberToRead);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const content = restricted ? { items: [] } : await page.getTextContent();
    if (generation !== localGeneration) return;
    const unit = page.userUnit || 1, [offsetX, offsetY] = page.view;
    const items = content.items.map(item => !item.transform ? item : {
      ...item, width: item.width * unit, height: item.height * unit,
      transform: item.transform.map((value, index) => (index === 4 ? value - offsetX : index === 5 ? value - offsetY : value) * unit)
    });
    const result = pageState(numberToRead, extractPage(items, { width: viewport.width, height: viewport.height, rotation: page.rotate }));
    const naturalViewport = page.getViewport({ scale: 1 });
    result.width = naturalViewport.width; result.height = naturalViewport.height; result.extractionVersion = 1;
    if (textBytes(pages) + textBytes(new Map([[numberToRead, result]])) > TEXT_BUDGET) throw new Error('本文件文字内存预算已满，请结束任务或重新打开文件。');
    pages.set(numberToRead, result); return result;
  })();
  extracting.set(numberToRead, promise);
  try { return await promise; } finally { if (generation === localGeneration) extracting.delete(numberToRead); }
}
async function render(numberToRender, localGeneration, localView) {
  renderTask?.cancel(); renderTask = null; renderedPage = null; overlay.clear();
  const page = await doc.getPage(numberToRender);
  if (generation !== localGeneration || view !== localView) return;
  const scale = Number($('zoom').value), viewport = page.getViewport({ scale });
  const copies = $('mode').value === 'sideBySide' ? 2 : 1;
  const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(12000000 / (viewport.width * viewport.height * copies)));
  $('translatedCanvas').width = 1; $('translatedCanvas').height = 1;
  // A detached canvas prevents a cancelled render from racing the next page.
  const canvas = document.createElement('canvas'); canvas.id = 'canvas';
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
  $('canvas').replaceWith(canvas); $('highlights').replaceChildren();
  const job = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: pdfjs.AnnotationMode.DISABLE }); renderTask = job;
  try {
    await job.promise;
    if (generation !== localGeneration || view !== localView) return;
    if (copies === 2) {
      const copy = $('translatedCanvas'); copy.width = canvas.width; copy.height = canvas.height;
      copy.style.width = viewport.width + 'px'; copy.style.height = viewport.height + 'px';
      copy.getContext('2d').drawImage(canvas, 0, 0);
    }
    renderedPage = { number: numberToRender, generation: localGeneration, scale, width: viewport.width / scale, height: viewport.height / scale };
  } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
  finally { if (renderTask === job) renderTask = null; page.cleanup(); }
}
function syncControl() {
  const localTask = task, localGeneration = generation, pageNumber = number, isPaused = paused || !running || translatingPage !== number;
  if (!localTask || localTask.stopped || !running) return Promise.resolve();
  const auth = identity();
  controls = controls.catch(() => {}).then(async () => {
    if (!current(localGeneration, localTask)) return;
    await request({ type: 'PDF_PAUSE', ...auth, paused: isPaused, pageNumber });
  });
  return controls;
}
async function showPage(target, translateAutomatically = true) {
  if (!doc) return;
  const previousNumber = number;
  number = Math.max(1, Math.min(doc.numPages, Number(target) || 1)); number = Math.floor(number);
  if (number !== previousNumber) { translatingPage = null; controlEpoch++; }
  $('pageNumber').value = number; clearTimeout(autoTimer);
  const localGeneration = generation, localView = ++view, intent = controlEpoch, targetNumber = number;
  $('blocks').replaceChildren(); $('warning').textContent = ''; notice('正在读取当前页…'); updateStats();
  const sync = syncControl();
  try {
    await Promise.all([render(number, localGeneration, localView), extract(number, localGeneration), sync]);
    if (generation !== localGeneration || number !== targetNumber) return;
    if (translateAutomatically && $('auto').checked && !paused && controlEpoch === intent) autoTimer = setTimeout(() => {
      if ($('auto').checked && controlEpoch === intent && generation === localGeneration && number === targetNumber) start().catch(fail);
    }, 300);
    if (view !== localView) return;
    paintText(); notice('本页已在本地解析。点击“翻译当前页”发送文字。');
  } catch (error) { if (generation === localGeneration && view === localView) { notice(error.message, true); updateStats(); } }
}
function fail(error) { notice(error.message || '操作失败。', true); }
async function stop() {
  controlEpoch++;
  $('auto').checked = false;
  clearTimeout(autoTimer); running = false; paused = false;
  const old = task;
  if (old) {
    // Invalidate the local task before awaiting cancellation: late responses cannot apply.
    task = { ...old, stopped: true }; const auth = { documentId, taskId: old.taskId, token: old.token, generation: old.generation };
    for (const page of pages.values()) for (const chunk of chunksOf(page)) if (chunk.state === 'inflight') { chunk.state = 'failed'; chunk.error = '请求已停止，结果未知；可能已计费，可手动重试。'; }
    const stoppedTask = task;
    try { const result = await request({ type: 'PDF_CANCEL', ...auth }); if (task === stoppedTask) { task.count = result.count; task.limit = result.limit; } } catch (error) { notice(error.message, true); }
  }
  paintText();
}
async function dispose() {
  generation++; view++; controlEpoch++; running = false; translatingPage = null; clearTimeout(autoTimer); renderTask?.cancel(); renderTask = null;
  const oldTask = task, oldId = documentId; task = null;
  if (oldTask) request({ type: 'PDF_CANCEL', documentId: oldId, taskId: oldTask.taskId, token: oldTask.token, generation: oldTask.generation }).catch(() => {});
  passwordCallback = null; $('password').value = ''; if ($('passwordDialog').open) $('passwordDialog').close();
  const oldLoading = loading, oldPDFWorker = pdfWorker, oldNativeWorker = nativeWorker;
  loading = pdfWorker = nativeWorker = null; doc = null; renderedPage = null;
  pages = new Map(); extracting = new Map(); controls = Promise.resolve(); overlay.clear(); overlay.resetAll();
  $('canvas').width = 1; $('canvas').height = 1; $('translatedCanvas').width = 1; $('translatedCanvas').height = 1; $('highlights').replaceChildren();
  if (oldLoading) await oldLoading.destroy().catch(() => {});
  oldPDFWorker?.destroy(); oldNativeWorker?.terminate();
}
function sourceIdentity(source = sourceSession) { return { sourceId: source.sourceId, token: source.token, sourceEpoch: source.sourceEpoch }; }
function cancelSource() {
  sourceEpoch++; openAttempt++; sourceController?.abort(); sourceController = null;
  $('sourceCancel').hidden = true; $('sourceRetry').hidden = !sourceSession;
}
function releaseSource() {
  cancelSource(); const old = sourceSession; sourceSession = null;
  if (old) request({ type: 'PDF_SOURCE_RELEASE', ...sourceIdentity(old) }).catch(() => {});
  $('sourcePanel').hidden = true; $('returnSource').hidden = true;
}
async function fetchSource() {
  if (!sourceSession) return;
  cancelSource(); const localSource = sourceSession, epoch = sourceEpoch, attempt = ++openAttempt;
  const controller = new AbortController(); sourceController = controller;
  $('sourceRetry').hidden = true; $('sourceCancel').hidden = false;
  $('sourceStatus').textContent = '正在从来源网站读取 PDF…';
  try {
    const validated = validateSourceURL(localSource.sourceURL);
    if (!await chrome.permissions.contains({ origins: [validated.permissionOrigin] })) throw new Error('来源网站权限未授予或已撤销，请返回来源页后重新点击扩展授权，或导入本地文件。');
    if (epoch !== sourceEpoch || sourceSession !== localSource) return;
    const result = await downloadPDF(localSource, { signal: controller.signal, onProgress: progress => {
      if (epoch !== sourceEpoch) return;
      const bytes = typeof progress === 'number' ? progress : progress.received ?? progress.loaded ?? progress.bytes ?? 0;
      $('sourceStatus').textContent = `正在读取 PDF：${(bytes / 1024 / 1024).toFixed(1)} MiB（上限 50 MiB）`;
    } });
    if (epoch !== sourceEpoch || sourceSession !== localSource || attempt !== openAttempt) return;
    await loadDocument(result.data, result.filename || localSource.filename || 'document.pdf', attempt, result.initialPage || localSource.initialPage || 1);
    if (epoch === sourceEpoch && doc) $('sourceStatus').textContent = 'PDF 已在本地解析；尚未自动发送文字给模型。';
  } catch (error) {
    if (epoch !== sourceEpoch || sourceSession !== localSource) return;
    $('sourceStatus').textContent = controller.signal.aborted ? '已取消读取。可以重试、返回来源或导入本地文件。' : (error.message || '无法重新获取该文件，请保存后从本地导入。');
    $('sourceRetry').hidden = false;
  } finally { if (epoch === sourceEpoch) { sourceController = null; $('sourceCancel').hidden = true; } }
}
async function claimSource() {
  const epoch = sourceEpoch, attempt = openAttempt;
  try {
    const result = await request({ type: 'PDF_SOURCE_CLAIM' });
    if (epoch !== sourceEpoch || attempt !== openAttempt || !result.available) return;
    validateSourceURL(result.sourceURL); sourceSession = result;
    $('sourcePanel').hidden = false; $('returnSource').hidden = false;
    $('sourceHost').textContent = '来源：' + result.displayHost;
    await fetchSource();
  } catch { if (epoch === sourceEpoch && attempt === openAttempt) notice('如刚从在线 PDF 切换，来源交接可能已过期。请返回源文件重新尝试，或导入本地 PDF。', true); }
}
async function returnSource() {
  const old = sourceSession; if (!old) return;
  const validated = validateSourceURL(old.sourceURL); cancelSource();
  const epoch = sourceEpoch, attempt = openAttempt;
  await stop();
  if (sourceSession !== old || epoch !== sourceEpoch || attempt !== openAttempt) return;
  await dispose();
  if (sourceSession !== old || epoch !== sourceEpoch || attempt !== openAttempt) return;
  try { await request({ type: 'PDF_SOURCE_RETURN', ...sourceIdentity(old) }); }
  catch { window.location.assign(validated.sourceURL); }
}
async function openFile(file) {
  if (!file) return;
  if (doc && !confirm('打开其他文件将结束当前任务，当前文件的阅读结果不会永久保存。继续？')) return;
  if (file.size > MAX_BYTES) { notice('文件超过 50 MiB，请选择较小的 PDF。', true); return; }
  const attempt = ++openAttempt;
  const data = new Uint8Array(await file.arrayBuffer());
  if (attempt !== openAttempt) return;
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes('%PDF-')) { notice('文件不是有效的 PDF。', true); return; }
  releaseSource(); const acceptedAttempt = ++openAttempt;
  await loadDocument(data, file.name, acceptedAttempt);
}
async function loadDocument(data, filename, attempt, initialPage = 1) {
  if (attempt !== openAttempt) return;
  await dispose(); if (attempt !== openAttempt) return; const localGeneration = generation;
  number = 1; documentId = crypto.randomUUID(); paused = restricted = limited = false; hits = knownTokens = 0; hasUsage = false;
  $('auto').checked = false; $('filename').textContent = filename; $('intro').hidden = true; $('reader').hidden = false; notice('正在本地打开 PDF…');
  try {
    if (generation !== localGeneration) return;
    // Explicit local port avoids PDF.js treating the extension's opaque URL origin as a CDN
    // and creating a blob wrapper (which would violate the extension's strict CSP).
    nativeWorker = new Worker(chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.mjs'), { type: 'module', name: 'pdf-parser' });
    pdfWorker = new pdfjs.PDFWorker({ port: nativeWorker });
    const localLoading = pdfjs.getDocument({ data, worker: pdfWorker, cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'), useWorkerFetch: false, useWasm: false, enableXfa: false, isEvalSupported: false, stopAtErrors: true });
    loading = localLoading;
    localLoading.onPassword = (callback, reason) => {
      if (generation !== localGeneration || attempt !== openAttempt) return;
      passwordCallback = callback; $('passwordHint').textContent = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入。' : '密码仅在本页临时使用，不会发送给模型服务。';
      $('password').value = ''; if (!$('passwordDialog').open) $('passwordDialog').showModal(); $('password').focus();
    };
    const workerFailure = new Promise((_, reject) => nativeWorker.addEventListener('error', () => reject(new Error('本地 PDF 解析 Worker 加载失败，请重新加载扩展。')), { once: true }));
    const opened = await Promise.race([localLoading.promise, workerFailure]);
    if (generation !== localGeneration || attempt !== openAttempt) { if (loading === localLoading) await dispose(); return; }
    doc = opened;
    if (opened.numPages > 500) throw new Error('文件超过 500 页，首版暂不支持。');
    const permissions = await opened.getPermissions();
    if (generation !== localGeneration || attempt !== openAttempt || doc !== opened) { if (loading === localLoading) await dispose(); return; }
    restricted = permissions !== null && !permissions.includes(pdfjs.PermissionFlag.COPY);
    $('pageCount').textContent = `/ ${opened.numPages} 页`; $('pageNumber').max = opened.numPages;
    await showPage(Math.max(1, Math.min(doc.numPages, Number.isInteger(initialPage) ? initialPage : 1)), false);
  } catch (error) {
    if (generation !== localGeneration || attempt !== openAttempt) return;
    await dispose(); if (attempt !== openAttempt) return;
    $('intro').hidden = false; $('reader').hidden = true; notice(error.message || 'PDF 无法打开，可能已损坏或加密方式不受支持。', true);
    throw error;
  }
}
async function start(retry = false) {
  if (starting) return;
  starting = true; controlEpoch++; updateStats();
  try { await startPage(retry); } finally { starting = false; updateStats(); }
}
async function startPage(retry) {
  const page = pages.get(number); if (!doc || restricted || !page?.blocks.length) return;
  const intent = controlEpoch, requestedPage = number, requestedDocument = documentId;
  if (textBytes(pages) >= TEXT_BUDGET) throw new Error('文字内存预算已满，请结束任务或重新打开文件。');
  if (task && !task.stopped && running) {
    const activeTask = task, localGeneration = generation;
    const status = await request({ type: 'PDF_STATUS', ...identity() });
    if (!current(localGeneration, activeTask) || controlEpoch !== intent || number !== requestedPage) return;
    task.count = status.count; task.limit = status.limit;
    if (status.configChanged || !status.active || status.blocked) { running = false; task = { ...task, stopped: true }; }
  }
  if (!task || task.stopped || !running) {
    const localGeneration = generation;
    const created = await request({ type: 'PDF_START', documentId: requestedDocument, pageNumber: requestedPage });
    if (generation !== localGeneration || controlEpoch !== intent || number !== requestedPage || documentId !== requestedDocument) {
      await request({ type: 'PDF_CANCEL', documentId: requestedDocument, taskId: created.taskId, token: created.token, generation: created.generation }).catch(() => {});
      return;
    }
    if (task && task.configFingerprint !== created.configFingerprint) {
      for (const previousPage of pages.values()) for (const c of chunksOf(previousPage)) { c.state = 'pending'; c.translation = ''; c.error = ''; }
      hits = knownTokens = 0; hasUsage = false;
    }
    task = created; running = true; paused = false; limited = false;
  }
  if (retry) for (const c of chunksOf(page)) if (c.state === 'failed') { c.state = 'pending'; c.error = ''; }
  translatingPage = number; paused = false; await syncControl();
  if (controlEpoch !== intent || number !== requestedPage || documentId !== requestedDocument || !running) return;
  paintText(); notice('仅翻译当前页；已派发的请求可能计费。'); pump();
}
function pump() {
  if (!running || paused || limited || !task || task.stopped || translatingPage !== number) return;
  while (inFlight < 2) {
    const page = pages.get(number), batch = nextBatch(page); if (!batch.length) break;
    for (const chunk of batch) chunk.state = 'inflight';
    const localTask = task, localGeneration = generation, auth = identity(), pageNumber = number;
    inFlight++;
    (async () => {
      try {
        await controls;
        if (!current(localGeneration, localTask)) return;
        if (paused || number !== pageNumber || !running) { for (const c of batch) c.state = 'pending'; return; }
        const result = await request({ type: 'PDF_TRANSLATE', ...auth, pageNumber, segments: batch.map(c => ({ id: c.id, text: c.text })) });
        if (!current(localGeneration, localTask)) return;
        if (Number.isFinite(result.count)) task.count = result.count;
        if (result.limit === true) { limited = true; paused = true; for (const c of batch) c.state = 'pending'; notice(result.error || '达到本文件请求上限，请增加额度。'); return; }
        applyResult(batch, result);
        if (result.cached) hits += batch.length;
        if (result.tokens !== null && Number.isFinite(result.tokens)) { knownTokens += result.tokens; hasUsage = true; }
        if (textBytes(pages) >= TEXT_BUDGET) { paused = true; await syncControl(); notice('文字内存预算已满，已暂停新增翻译。', true); }
      } catch (error) {
        if (!current(localGeneration, localTask)) return;
        for (const c of batch) { c.state = 'failed'; c.error = error.message; }
        notice(error.message, true);
        // Reconcile after failures; do not turn unknown results into automatic retries.
        try {
          const status = await request({ type: 'PDF_STATUS', ...auth });
          if (current(localGeneration, localTask)) { task.count = status.count; task.limit = status.limit; if (status.blocked || status.configChanged || status.active === false) { paused = true; running = false; task.stopped = true; } }
        } catch { if (current(localGeneration, localTask)) { paused = true; running = false; task.stopped = true; } }
      } finally {
        inFlight--;
        if (generation === localGeneration) { paintText(); pump(); }
        else if (running) pump();
      }
    })();
  }
  paintText();
}
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('mode').onchange = () => changeMode();
$('fontScale').onchange = paintView; $('mask').onchange = paintView;
$('resetLayout').onclick = () => { overlay.resetPage(number); paintView(); };
$('returnSource').onclick = () => returnSource().catch(fail);
$('sourceRetry').onclick = () => fetchSource();
$('sourceCancel').onclick = async () => {
  cancelSource(); const attempt = openAttempt, epoch = sourceEpoch;
  if (loading) { await dispose(); if (attempt !== openAttempt || epoch !== sourceEpoch) return; $('reader').hidden = true; $('intro').hidden = false; }
  if (attempt === openAttempt && epoch === sourceEpoch) $('sourceStatus').textContent = '已取消读取。可重试、返回来源或导入本地文件。';
};
$('file').onchange = () => { const file = $('file').files[0]; $('file').value = ''; openFile(file).catch(fail); };
$('prev').onclick = () => showPage(number - 1); $('next').onclick = () => showPage(number + 1);
$('pageNumber').onchange = () => showPage($('pageNumber').value); $('zoom').onchange = () => changeMode();
$('translate').onclick = () => start().catch(fail); $('retry').onclick = () => start(true).catch(fail);
$('stop').onclick = async () => {
  const operation = stop(), intent = controlEpoch;
  await operation; if (controlEpoch === intent) notice('任务已停止；在途请求可能已计费。');
};
$('pause').onclick = async () => { paused = !paused; try { await syncControl(); paintText(); if (!paused) pump(); } catch (e) { fail(e); } };
$('auto').onchange = () => { clearTimeout(autoTimer); if ($('auto').checked) notice('翻页后将发送当前页文字，不会预取下一页。'); };
$('extend').onclick = async () => {
  const localTask = task, localGeneration = generation, intent = controlEpoch;
  try {
    if (!localTask || localTask.stopped) return;
    const result = await request({ type: 'PDF_EXTEND', ...identity() });
    if (!current(localGeneration, localTask) || controlEpoch !== intent) return;
    task.limit = result.limit; limited = false; paused = false; await syncControl();
    if (current(localGeneration, localTask) && controlEpoch === intent) pump();
  } catch (e) { if (current(localGeneration, localTask)) fail(e); }
};
$('clear').onclick = async () => {
  if (!confirm('清除本文件译文并停止任务？请求用量不会归零，后台会话缓存不会清除。')) return;
  const operation = stop(), intent = controlEpoch;
  await operation; if (controlEpoch !== intent) return;
  for (const page of pages.values()) for (const c of chunksOf(page)) { c.state = 'pending'; c.translation = ''; c.error = ''; }
  paintText(); notice('已清除本文件译文。');
};
$('passwordForm').onsubmit = event => { event.preventDefault(); const callback = passwordCallback; passwordCallback = null; const password = $('password').value; $('password').value = ''; $('passwordDialog').close(); callback?.(password); };
async function cancelPassword() {
  cancelSource(); const attempt = openAttempt, epoch = sourceEpoch;
  await dispose(); if (attempt !== openAttempt || epoch !== sourceEpoch) return;
  $('intro').hidden = false; $('reader').hidden = true; notice('已取消打开文件。');
  if (sourceSession) { $('sourceStatus').textContent = '已取消打开文件，可重试读取或本地导入。'; $('sourceRetry').hidden = false; }
}
$('passwordCancel').onclick = cancelPassword; $('passwordDialog').addEventListener('cancel', event => { event.preventDefault(); cancelPassword(); });
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => { event.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', event => { event.preventDefault(); document.body.classList.remove('dragging'); if (event.dataTransfer.files.length !== 1) { notice('请一次导入一个 PDF 文件。', true); return; } openFile(event.dataTransfer.files[0]).catch(fail); });
async function reconcile() {
  const localTask = task, localGeneration = generation;
  if (!localTask || localTask.stopped) return;
  try {
    const status = await request({ type: 'PDF_STATUS', ...identity() });
    if (!current(localGeneration, localTask)) return;
    task.count = status.count; task.limit = status.limit;
    if (status.configChanged || status.blocked || !status.active) {
      controlEpoch++; clearTimeout(autoTimer); running = false; paused = true;
      task = { ...localTask, stopped: true };
      for (const page of pages.values()) for (const c of chunksOf(page)) if (c.state === 'inflight') { c.state = 'failed'; c.error = '配置或任务状态已改变，结果未知；可能已计费。'; }
      notice(status.configChanged ? 'API 配置已变化，请点击翻译重新开始；旧配置译文将被清除。' : '任务已停止，请检查配置后重新开始。', true);
    }
    paintText();
  } catch (error) { if (current(localGeneration, localTask)) notice(error.message, true); }
}
window.addEventListener('focus', reconcile);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reconcile(); });
window.addEventListener('pagehide', () => {
  sourceController?.abort(); controlEpoch++; openAttempt++; sourceEpoch++; generation++; running = false; clearTimeout(autoTimer);
  if (task) chrome.runtime.sendMessage({ type: 'PDF_CANCEL', ...identity() }).catch(() => {});
  task = null;
  if (sourceSession) chrome.runtime.sendMessage({ type: 'PDF_SOURCE_RELEASE', ...sourceIdentity() }).catch(() => {});
  overlay.destroy(); renderTask?.cancel(); nativeWorker?.terminate();
});
updateStats(); claimSource();

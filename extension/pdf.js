import * as pdfjs from './vendor/pdfjs/build/pdf.mjs';
import { extractPage } from './pdf-extract.js';
import { pageState, chunksOf, nextBatch, applyResult, textBytes } from './pdf-state.js';
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.mjs');
const $ = id => document.getElementById(id);
const MAX_BYTES = 50 * 1024 * 1024, TEXT_BUDGET = 20 * 1024 * 1024;
let doc, loading, renderTask, pdfWorker, nativeWorker, documentId, task, number = 1, generation = 0, view = 0;
let pages = new Map(), paused = false, running = false, restricted = false, limited = false;
let inFlight = 0, hits = 0, knownTokens = 0, hasUsage = false, autoTimer, passwordCallback;
let controls = Promise.resolve(), extracting = new Map(), translatingPage = null, starting = false, openAttempt = 0, controlEpoch = 0;
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
  updateStats();
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
    if (textBytes(pages) + textBytes(new Map([[numberToRead, result]])) > TEXT_BUDGET) throw new Error('本文件文字内存预算已满，请结束任务或重新打开文件。');
    pages.set(numberToRead, result); return result;
  })();
  extracting.set(numberToRead, promise);
  try { return await promise; } finally { if (generation === localGeneration) extracting.delete(numberToRead); }
}
async function render(numberToRender, localGeneration, localView) {
  renderTask?.cancel(); renderTask = null;
  const page = await doc.getPage(numberToRender);
  if (generation !== localGeneration || view !== localView) return;
  const scale = Number($('zoom').value), viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(12000000 / (viewport.width * viewport.height)));
  // A detached canvas prevents a cancelled render from racing the next page.
  const canvas = document.createElement('canvas'); canvas.id = 'canvas';
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio)); canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
  $('canvas').replaceWith(canvas); $('highlights').replaceChildren();
  const job = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0], annotationMode: pdfjs.AnnotationMode.DISABLE }); renderTask = job;
  try { await job.promise; } catch (error) { if (error.name !== 'RenderingCancelledException') throw error; }
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
  const localGeneration = generation, localView = ++view, intent = controlEpoch;
  $('blocks').replaceChildren(); $('warning').textContent = ''; notice('正在读取当前页…'); updateStats();
  const sync = syncControl();
  try {
    await Promise.all([render(number, localGeneration, localView), extract(number, localGeneration), sync]);
    if (generation !== localGeneration || view !== localView) return;
    paintText(); notice('本页已在本地解析。点击“翻译当前页”发送文字。');
    if (translateAutomatically && $('auto').checked && !paused && controlEpoch === intent) autoTimer = setTimeout(() => {
      if (controlEpoch === intent && generation === localGeneration && view === localView) start().catch(fail);
    }, 300);
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
  const oldLoading = loading; loading = null; doc = null; pages = new Map(); extracting = new Map(); controls = Promise.resolve();
  if (oldLoading) await oldLoading.destroy().catch(() => {});
  pdfWorker?.destroy(); pdfWorker = null; nativeWorker?.terminate(); nativeWorker = null;
  $('canvas').width = 1; $('canvas').height = 1; $('highlights').replaceChildren();
}
async function openFile(file) {
  if (!file) return;
  if (doc && !confirm('打开其他文件将结束当前任务，当前文件的阅读结果不会永久保存。继续？')) return;
  const attempt = ++openAttempt;
  if (file.size > MAX_BYTES) { notice('文件超过 50 MiB，请选择较小的 PDF。', true); return; }
  const head = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
  if (attempt !== openAttempt) return;
  if (!head.includes('%PDF-')) { notice('文件不是有效的 PDF。', true); return; }
  await dispose(); if (attempt !== openAttempt) return; const localGeneration = generation;
  number = 1; documentId = crypto.randomUUID(); paused = restricted = limited = false; hits = knownTokens = 0; hasUsage = false;
  $('auto').checked = false; $('filename').textContent = file.name; $('intro').hidden = true; $('reader').hidden = false; notice('正在本地打开 PDF…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (generation !== localGeneration) return;
    // Explicit local port avoids PDF.js treating the extension's opaque URL origin as a CDN
    // and creating a blob wrapper (which would violate the extension's strict CSP).
    nativeWorker = new Worker(chrome.runtime.getURL('vendor/pdfjs/build/pdf.worker.mjs'), { type: 'module', name: 'pdf-parser' });
    pdfWorker = new pdfjs.PDFWorker({ port: nativeWorker });
    const localLoading = pdfjs.getDocument({ data, worker: pdfWorker, cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: chrome.runtime.getURL('vendor/pdfjs/standard_fonts/'), useWorkerFetch: false, useWasm: false, enableXfa: false, isEvalSupported: false, stopAtErrors: true });
    loading = localLoading;
    localLoading.onPassword = (callback, reason) => {
      if (generation !== localGeneration) return;
      passwordCallback = callback; $('passwordHint').textContent = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? '密码不正确，请重新输入。' : '密码仅在本页临时使用，不会发送给模型服务。';
      $('password').value = ''; if (!$('passwordDialog').open) $('passwordDialog').showModal(); $('password').focus();
    };
    const workerFailure = new Promise((_, reject) => nativeWorker.addEventListener('error', () => reject(new Error('本地 PDF 解析 Worker 加载失败，请重新加载扩展。')), { once: true }));
    const opened = await Promise.race([localLoading.promise, workerFailure]);
    if (generation !== localGeneration) return;
    doc = opened;
    if (doc.numPages > 500) throw new Error('文件超过 500 页，首版暂不支持。');
    const permissions = await doc.getPermissions();
    restricted = permissions !== null && !permissions.includes(pdfjs.PermissionFlag.COPY);
    $('pageCount').textContent = `/ ${doc.numPages} 页`; $('pageNumber').max = doc.numPages;
    await showPage(1, false);
  } catch (error) {
    if (generation !== localGeneration) return;
    await dispose(); $('intro').hidden = false; $('reader').hidden = true; notice(error.message || 'PDF 无法打开，可能已损坏或加密方式不受支持。', true);
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
$('file').onchange = () => { const file = $('file').files[0]; $('file').value = ''; openFile(file).catch(fail); };
$('prev').onclick = () => showPage(number - 1); $('next').onclick = () => showPage(number + 1);
$('pageNumber').onchange = () => showPage($('pageNumber').value); $('zoom').onchange = () => showPage(number, false);
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
async function cancelPassword() { await dispose(); $('intro').hidden = false; $('reader').hidden = true; notice('已取消打开文件。'); }
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
window.addEventListener('pagehide', () => { if (task) chrome.runtime.sendMessage({ type: 'PDF_CANCEL', ...identity() }).catch(() => {}); });
updateStats();

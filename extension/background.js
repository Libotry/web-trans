import { DEFAULTS, validateConfig, buildRequest, parseTranslations, digest } from './core.js';
const jobs = new Map(), pdfJobs = new Map(), controllers = new Map(), pdfPending = new Map();
let busy = 0, cacheWrites = Promise.resolve(), pdfStarts = Promise.resolve(); const waiters = [];
const pdfURL = () => chrome.runtime.getURL('pdf.html');
function isPdfURL(value) {
  try { const u = new URL(value), expected = new URL(pdfURL()); return u.protocol === expected.protocol && u.host === expected.host && u.pathname === expected.pathname && !u.search && !u.hash; } catch { return false; }
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('job:')) jobs.set(v.tabId, v);
    if (k.startsWith('pdfJob:')) {
      // Only metadata survives a worker restart; never replay an uncertain request.
      try { if (!isPdfURL((await chrome.tabs.get(v.tabId)).url)) throw new Error(); pdfJobs.set(v.taskId, v); }
      catch { await chrome.storage.session.remove(k); }
    }
  }
})();
const save = j => chrome.storage.session.set({ ['job:' + j.tabId]: { ...j } });
const savePDF = j => pdfJobs.get(j.taskId) === j ? chrome.storage.session.set({ ['pdfJob:' + j.taskId]: { ...j } }) : Promise.resolve();
async function config() {
  const local = await chrome.storage.local.get(['config', 'key']); const session = await chrome.storage.session.get('key');
  return { c: { ...DEFAULTS, ...local.config }, key: session.key || local.key || '' };
}
const fingerprint = (c, key) => digest(JSON.stringify([c.endpoint, c.model, c.jsonMode, key, 'prompt-v1']));
function trusted(sender) { return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('')); }
function jobFor(m, sender) {
  const j = jobs.get(sender.tab?.id);
  if (!j || !j.active || sender.frameId !== 0 || j.token !== m.token || (j.documentId && j.documentId !== sender.documentId)) throw new Error('页面任务已失效，请重新点击翻译。');
  if (!j.documentId) j.documentId = sender.documentId;
  return j;
}
function pdfSender(sender) {
  if (sender.id !== chrome.runtime.id || !isPdfURL(sender.url) || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('只允许 PDF 阅读页主文档执行此操作。');
}
function pdfFor(m, sender, active = true) {
  pdfSender(sender); const j = pdfJobs.get(m.taskId);
  if (!j || j.tabId !== sender.tab.id || j.ownerDocumentId !== sender.documentId || j.documentId !== m.documentId || j.token !== m.token || j.generation !== m.generation || (active && !j.active)) throw new Error('PDF 任务已失效，请重新开始翻译。');
  return j;
}
function pageNumber(value) { if (!Number.isInteger(value) || value < 1 || value > 500) throw new Error('PDF 页码无效。'); return value; }
function pdfStatus(j, configChanged = false) {
  return { documentId: j.documentId, taskId: j.taskId, token: j.token, generation: j.generation, configFingerprint: j.configFingerprint,
    count: j.count, limit: j.limit, active: j.active, paused: j.paused, pageNumber: j.pageNumber, blocked: !!j.blocked, configChanged };
}
function invalidateQueue(j) { j.queueEpoch++; for (const c of pdfPending.get(j.taskId) || []) c.abort(); }
function abortPDF(j) { invalidateQueue(j); for (const x of controllers.values()) if (x.taskId === j.taskId) x.controller.abort(); }
async function invalidatePDFConfig(c, key) {
  const current = await fingerprint(c, key);
  for (const j of pdfJobs.values()) if (j.active && j.configFingerprint !== current) { j.paused = true; abortPDF(j); await savePDF(j); }
}
async function pdfConfig(j) {
  const current = await config();
  if (await fingerprint(current.c, current.key) !== j.configFingerprint) {
    j.paused = true; invalidateQueue(j); await savePDF(j); throw new Error('配置已变化，请重新开始翻译。');
  }
  validateConfig(current.c); return current;
}
function validateSegments(segments) {
  if (!Array.isArray(segments) || !segments.length || segments.length > 6 || segments.some(s => !s || typeof s.id !== 'string' || !s.id || s.id.length > 100 || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000) || new Set(segments.map(s => s.id)).size !== segments.length || segments.reduce((n, s) => n + s.text.length, 0) > 6500) throw new Error('段落批次无效。');
}
async function cacheLookup(c, key, segments) {
  const cacheKey = 'cache:' + await digest(JSON.stringify([c.endpoint, c.model, c.jsonMode, key, segments.map(s => s.text), 'prompt-v1']));
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  return { cacheKey, result: Array.isArray(cached) && cached.length === segments.length && cached.every(t => typeof t === 'string' && t) ? { translations: segments.map((s, i) => ({ id: s.id, text: cached[i] })), cached: true, tokens: null } : null };
}
async function cacheStore(cacheKey, result) {
  if (!result.translations.every(t => t.text)) return;
  // Serialize eviction/writes across all readers. Cache failures never lose a paid result.
  const write = cacheWrites.then(async () => {
    const value = result.translations.map(t => t.text), all = await chrome.storage.session.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith('cache:') && k !== cacheKey);
    const bytes = (k, v) => (k.length + JSON.stringify(v).length) * 2;
    let size = bytes(cacheKey, value) + entries.reduce((n, [k, v]) => n + bytes(k, v), 0);
    const remove = [];
    while (entries.length >= 150 || size > 4 * 1024 * 1024) {
      const entry = entries.shift(); if (!entry) return;
      remove.push(entry[0]); size -= bytes(...entry);
    }
    if (remove.length) await chrome.storage.session.remove(remove);
    await chrome.storage.session.set({ [cacheKey]: value });
  });
  cacheWrites = write.catch(() => {}); await cacheWrites;
}
async function acquire(signal) {
  if (signal?.aborted) throw new Error('PDF 排队任务已取消。');
  if (busy < 2) { busy++; return; }
  await new Promise((resolve, reject) => {
    const w = { resolve, signal, abort: () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new Error('PDF 排队任务已取消。')); } };
    waiters.push(w); signal?.addEventListener('abort', w.abort, { once: true });
  });
}
function release() {
  const next = waiters.shift();
  if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); } else busy--;
}
function abort(tabId) {
  for (const [id, x] of controllers) if (x.tabId === tabId) { x.controller.abort(); controllers.delete(id); }
  for (const j of pdfJobs.values()) if (j.tabId === tabId) invalidateQueue(j);
}
async function callAPI(c, key, segments, controller, beforeFetch = () => {}) {
  if (!key) throw new Error('尚未配置 API Key，或会话密钥已随浏览器重启清除。');
  const origin = new URL(c.endpoint).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('请到设置页授权 API 域名。');
  if (controller.signal.aborted) throw new Error('请求已取消，服务端可能已计费。');
  beforeFetch();
  const timeout = setTimeout(() => controller.abort(), c.timeout * 1000);
  try {
    const response = await fetch(c.endpoint, { method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(buildRequest(c, segments)) });
    if (!response.ok) {
      const e = new Error(({ 401: 'API Key 无效', 403: 'API 无访问权限', 402: '余额不足', 429: '服务限流或配额耗尽，请稍后手动重试' })[response.status] || `API 请求失败（HTTP ${response.status}）`);
      e.fatal = [401, 402, 403].includes(response.status); throw e;
    }
    const text = await response.text(); if (text.length > 200000) throw new Error('API 返回内容过大。');
    let data; try { data = JSON.parse(text); } catch { throw new Error('API 返回的不是 JSON，请检查完整接口地址。'); }
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string') throw new Error('接口不兼容 Chat Completions，或模型未返回文本。');
    const usage = Number(data.usage?.total_tokens);
    return { translations: parseTranslations(raw, segments), tokens: Number.isFinite(usage) && usage >= 0 ? usage : null };
  } catch (e) { if (e.name === 'AbortError') throw new Error('请求已取消或超时，服务端可能已计费；结果未知，请手动重试。'); throw e; }
  finally { clearTimeout(timeout); }
}
async function translate(m, sender) {
  const j = jobFor(m, sender); const token = j.token;
  if (j.blocked) throw new Error('此任务因认证或余额问题停止，请修正配置后重新开始。');
  validateSegments(m.segments);
  const { c, key } = await config(); validateConfig(c);
  const { cacheKey, result: cached } = await cacheLookup(c, key, m.segments);
  jobFor(m, sender);
  if (cached) return cached;
  await acquire(); const controller = new AbortController(); const requestId = crypto.randomUUID();
  try {
    jobFor(m, sender);
    if (j.count >= c.limit) return { limit: true, error: '已达到单页请求上限。点击“增加额度”后继续。' };
    j.count++; await save(j); jobFor(m, sender);
    controllers.set(requestId, { tabId: j.tabId, controller });
    const result = await callAPI(c, key, m.segments, controller);
    if (jobs.get(j.tabId)?.token !== token || !j.active) throw new Error('任务已取消。');
    await cacheStore(cacheKey, result);
    return { ...result, cached: false };
  } catch (e) { if (e.fatal && jobs.get(j.tabId)?.token === token) { j.blocked = true; await save(j); } throw e; }
  finally { controllers.delete(requestId); release(); }
}
async function translatePDF(m, sender) {
  const j = pdfFor(m, sender); pageNumber(m.pageNumber); validateSegments(m.segments);
  if (j.blocked) throw new Error('此任务因认证或余额问题停止，请修正配置后重新开始。');
  const epoch = j.queueEpoch;
  const checkQueue = () => { pdfFor(m, sender); if (j.paused || j.queueEpoch !== epoch || j.pageNumber !== m.pageNumber) throw new Error('PDF 页面已切换或任务已暂停。'); };
  checkQueue();
  let pending = pdfPending.get(j.taskId); if (!pending) pdfPending.set(j.taskId, pending = new Set());
  if (pending.size >= 2) throw new Error('PDF 待处理批次过多，请等待当前批次完成。');
  const queued = new AbortController(); pending.add(queued);
  let acquired = false; const requestId = crypto.randomUUID(); const controller = new AbortController();
  const envelope = { documentId: j.documentId, taskId: j.taskId, generation: j.generation, pageNumber: m.pageNumber, configFingerprint: j.configFingerprint };
  try {
    const { c, key } = await pdfConfig(j); checkQueue();
    const { cacheKey, result: cached } = await cacheLookup(c, key, m.segments); checkQueue();
    if (cached) { await pdfConfig(j); checkQueue(); return { ...cached, ...envelope }; }
    await acquire(queued.signal); acquired = true;
    checkQueue(); await pdfConfig(j); checkQueue();
    if (j.count >= j.limit) return { ...envelope, limit: true, count: j.count, error: '已达到本文件请求上限。点击“增加额度”后继续。' };
    j.count++; await savePDF(j); checkQueue();
    // The request is now in flight: pause/page changes do not discard its old-page result.
    pending.delete(queued); controllers.set(requestId, { tabId: j.tabId, taskId: j.taskId, controller });
    const result = await callAPI(c, key, m.segments, controller, checkQueue);
    pdfFor(m, sender); await pdfConfig(j); pdfFor(m, sender);
    await cacheStore(cacheKey, result); await pdfConfig(j); pdfFor(m, sender);
    return { ...result, ...envelope, count: j.count, cached: false };
  } catch (e) {
    if (e.fatal && pdfJobs.get(j.taskId) === j && j.generation === m.generation) { j.blocked = true; j.paused = true; invalidateQueue(j); await savePDF(j); }
    throw e;
  } finally { pending.delete(queued); if (!pending.size && pdfPending.get(j.taskId) === pending) pdfPending.delete(j.taskId); controllers.delete(requestId); if (acquired) release(); }
}
async function handlePDF(m, sender) {
  pdfSender(sender);
  // URL/authentication parameters can only come from saved configuration, never a reader message.
  for (const field of ['endpoint', 'key', 'apiKey', 'headers', 'model', 'config']) if (Object.hasOwn(m, field)) throw new Error('PDF 消息包含不允许的配置字段。');
  if (m.type === 'PDF_START') {
    if (typeof m.documentId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(m.documentId)) throw new Error('PDF 文档标识无效。');
    const page = pageNumber(m.pageNumber ?? 1), { c, key } = await config(); validateConfig(c);
    if (!key) throw new Error('请先在设置中填写 API Key。');
    const configFingerprint = await fingerprint(c, key);
    let j;
    for (const existing of pdfJobs.values()) if (existing.tabId === sender.tab.id) {
      if (existing.ownerDocumentId !== sender.documentId) { abortPDF(existing); pdfJobs.delete(existing.taskId); await chrome.storage.session.remove('pdfJob:' + existing.taskId); }
      else {
        if (existing.documentId === m.documentId) j = existing;
        if (existing.active) { existing.active = false; abortPDF(existing); await savePDF(existing); }
      }
    }
    // A fresh record prevents a late async continuation of an old generation mutating its successor.
    j = j ? { ...j } : { taskId: crypto.randomUUID(), documentId: m.documentId, tabId: sender.tab.id, ownerDocumentId: sender.documentId, generation: 0, count: 0, limit: c.limit, queueEpoch: 0 };
    Object.assign(j, { token: crypto.randomUUID(), generation: j.generation + 1, configFingerprint, pageNumber: page, paused: false, active: true, blocked: false, touchedAt: Date.now() });
    pdfJobs.delete(j.taskId); pdfJobs.set(j.taskId, j); invalidateQueue(j);
    // Keep the current document plus at most nine recent inactive document ledgers per reader.
    const previous = [...pdfJobs.values()].reverse().filter(v => v.tabId === j.tabId && v.taskId !== j.taskId).sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0));
    for (const stale of previous.slice(9)) { abortPDF(stale); pdfJobs.delete(stale.taskId); await chrome.storage.session.remove('pdfJob:' + stale.taskId); }
    const status = pdfStatus(j); await savePDF(j); return status;
  }
  if (m.type === 'PDF_TRANSLATE') return translatePDF(m, sender);
  const j = pdfFor(m, sender, false);
  if (m.type === 'PDF_STATUS') { const { c, key } = await config(), changed = await fingerprint(c, key) !== j.configFingerprint; pdfFor(m, sender, false); return pdfStatus(j, changed); }
  if (m.type === 'PDF_CANCEL') { j.active = false; abortPDF(j); await savePDF(j); return pdfStatus(j); }
  if (m.type === 'PDF_PAUSE') {
    if (typeof m.paused !== 'boolean') throw new Error('PDF 暂停状态无效。');
    pdfFor(m, sender); if (m.pageNumber !== undefined) j.pageNumber = pageNumber(m.pageNumber);
    j.paused = m.paused; invalidateQueue(j); await savePDF(j); return pdfStatus(j);
  }
  if (m.type === 'PDF_EXTEND') {
    pdfFor(m, sender); const { c } = await pdfConfig(j); pdfFor(m, sender);
    if (!Number.isSafeInteger(j.limit + c.limit)) throw new Error('PDF 请求额度超出范围。');
    j.limit += c.limit; await savePDF(j); return pdfStatus(j);
  }
  throw new Error('未知 PDF 操作。');
}
async function handle(m, sender) {
  await ready;
  if (!m || typeof m.type !== 'string') throw new Error('无效消息。');
  if (m.type === 'PDF_START') { const start = pdfStarts.then(() => handlePDF(m, sender)); pdfStarts = start.catch(() => {}); return start; }
  if (m.type.startsWith('PDF_')) return handlePDF(m, sender);
  if (m.type === 'TRANSLATE') return translate(m, sender);
  if (m.type === 'CANCEL' || m.type === 'RESET' || m.type === 'EXTEND') {
    const j = jobFor(m, sender); abort(j.tabId);
    if (m.type === 'CANCEL') j.active = false;
    if (m.type === 'RESET') { j.token = crypto.randomUUID(); j.count = 0; }
    if (m.type === 'EXTEND') { j.count = 0; j.blocked = false; }
    await save(j); return { token: j.token };
  }
  if (!trusted(sender)) throw new Error('只允许扩展界面执行此操作。');
  if (m.type === 'GET_CONFIG') { const { c, key } = await config(); return { config: c, hasKey: !!key }; }
  if (m.type === 'SAVE_CONFIG') {
    const c = validateConfig(m.config); const old = await config(); const key = m.key || old.key;
    if (!key || typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('请输入有效 API Key。');
    if (c.remember) { await chrome.storage.local.set({ config: c, key }); await chrome.storage.session.remove('key'); }
    else { await chrome.storage.local.set({ config: c }); await chrome.storage.local.remove('key'); await chrome.storage.session.set({ key }); }
    await invalidatePDFConfig(c, key); return {};
  }
  if (m.type === 'TEST') { const { c, key } = await config(); await acquire(); try { return await callAPI(validateConfig(c), key, [{ id: 'test', text: 'Reading helps us understand the world.' }], new AbortController()); } finally { release(); } }
  if (m.type === 'CLEAR_CACHE') { await cacheWrites; const all = await chrome.storage.session.get(null); await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith('cache:'))); return {}; }
  if (m.type === 'FORGET_KEY') { await chrome.storage.session.remove('key'); await chrome.storage.local.remove('key'); const { c } = await config(); await invalidatePDFConfig(c, ''); return {}; }
  if (m.type === 'START') {
    const tab = await chrome.tabs.get(m.tabId);
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('请在普通 HTTP/HTTPS 网页上使用；PDF 请通过扩展的 PDF 翻译入口导入。');
    const { c, key } = await config(); validateConfig(c); if (!key) throw new Error('请先在设置中填写 API Key。');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    abort(tab.id); const j = { tabId: tab.id, token: crypto.randomUUID(), count: 0, active: true, documentId: null }; jobs.set(tab.id, j); await save(j);
    return chrome.tabs.sendMessage(tab.id, { type: 'START', token: j.token, scope: m.scope, style: { fontSize: c.fontSize, gap: c.gap, color: c.color, tint: c.tint } }, { frameId: 0 });
  }
  throw new Error('未知操作。');
}
chrome.runtime.onMessage.addListener((m, sender, respond) => { handle(m, sender).then(v => respond({ ok: true, ...v })).catch(e => respond({ ok: false, error: e.message || '操作失败。' })); return true; });
chrome.tabs.onRemoved.addListener(async id => {
  await ready; abort(id); jobs.delete(id); await chrome.storage.session.remove('job:' + id);
  for (const j of pdfJobs.values()) if (j.tabId === id) { pdfJobs.delete(j.taskId); pdfPending.delete(j.taskId); await chrome.storage.session.remove('pdfJob:' + j.taskId); }
});

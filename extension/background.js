import { DEFAULTS, validateConfig, buildRequest, parseTranslations, digest } from './core.js';
const jobs = new Map(), controllers = new Map(); let busy = 0; const waiters = [];
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const all = await chrome.storage.session.get(null);
  for (const [k, v] of Object.entries(all)) if (k.startsWith('job:')) jobs.set(v.tabId, v);
})();
const save = j => chrome.storage.session.set({ ['job:' + j.tabId]: { ...j } });
async function config() {
  const local = await chrome.storage.local.get(['config', 'key']); const session = await chrome.storage.session.get('key');
  return { c: { ...DEFAULTS, ...local.config }, key: session.key || local.key || '' };
}
function trusted(sender) { return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('')); }
function jobFor(m, sender) {
  const j = jobs.get(sender.tab?.id);
  if (!j || !j.active || sender.frameId !== 0 || j.token !== m.token || (j.documentId && j.documentId !== sender.documentId)) throw new Error('页面任务已失效，请重新点击翻译。');
  if (!j.documentId) j.documentId = sender.documentId;
  return j;
}
async function acquire() { if (busy >= 2) await new Promise(resolve => waiters.push(resolve)); else busy++; }
function release() { const next = waiters.shift(); if (next) next(); else busy--; }
function abort(tabId) { for (const [id, x] of controllers) if (x.tabId === tabId) { x.controller.abort(); controllers.delete(id); } }
async function callAPI(c, key, segments, controller) {
  if (!key) throw new Error('尚未配置 API Key，或会话密钥已随浏览器重启清除。');
  const origin = new URL(c.endpoint).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) throw new Error('请到设置页授权 API 域名。');
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
  if (!Array.isArray(m.segments) || !m.segments.length || m.segments.length > 6 || new Set(m.segments.map(s => s.id)).size !== m.segments.length || m.segments.some(s => typeof s.id !== 'string' || s.id.length > 100 || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000) || m.segments.reduce((n, s) => n + s.text.length, 0) > 6500) throw new Error('段落批次无效。');
  const { c, key } = await config(); validateConfig(c);
  const cacheKey = 'cache:' + await digest(JSON.stringify([c.endpoint, c.model, c.jsonMode, key, m.segments.map(s => s.text), 'prompt-v1']));
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  jobFor(m, sender);
  if (cached) return { translations: m.segments.map((s, i) => ({ id: s.id, text: cached[i] })), cached: true, tokens: null };
  await acquire(); const controller = new AbortController(); const requestId = crypto.randomUUID();
  try {
    jobFor(m, sender);
    if (j.count >= c.limit) return { limit: true, error: '已达到单页请求上限。点击“增加额度”后继续。' };
    j.count++; await save(j); jobFor(m, sender);
    controllers.set(requestId, { tabId: j.tabId, controller });
    const result = await callAPI(c, key, m.segments, controller);
    if (jobs.get(j.tabId)?.token !== token || !j.active) throw new Error('任务已取消。');
    if (result.translations.every(t => t.text)) {
      const all = await chrome.storage.session.get(null); const keys = Object.keys(all).filter(k => k.startsWith('cache:'));
      if (keys.length > 150) await chrome.storage.session.remove(keys.slice(0, 50));
      await chrome.storage.session.set({ [cacheKey]: result.translations.map(t => t.text) });
    }
    return { ...result, cached: false };
  } catch (e) { if (e.fatal && jobs.get(j.tabId)?.token === token) { j.blocked = true; await save(j); } throw e; }
  finally { controllers.delete(requestId); release(); }
}
async function handle(m, sender) {
  await ready;
  if (!m || typeof m.type !== 'string') throw new Error('无效消息。');
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
    return {};
  }
  if (m.type === 'TEST') { const { c, key } = await config(); return callAPI(validateConfig(c), key, [{ id: 'test', text: 'Reading helps us understand the world.' }], new AbortController()); }
  if (m.type === 'CLEAR_CACHE') { const all = await chrome.storage.session.get(null); await chrome.storage.session.remove(Object.keys(all).filter(k => k.startsWith('cache:'))); return {}; }
  if (m.type === 'FORGET_KEY') { await chrome.storage.session.remove('key'); await chrome.storage.local.remove('key'); return {}; }
  if (m.type === 'START') {
    const tab = await chrome.tabs.get(m.tabId);
    if (!/^https?:\/\//.test(tab.url || '')) throw new Error('请在普通 HTTP/HTTPS 网页上使用；浏览器内置页和 PDF 不支持。');
    const { c, key } = await config(); validateConfig(c); if (!key) throw new Error('请先在设置中填写 API Key。');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    abort(tab.id); const j = { tabId: tab.id, token: crypto.randomUUID(), count: 0, active: true, documentId: null }; jobs.set(tab.id, j); await save(j);
    return chrome.tabs.sendMessage(tab.id, { type: 'START', token: j.token, scope: m.scope, style: { fontSize: c.fontSize, gap: c.gap, color: c.color, tint: c.tint } }, { frameId: 0 });
  }
  throw new Error('未知操作。');
}
chrome.runtime.onMessage.addListener((m, sender, respond) => { handle(m, sender).then(v => respond({ ok: true, ...v })).catch(e => respond({ ok: false, error: e.message || '操作失败。' })); return true; });
chrome.tabs.onRemoved.addListener(async id => { await ready; abort(id); jobs.delete(id); await chrome.storage.session.remove('job:' + id); });

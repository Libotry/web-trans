import { validateSourceURL } from './pdf-source.js';

// Memory-only handoffs. This module never downloads files or accesses API credentials.
export function createSourceSessions(api, { now = () => Date.now(), ttl = 120000, maxSessions = 20 } = {}) {
  const records = new Map(), intents = new Map(); let epoch = 0;
  const readerURL = () => api.runtime.getURL('pdf.html');
  const currentURL = tab => tab.pendingUrl || tab.url || '';
  const exact = (url, path) => url === api.runtime.getURL(path);
  function popup(sender) {
    if (sender.id !== api.runtime.id || !exact(sender.url, 'popup.html') || (sender.frameId !== undefined && sender.frameId !== 0)) throw new Error('仅允许扩展弹窗选择 PDF 来源。');
  }
  function reader(sender) {
    if (sender.id !== api.runtime.id || !exact(sender.url, 'pdf.html') || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || typeof sender.documentId !== 'string' || !sender.documentId) throw new Error('仅允许 PDF 阅读页主文档认领来源。');
  }
  function sweep() { for (const [id, r] of records) if (!r.ownerDocumentId && now() - r.createdAt >= ttl) records.delete(id); }
  function auth(m, sender) {
    reader(sender); sweep(); const r = records.get(sender.tab.id);
    if (!r || r.ownerDocumentId !== sender.documentId || r.sourceId !== m.sourceId || r.token !== m.token || r.sourceEpoch !== m.sourceEpoch) throw new Error('PDF 来源交接已失效，请从源文件重新打开或本地导入。');
    return r;
  }
  const describe = r => ({ available: true, sourceId: r.sourceId, token: r.token, sourceEpoch: r.sourceEpoch, ...r.info });
  async function handle(m, sender) {
    if (!m || typeof m.type !== 'string') throw new Error('来源消息无效。');
    // Neither a web page nor a reader can smuggle network headers or a model URL.
    for (const field of ['headers', 'key', 'apiKey', 'endpoint', 'cookies', 'authorization', 'model']) if (Object.hasOwn(m, field)) throw new Error('来源消息含有不允许的请求参数。');
    if (m.type === 'PDF_SOURCE_PREPARE') {
      popup(sender);
      if (!Number.isInteger(m.tabId) || typeof m.expectedURL !== 'string') throw new Error('来源标签页无效。');
      const intent = ++epoch; intents.set(m.tabId, intent); sweep();
      const assertIntent = () => { if (intents.get(m.tabId) !== intent) throw new Error('来源操作已被新的导航替代，请重新选择。'); };
      const active = await api.tabs.query({ active: true, currentWindow: true }); assertIntent();
      if (active.length !== 1 || active[0].id !== m.tabId) throw new Error('当前标签页已变化，请重新打开扩展弹窗。');
      let tab = await api.tabs.get(m.tabId); assertIntent();
      if (currentURL(tab) !== m.expectedURL) throw new Error('来源地址已变化，请重新打开扩展弹窗。');
      // Explicit paste is only accepted from the exact popup, never reader/content messages.
      const info = validateSourceURL(m.manual === true ? m.sourceURL : currentURL(tab));
      if (!await api.permissions.contains({ origins: [info.permissionOrigin] })) throw new Error('尚未授权该文件来源主机，请在弹窗中授权。');
      assertIntent(); tab = await api.tabs.get(m.tabId); assertIntent();
      if (currentURL(tab) !== m.expectedURL) throw new Error('来源地址已变化，请重新选择。');
      if (!records.has(m.tabId) && records.size >= maxSessions) throw new Error('同时打开的来源过多，请先关闭已有 PDF 阅读页。');
      const record = { sourceId: crypto.randomUUID(), token: crypto.randomUUID(), sourceEpoch: intent, info, originalURL: m.expectedURL, createdAt: now(), ownerDocumentId: null, navigating: true };
      records.set(m.tabId, record);
      try { await api.tabs.update(m.tabId, { url: readerURL() }); assertIntent(); }
      catch { if (records.get(m.tabId) === record) records.delete(m.tabId); throw new Error('来源导航已取消或失效，请重新选择。'); }
      // A fast reader is allowed to claim before tabs.update resolves.
      return { prepared: true, sourceEpoch: intent, displayHost: info.displayHost };
    }
    if (m.type === 'PDF_SOURCE_CLAIM') {
      reader(sender); sweep(); const r = records.get(sender.tab.id);
      if (!r) return { available: false };
      if (r.ownerDocumentId && r.ownerDocumentId !== sender.documentId) throw new Error('来源属于旧阅读页，请从源 PDF 重新打开。');
      const actual = await api.tabs.get(sender.tab.id);
      if (records.get(sender.tab.id) !== r || currentURL(actual) !== readerURL() || (r.ownerDocumentId && r.ownerDocumentId !== sender.documentId)) throw new Error('阅读页来源已失效。');
      r.ownerDocumentId = sender.documentId; r.navigating = false;
      return describe(r);
    }
    const r = auth(m, sender);
    if (m.type === 'PDF_SOURCE_STATUS') return { available: true, sourceId: r.sourceId, sourceEpoch: r.sourceEpoch, claimed: true };
    if (m.type === 'PDF_SOURCE_RELEASE') { records.delete(sender.tab.id); return { released: true }; }
    if (m.type === 'PDF_SOURCE_RETURN') {
      for (const field of ['url', 'sourceURL', 'fetchURL']) if (Object.hasOwn(m, field)) throw new Error('返回来源不接受自定义地址。');
      const tab = await api.tabs.get(sender.tab.id);
      if (records.get(sender.tab.id) !== r || currentURL(tab) !== readerURL()) throw new Error('阅读页已变化。');
      records.delete(sender.tab.id); intents.set(sender.tab.id, ++epoch);
      await api.tabs.update(sender.tab.id, { url: r.info.sourceURL });
      return { returned: true };
    }
    throw new Error('未知 PDF 来源操作。');
  }
  function removed(tabId) { records.delete(tabId); intents.delete(tabId); }
  function updated(tabId, change) {
    const r = records.get(tabId);
    if (!r) { if (change.url || change.status === 'loading') intents.delete(tabId); return; }
    if (change.url && change.url !== readerURL()) { records.delete(tabId); intents.delete(tabId); return; }
    // The one expected source→reader transition survives; a claimed reader reload does not.
    if (r.ownerDocumentId && change.status === 'loading') { records.delete(tabId); intents.delete(tabId); }
  }
  return { handle, removed, updated };
}

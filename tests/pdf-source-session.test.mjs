import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSessions } from '../extension/pdf-source-session.js';
function setup(options = {}) {
  let clock = 0, allowed = true, activeId = 1, getHook;
  const tabs = new Map([[1, { id: 1, url: 'https://example.test/paper.pdf?sig=private#page=2' }]]), navigations = [];
  const api = { runtime: { id: 'test', getURL: path => 'chrome-extension://test/' + path }, permissions: { async contains() { return allowed; } }, tabs: {
    async query() { return tabs.has(activeId) ? [tabs.get(activeId)] : []; },
    async get(id) { await getHook?.(); if (!tabs.has(id)) throw new Error('missing'); return { ...tabs.get(id) }; },
    async update(id, patch) { const tab = tabs.get(id); if (!tab) throw new Error('missing'); Object.assign(tab, patch); navigations.push({ id, ...patch }); return tab; }
  } };
  const manager = createSourceSessions(api, { now: () => clock, ...options });
  const popup = { id: 'test', url: 'chrome-extension://test/popup.html' }, reader = { id: 'test', url: 'chrome-extension://test/pdf.html', frameId: 0, documentId: 'reader-one', tab: { id: 1 } };
  const h = { tabs, navigations, popup, reader, manager, api,
    set allowed(v) { allowed = v; }, set activeId(v) { activeId = v; }, set clock(v) { clock = v; }, set getHook(v) { getHook = v; },
    prepare(extra = {}, sender = popup) { return manager.handle({ type: 'PDF_SOURCE_PREPARE', tabId: 1, expectedURL: tabs.get(1)?.url || '', ...extra }, sender); },
    claim(sender = reader) { return manager.handle({ type: 'PDF_SOURCE_CLAIM' }, sender); },
    control(type, source, extra = {}, sender = reader) { return manager.handle({ type, sourceId: source.sourceId, token: source.token, sourceEpoch: source.sourceEpoch, ...extra }, sender); }
  };
  return h;
}
test('source handoff uses exact popup, current active tab and preauthorized origin, with zero fetch', async () => {
  const h = setup();
  for (const sender of [{ ...h.popup, id: 'foreign' }, { ...h.popup, url: 'https://example.test/popup.html' }, { ...h.popup, url: 'chrome-extension://test/popup.html?x=1' }, { ...h.popup, frameId: 2 }, h.reader]) await assert.rejects(h.prepare({}, sender));
  h.allowed = false; await assert.rejects(h.prepare(), /授权/); assert.equal(h.navigations.length, 0);
  h.allowed = true; h.activeId = 2; await assert.rejects(h.prepare(), /标签页/); h.activeId = 1;
  await assert.rejects(h.prepare({ expectedURL: 'https://other.test/' }), /变化/);
  await h.prepare(); assert.equal(h.navigations[0].url, 'chrome-extension://test/pdf.html');
  const source = await h.claim(); assert.equal(source.available, true); assert.equal(source.initialPage, 2); assert.equal(source.fetchURL.includes('#'), false); assert.equal(source.displayHost.includes('private'), false);
});
test('reader claim is bound to exact extension page/tab/document, idempotent but not transferable', async () => {
  const h = setup(); assert.equal((await h.claim()).available, false); await h.prepare();
  for (const patch of [{ id: 'bad' }, { frameId: 1 }, { documentId: undefined }, { tab: undefined }, { url: 'chrome-extension://test/pdf.html#source' }, { url: 'chrome-extension://test/pdf.html?source=a' }]) await assert.rejects(h.claim({ ...h.reader, ...patch }));
  const source = await h.claim(); assert.deepEqual(await h.claim(), source);
  await assert.rejects(h.claim({ ...h.reader, documentId: 'reader-two' }), /旧阅读页/);
  for (const extra of [{ token: 'wrong' }, { sourceEpoch: 0 }, { sourceId: 'bad' }, { headers: {} }]) await assert.rejects(h.control('PDF_SOURCE_STATUS', source, extra));
  await assert.rejects(h.control('PDF_SOURCE_STATUS', source, {}, { ...h.reader, tab: { id: 2 } }));
});
test('TTL expires only unclaimed records; release, close, reload and off-reader navigation revoke', async () => {
  const h = setup({ ttl: 10 }); await h.prepare(); h.clock = 11; assert.equal((await h.claim()).available, false);
  h.tabs.get(1).url = 'https://example.test/a'; await h.prepare(); const source = await h.claim(); h.clock = 100;
  assert.equal((await h.control('PDF_SOURCE_STATUS', source)).claimed, true);
  h.manager.updated(1, { status: 'loading' }); await assert.rejects(h.control('PDF_SOURCE_STATUS', source));
  h.tabs.get(1).url = 'https://example.test/a'; await h.prepare(); const next = await h.claim(); await h.control('PDF_SOURCE_RELEASE', next); assert.equal((await h.claim()).available, false);
  h.tabs.get(1).url = 'https://example.test/a'; await h.prepare(); h.manager.updated(1, { url: 'https://elsewhere.test/' }); assert.equal((await h.claim()).available, false);
  h.tabs.get(1).url = 'https://example.test/a'; await h.prepare(); h.manager.removed(1); assert.equal((await h.claim()).available, false);
});
test('return only navigates to recorded validated URL and source capabilities cannot supply request headers', async () => {
  const h = setup(); await h.prepare(); const source = await h.claim();
  for (const extra of [{ url: 'https://bad.test/' }, { sourceURL: 'https://bad.test/' }, { fetchURL: 'https://bad.test/' }, { apiKey: 'bad' }]) await assert.rejects(h.control('PDF_SOURCE_RETURN', source, extra));
  await h.control('PDF_SOURCE_RETURN', source); assert.equal(h.tabs.get(1).url, 'https://example.test/paper.pdf?sig=private#page=2'); assert.equal((await h.claim()).available, false);
});
test('memory capacity does not evict active readers and manual fallback remains exact-popup-only', async () => {
  const h = setup({ maxSessions: 1 }); await h.prepare(); await h.claim();
  h.tabs.set(2, { id: 2, url: 'https://other.test/' }); h.activeId = 2;
  await assert.rejects(h.manager.handle({ type: 'PDF_SOURCE_PREPARE', tabId: 2, expectedURL: 'https://other.test/' }, h.popup), /过多/);
  h.manager.removed(1); h.activeId = 1; h.tabs.get(1).url = '';
  await h.prepare({ manual: true, sourceURL: 'https://example.test/no-pdf-extension?id=1' }); const source = await h.claim(); assert.equal(source.fetchURL, 'https://example.test/no-pdf-extension?id=1');
});
test('racing first claims cannot bind one handoff to two reader documents', async () => {
  const h = setup(); await h.prepare();
  const attempts = await Promise.allSettled([h.claim(), h.claim({ ...h.reader, documentId: 'racing-document' })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(r => r.status === 'rejected').length, 1);
});
test('a pending source URL is usable, but a changed pending navigation invalidates its snapshot', async () => {
  const h = setup(); delete h.tabs.get(1).url; h.tabs.get(1).pendingUrl = 'https://example.test/pending.pdf';
  const originalUpdate = h.api.tabs.update;
  h.api.tabs.update = async (...args) => { const result = await originalUpdate(...args); delete result.pendingUrl; return result; };
  await h.prepare({ expectedURL: 'https://example.test/pending.pdf' }); assert.equal((await h.claim()).fetchURL, 'https://example.test/pending.pdf');
  h.tabs.get(1).url = 'https://example.test/a.pdf'; h.tabs.get(1).pendingUrl = 'https://changed.test/b.pdf';
  await assert.rejects(h.prepare({ expectedURL: 'https://example.test/a.pdf' }), /变化/);
});
test('navigation/source mutations during async preparation cannot redirect a changed tab', async () => {
  const h = setup(); let count = 0;
  h.getHook = () => { if (++count === 2) h.tabs.get(1).url = 'https://changed.test/'; };
  await assert.rejects(h.prepare(), /变化/); assert.equal(h.navigations.length, 0);
});

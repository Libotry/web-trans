import test from 'node:test';
import assert from 'node:assert/strict';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let moduleId = 0;
async function setup({ limit = 100 } = {}) {
  const local = { config: { endpoint: 'https://api.example.test/v1/chat/completions', model: 'test', limit } }, session = { key: 'secret-test' };
  let listener, removed, maximum = 0, active = 0, webStart, writeFails = false;
  const requests = [], notices = [], tabs = new Map();
  const area = data => ({
    async setAccessLevel() {},
    async get(keys) { return keys === null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(values) { if (writeFails && Object.keys(values).some(k => k.startsWith('cache:'))) throw new Error('quota exceeded'); Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; }
  });
  const h = {
    local, session, requests, tabs,
    pdf: { id: 'test', url: 'chrome-extension://test/pdf.html', tab: { id: 10 }, frameId: 0, documentId: 'reader-document' },
    ui: { id: 'test', url: 'chrome-extension://test/options.html', tab: { id: 99 } },
    page: { id: 'test', tab: { id: 1 }, frameId: 0, documentId: 'web-document' },
    handler: async request => response(request.segments),
    get maximum() { return maximum; },
    set writeFails(value) { writeFails = value; },
    async reload() { await import('../extension/background.js?pdf-test=' + ++moduleId); },
    send(m, sender = h.pdf) { return new Promise(resolve => listener(m, sender, resolve)); },
    async start(documentId = 'file-one', sender = h.pdf, extra = {}) { return h.send({ type: 'PDF_START', documentId, ...extra }, sender); },
    auth(j) { return Object.fromEntries(['documentId', 'taskId', 'token', 'generation'].map(k => [k, j[k]])); },
    translate(j, text, extra = {}, sender = h.pdf) { return h.send({ type: 'PDF_TRANSLATE', ...h.auth(j), pageNumber: 1, segments: [{ id: 'p1b1c1', text }], ...extra }, sender); },
    control(type, j, extra = {}, sender = h.pdf) { return h.send({ type, ...h.auth(j), ...extra }, sender); },
    async waitCalls(count) { if (requests.length < count) await new Promise(resolve => notices.push({ count, resolve })); },
    async close(id) { tabs.delete(id); await removed(id); },
    async webTask() { await h.send({ type: 'START', tabId: 1 }, h.ui); return webStart.token; }
  };
  tabs.set(10, { id: 10, url: h.pdf.url }); tabs.set(1, { id: 1, url: 'https://example.test/article' });
  globalThis.chrome = {
    storage: { local: area(local), session: area(session) }, permissions: { async contains() { return true; } },
    runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { async get(id) { if (!tabs.has(id)) throw new Error('missing tab'); return tabs.get(id); }, async sendMessage(id, m) { webStart = m; return {}; }, onRemoved: { addListener(fn) { removed = fn; } } },
    scripting: { async executeScript() {} }
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, local.config.endpoint); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + (session.key || local.key));
    const request = { url, options, segments: JSON.parse(JSON.parse(options.body).messages[1].content).segments };
    requests.push(request); active++; maximum = Math.max(maximum, active);
    try {
      const result = h.handler(request);
      for (const n of notices.splice(0)) { if (requests.length >= n.count) n.resolve(); else notices.push(n); }
      return await result;
    } finally { active--; }
  };
  await h.reload(); return h;
}
function response(segments, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: segments.toReversed().map(s => ({ id: s.id, text: '中文：' + s.text })) }) } }], usage: { total_tokens: 7 } }), { status });
}
function hold(h, { respectAbort = false } = {}) {
  const gates = [];
  h.handler = async r => {
    const gate = deferred(); gates.push(gate);
    if (respectAbort) r.options.signal.addEventListener('abort', () => gate.reject(new DOMException('aborted', 'AbortError')), { once: true });
    await gate.promise; return response(r.segments);
  };
  return gates;
}

test('PDF requires exact main-frame extension reader and full task identity', async () => {
  const h = await setup();
  for (const patch of [
    { id: 'foreign' }, { frameId: 1 }, { frameId: undefined }, { documentId: undefined }, { tab: undefined },
    { url: 'https://example.test/pdf.html' }, { url: 'chrome-extension://test/pdf.html/evil' },
    { url: 'chrome-extension://other/pdf.html' }, { url: 'chrome-extension://test/options.html' },
    { url: 'chrome-extension://test/pdf.html?fake=1' }
  ]) assert.equal((await h.start('file-one', { ...h.pdf, ...patch })).ok, false);
  for (const documentId of ['', '../path', 'x'.repeat(101), null]) assert.equal((await h.start(documentId)).ok, false);
  const j = await h.start(); assert.equal(j.ok, true); assert.equal(j.generation, 1); assert.equal(j.limit, 100);
  assert.ok(!JSON.stringify(j).includes('secret-test'));
  for (const patch of [{ token: 'wrong' }, { taskId: 'wrong' }, { generation: 0 }, { documentId: 'wrong' }]) assert.equal((await h.translate(j, 'Denied', patch)).ok, false);
  for (const patch of [{ tab: { id: 11 } }, { documentId: 'another-reader' }, { frameId: 1 }, { id: 'foreign' }]) assert.equal((await h.translate(j, 'Denied', {}, { ...h.pdf, ...patch })).ok, false);
  for (const field of ['endpoint', 'key', 'apiKey', 'headers', 'model', 'config']) assert.equal((await h.translate(j, 'Denied', { [field]: 'forged' })).ok, false);
  assert.equal(h.requests.length, 0);
  const r = await h.translate(j, 'Hello PDF'); assert.equal(r.ok, true); assert.equal(r.translations[0].text, '中文：Hello PDF'); assert.equal(r.pageNumber, 1); assert.equal(r.taskId, j.taskId); assert.equal(r.generation, j.generation);
});

test('PDF validates batch and page boundaries before calling API', async () => {
  const h = await setup(), j = await h.start();
  for (const segments of [null, [], [null], [{ id: '', text: 'x' }], [{ id: 'x', text: '' }], [{ id: 'x', text: 'a'.repeat(2001) }], [{ id: 'x'.repeat(101), text: 'text' }], [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }], Array.from({ length: 7 }, (_, i) => ({ id: '' + i, text: 'text' })), Array.from({ length: 4 }, (_, i) => ({ id: '' + i, text: 'a'.repeat(2000) }))]) assert.equal((await h.translate(j, 'ignored', { segments })).ok, false);
  for (const pageNumber of [0, -1, 501, 1.5, '1', 2]) assert.equal((await h.translate(j, 'Wrong page', { pageNumber })).ok, false);
  assert.equal(h.requests.length, 0);
});

test('PDF cumulative allowance survives cancel/restart and document switching; cache is shared with web', async () => {
  const h = await setup({ limit: 1 }), j = await h.start();
  assert.equal((await h.translate(j, 'Shared original')).cached, false);
  const cached = await h.translate(j, 'Shared original', { segments: [{ id: 'other-id', text: 'Shared original' }] });
  assert.equal(cached.cached, true); assert.equal(cached.translations[0].id, 'other-id'); assert.equal(h.requests.length, 1);
  assert.equal((await h.translate(j, 'Over limit')).limit, true);
  await h.control('PDF_CANCEL', j);
  assert.equal((await h.translate(j, 'Stopped')).ok, false);
  assert.equal((await h.control('PDF_STATUS', j)).active, false);
  const again = await h.start(); assert.equal(again.count, 1); assert.equal(again.limit, 1); assert.equal(again.generation, 2); assert.notEqual(again.token, j.token);
  assert.equal((await h.translate(j, 'Stale')).ok, false);
  const extended = await h.control('PDF_EXTEND', again); assert.equal(extended.count, 1); assert.equal(extended.limit, 2);
  assert.equal((await h.translate(again, 'After extension')).ok, true);
  const other = await h.start('file-two'); assert.equal(other.count, 0);
  const back = await h.start(); assert.equal(back.count, 2); assert.equal(back.limit, 2);
  assert.equal((await h.translate(other, 'Old document')).ok, false);
  const token = await h.webTask();
  const web = await h.send({ type: 'TRANSLATE', token, segments: [{ id: 'web', text: 'Shared original' }] }, h.page);
  assert.equal(web.cached, true); assert.equal(h.requests.length, 2);
});

test('web and PDF share two slots; PDF pause cancels queued work without dispatch', async () => {
  const h = await setup(), gates = hold(h), token = await h.webTask();
  const web = text => h.send({ type: 'TRANSLATE', token, segments: [{ id: 'web', text }] }, h.page);
  const a = web('Web first'), b = web('Web second'); await h.waitCalls(2);
  const j = await h.start(), queued = h.translate(j, 'PDF queued');
  // STATUS is ordered after queue registration without timing-dependent sleeps.
  await h.control('PDF_STATUS', j); await h.control('PDF_PAUSE', j, { paused: true });
  assert.equal((await queued).ok, false); assert.equal(h.requests.length, 2);
  gates[0].resolve(); gates[1].resolve(); assert.equal((await a).ok, true); assert.equal((await b).ok, true);
  await h.control('PDF_PAUSE', j, { paused: false, pageNumber: 2 });
  const c = h.translate(j, 'PDF page two', { pageNumber: 2 }); await h.waitCalls(3); gates[2].resolve();
  assert.equal((await c).ok, true); assert.equal(h.maximum, 2); assert.equal((await h.control('PDF_STATUS', j)).count, 1);
});

test('page changes allow in-flight old-page results but invalidate queued old-page batches', async () => {
  const h = await setup(), gates = hold(h), j = await h.start();
  const first = h.translate(j, 'First page A'), second = h.translate(j, 'First page B'); await h.waitCalls(2);
  const queued = h.translate(j, 'First page queued');
  await h.control('PDF_STATUS', j); await h.control('PDF_PAUSE', j, { paused: false, pageNumber: 2 });
  assert.equal((await queued).ok, false); gates[0].resolve(); gates[1].resolve();
  assert.equal((await first).pageNumber, 1); assert.equal((await second).pageNumber, 1); assert.equal(h.requests.length, 2);
  const next = h.translate(j, 'Second page', { pageNumber: 2 }); await h.waitCalls(3); gates[2].resolve(); assert.equal((await next).pageNumber, 2);
});

test('stop aborts requests and rejects late responses without leaking slots or resetting usage', async () => {
  const h = await setup(), gates = hold(h), j = await h.start();
  const inFlight = h.translate(j, 'Will arrive late'); await h.waitCalls(1);
  await h.control('PDF_CANCEL', j); assert.equal(h.requests[0].options.signal.aborted, true);
  const restarted = await h.start(); assert.equal(restarted.count, 1);
  gates[0].resolve(); assert.equal((await inFlight).ok, false);
  h.handler = async r => response(r.segments);
  assert.equal((await h.translate(restarted, 'Fresh task')).ok, true);
  assert.equal((await h.control('PDF_STATUS', restarted)).count, 2);
});

test('configuration fingerprint includes credentials; display-only changes do not invalidate', async () => {
  const h = await setup(), j = await h.start();
  h.local.config.fontSize = 120; assert.equal((await h.translate(j, 'Display change')).ok, true);
  const gates = hold(h), pending = h.translate(j, 'Old key request'); await h.waitCalls(2);
  h.session.key = 'replacement-secret'; gates[0].resolve();
  const rejected = await pending; assert.equal(rejected.ok, false); assert.match(rejected.error, /配置已变化/);
  assert.equal((await h.control('PDF_STATUS', j)).configChanged, true);
  assert.equal((await h.translate(j, 'New key without restart')).ok, false);
  const renewed = await h.start(); assert.notEqual(renewed.configFingerprint, j.configFingerprint); assert.equal(renewed.count, 2);
  h.handler = async r => response(r.segments); assert.equal((await h.translate(renewed, 'New key with restart')).ok, true);
  h.local.config.model = 'new-model'; assert.equal((await h.control('PDF_STATUS', renewed)).configChanged, true);
  assert.equal((await h.translate(renewed, 'Wrong model')).ok, false);
  const metadata = Object.entries(h.session).filter(([k]) => k.startsWith('pdfJob:')).map(([, v]) => v);
  assert.ok(!JSON.stringify(metadata).includes('replacement-secret')); assert.ok(!JSON.stringify(metadata).includes('Old key request'));
});

test('worker restart retains counters and ownership, and closed tabs are removed', async () => {
  const h = await setup(), j = await h.start(); await h.translate(j, 'Before restart');
  await h.reload(); const status = await h.control('PDF_STATUS', j); assert.equal(status.ok, true); assert.equal(status.count, 1);
  assert.equal((await h.control('PDF_STATUS', j, {}, { ...h.pdf, documentId: 'new-reader' })).ok, false);
  await h.control('PDF_CANCEL', j); await h.reload(); const again = await h.start(); assert.equal(again.count, 1);
  await h.close(10); assert.equal((await h.control('PDF_STATUS', again)).ok, false);
  assert.equal(Object.keys(h.session).some(k => k.startsWith('pdfJob:')), false);
});

test('cache quota failure does not discard translations and cache size is bounded', async () => {
  const h = await setup(), j = await h.start(); h.writeFails = true;
  assert.equal((await h.translate(j, 'Cache failure')).ok, true); h.writeFails = false;
  for (let i = 0; i < 155; i++) h.session['cache:old-' + i] = ['x'.repeat(20000)];
  assert.equal((await h.translate(j, 'Evict huge cache')).ok, true);
  const entries = Object.entries(h.session).filter(([k]) => k.startsWith('cache:'));
  assert.ok(entries.length <= 150); assert.ok(entries.reduce((n, [k, v]) => n + (k.length + JSON.stringify(v).length) * 2, 0) <= 4 * 1024 * 1024);
});

test('PDF bounds queued batches and cancel rejects them while other slots remain occupied', async () => {
  const h = await setup(), gates = hold(h), token = await h.webTask();
  const web = text => h.send({ type: 'TRANSLATE', token, segments: [{ id: 'web', text }] }, h.page);
  const a = web('Occupy one'), b = web('Occupy two'); await h.waitCalls(2);
  const j = await h.start(), one = h.translate(j, 'Queue one'), two = h.translate(j, 'Queue two');
  const three = await h.translate(j, 'Queue three'); assert.equal(three.ok, false); assert.match(three.error, /批次过多/);
  await h.control('PDF_CANCEL', j); assert.equal((await one).ok, false); assert.equal((await two).ok, false);
  assert.equal(h.requests.length, 2); assert.equal((await h.control('PDF_STATUS', j)).count, 0);
  gates[0].resolve(); gates[1].resolve(); await Promise.all([a, b]);
});

test('saving changed API credentials pauses/aborts PDF task; display settings do not', async () => {
  const h = await setup(), j = await h.start(), gates = hold(h, { respectAbort: true });
  const pending = h.translate(j, 'Abort on configuration update'); await h.waitCalls(1);
  const config = { ...h.local.config, fontSize: 110 };
  assert.equal((await h.send({ type: 'SAVE_CONFIG', config, key: '' }, h.ui)).ok, true);
  assert.equal(h.requests[0].options.signal.aborted, false);
  assert.equal((await h.send({ type: 'SAVE_CONFIG', config, key: 'new-key' }, h.ui)).ok, true);
  assert.equal(h.requests[0].options.signal.aborted, true); assert.equal((await pending).ok, false);
  const status = await h.control('PDF_STATUS', j); assert.equal(status.paused, true); assert.equal(status.configChanged, true);
  assert.ok(gates.length === 1); assert.equal(h.requests.length, 1);
  const again = await h.start(); assert.equal(again.count, 1);
  await h.send({ type: 'FORGET_KEY' }, h.ui); assert.equal((await h.control('PDF_STATUS', again)).configChanged, true);
});

test('restart prunes missing or navigated tabs and reader reload cannot inherit old identity', async () => {
  const h = await setup(), j = await h.start(); await h.translate(j, 'Owner one');
  const reloadedSender = { ...h.pdf, documentId: 'replacement-document' };
  const next = await h.start('file-one', reloadedSender); assert.equal(next.count, 0); assert.notEqual(next.taskId, j.taskId);
  assert.equal((await h.control('PDF_STATUS', j)).ok, false);
  h.tabs.set(10, { id: 10, url: 'https://elsewhere.test/' }); await h.reload();
  assert.equal((await h.control('PDF_STATUS', next, {}, reloadedSender)).ok, false);
  assert.equal(Object.keys(h.session).some(k => k.startsWith('pdfJob:')), false);
});

test('reader retains at most ten document ledgers and preserves the current allowance', async () => {
  const h = await setup({ limit: 3 }), first = await h.start('file-0');
  for (let i = 1; i < 11; i++) await h.start('file-' + i);
  assert.equal(Object.keys(h.session).filter(k => k.startsWith('pdfJob:')).length, 10);
  assert.equal((await h.control('PDF_STATUS', first)).ok, false);
  const current = await h.start('file-10'); await h.translate(current, 'Current ledger text'); await h.control('PDF_CANCEL', current);
  const restarted = await h.start('file-10'); assert.equal(restarted.count, 1); assert.equal(restarted.limit, 3);
});

test('PDF start races serialize and every obsolete generation is rejected', async () => {
  const h = await setup();
  const starts = await Promise.all([h.start(), h.start(), h.start()]);
  assert.deepEqual(starts.map(j => j.generation), [1, 2, 3]);
  assert.equal(starts[0].taskId, starts[2].taskId);
  for (const j of starts.slice(0, 2)) assert.equal((await h.translate(j, 'Obsolete generation')).ok, false);
  assert.equal((await h.translate(starts[2], 'Current generation')).ok, true);
});

test('fatal errors block document, nonfatal errors never automatically retry', async () => {
  const h = await setup(), j = await h.start(); h.handler = async r => response(r.segments, 401);
  assert.equal((await h.translate(j, 'Auth fails')).ok, false); const before = h.requests.length;
  assert.equal((await h.translate(j, 'Blocked')).ok, false); assert.equal(h.requests.length, before);
  await h.control('PDF_EXTEND', j); assert.equal((await h.translate(j, 'Still blocked')).ok, false);
  const again = await h.start(); h.handler = async r => response(r.segments, 429);
  assert.equal((await h.translate(again, 'Rate limit')).ok, false); assert.equal(h.requests.length, before + 1);
  h.handler = async () => new Response('not JSON'); assert.equal((await h.translate(again, 'Bad JSON')).ok, false); assert.equal(h.requests.length, before + 2);
});

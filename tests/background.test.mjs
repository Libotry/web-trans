import test from 'node:test';
import assert from 'node:assert/strict';
const local = {}, session = {}; let listener, start, active = 0, maximum = 0, calls = 0, status = 200;
const area = data => ({ async setAccessLevel() {}, async get(keys) { return keys === null ? { ...data } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; } });
globalThis.chrome = {
  storage: { local: area(local), session: area(session) }, permissions: { async contains() { return true; } },
  runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener(fn) { listener = fn; } } },
  tabs: { async get(id) { return { id, url: 'https://example.test/article' }; }, async sendMessage(id, m) { start = m; return {}; }, onRemoved: { addListener() {} } },
  scripting: { async executeScript() {} }
};
globalThis.fetch = async (url, options) => {
  calls++; active++; maximum = Math.max(active, maximum);
  assert.equal(url, 'https://api.example.test/v1/chat/completions'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer secret-test');
  await new Promise(r => setTimeout(r, 25)); active--;
  const segments = JSON.parse(JSON.parse(options.body).messages[1].content).segments;
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: segments.toReversed().map(s => ({ id: s.id, text: '中文：' + s.text })) }) } }], usage: { total_tokens: 20 } }), { status });
};
await import('../extension/background.js');
const ui = { id: 'test', url: 'chrome-extension://test/options.html', tab: { id: 99 } };
const page = { id: 'test', frameId: 0, documentId: 'doc1', tab: { id: 1 } };
const send = (m, sender = ui) => new Promise(resolve => listener(m, sender, resolve));
test('background authorization, secrecy, cache, concurrency, quotas and fatal errors', async () => {
  let r = await send({ type: 'SAVE_CONFIG', config: { endpoint: 'https://api.example.test/v1/chat/completions', model: 'test', limit: 5 }, key: 'secret-test' }); assert.equal(r.ok, true);
  assert.equal(local.key, undefined); assert.equal(session.key, 'secret-test');
  r = await send({ type: 'GET_CONFIG' }); assert.equal(r.hasKey, true); assert.ok(!JSON.stringify(r).includes('secret-test'));
  assert.equal((await send({ type: 'GET_CONFIG' }, page)).ok, false);
  await send({ type: 'START', tabId: 1 }); const token = start.token;
  const translate = (text, sender = page, extra = {}) => send({ type: 'TRANSLATE', token, segments: [{ id: 'x', text }], ...extra }, sender);
  assert.equal((await translate('Wrong frame', { ...page, frameId: 2 })).ok, false);
  assert.equal((await translate('Wrong token', page, { token: 'forged' })).ok, false);
  r = await translate('Hello world'); assert.equal(r.translations[0].text, '中文：Hello world'); assert.equal(r.tokens, 20);
  r = await translate('Hello world'); assert.equal(r.cached, true); assert.equal(calls, 1);
  assert.equal((await translate('Different document', { ...page, documentId: 'doc2' })).ok, false);
  const results = await Promise.all(['Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map(t => translate(t)));
  assert.ok(results.some(r => r.limit)); assert.equal(calls, 5); assert.equal(maximum, 2);
  await send({ type: 'EXTEND', token }, page); status = 401;
  assert.equal((await translate('Authentication failure')).ok, false); const before = calls;
  assert.equal((await translate('Blocked')).ok, false); assert.equal(calls, before);
  await send({ type: 'CANCEL', token }, page); assert.equal((await translate('Cancelled')).ok, false);
  await send({ type: 'FORGET_KEY' }); assert.equal((await send({ type: 'GET_CONFIG' })).hasKey, false);
});

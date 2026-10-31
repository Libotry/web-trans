import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceURL, downloadPDF, MAX_PDF_BYTES } from '../extension/pdf-source.js';
const bytes = new TextEncoder().encode('%PDF-1.4\nMinimal parser fixture\n%%EOF\n');
const response = (data = bytes, headers = {}) => new Response(data, { status: 200, headers: { 'Content-Type': 'application/pdf', ...headers } });
test('source URL accepts explicit public HTTPS, keeps signed query private and only safe page fragment', () => {
  const r = validateSourceURL('https://example.test/paper.pdf?signature=secret#page=12');
  assert.equal(r.fetchURL, 'https://example.test/paper.pdf?signature=secret'); assert.equal(r.initialPage, 12); assert.equal(r.permissionOrigin, 'https://example.test/*'); assert.equal(r.displayHost, 'example.test');
  assert.equal(validateSourceURL('https://example.test:8443/a').permissionOrigin, 'https://example.test/*');
  assert.equal(validateSourceURL('https://example.test/download?id=1#evil=secret').sourceURL, 'https://example.test/download?id=1');
  assert.equal(validateSourceURL('https://example.test/download#page=501').initialPage, 1);
});
test('source URL rejects credentials, non-HTTPS, local/private literal variants and mapped IPv6', () => {
  for (const u of ['file:///a.pdf', 'http://example.test/a.pdf', 'blob:https://example.test/a', 'data:application/pdf,abc', 'https://user:pass@example.test/a', 'https://localhost/a', 'https://a.localhost/a', 'https://localhost./a', 'https://127.1/a', 'https://2130706433/a', 'https://0x7f000001/a', 'https://10.0.0.1/a', 'https://192.168.1.1/a', 'https://172.16.0.1/a', 'https://100.64.1.1/a', 'https://169.254.1.1/a', 'https://[::1]/a', 'https://[::ffff:7f00:1]/a']) assert.throws(() => validateSourceURL(u), u);
});
test('download uses GET, omit credentials, no API headers, redirect error and reports bytes', async () => {
  let options, url, progress;
  const r = await downloadPDF('https://example.test/paper.pdf?token=secret#page=2', { fetchImpl: async (u, o) => { url = u; options = o; return response(); }, onProgress: p => progress = p });
  assert.equal(url, 'https://example.test/paper.pdf?token=secret'); assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers, undefined); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(progress.received, bytes.length); assert.deepEqual(r.data, bytes); assert.equal(r.initialPage, 2);
});
test('download validates status, type, magic/EOF, expected length and declared/actual limits', async () => {
  for (const r of [new Response(bytes, { status: 206 }), new Response('login', { headers: { 'Content-Type': 'text/html' } }), response(new TextEncoder().encode('not a PDF')), response(new TextEncoder().encode('%PDF-1.4 truncated')), response(bytes, { 'Content-Length': '' + (bytes.length + 2) }), response(bytes, { 'Content-Length': '' + (MAX_PDF_BYTES + 1) })]) await assert.rejects(downloadPDF('https://example.test/a', { fetchImpl: async () => r }));
  await assert.rejects(downloadPDF('https://example.test/a', { fetchImpl: async () => response(), maxBytes: 8 }), /文件超过/);
  const r = await downloadPDF('https://example.test/a', { fetchImpl: async () => response(bytes, { 'Content-Type': 'application/octet-stream' }) }); assert.equal(r.data.length, bytes.length);
});
test('unknown length streams are bounded and external abort/idle/overall timeouts settle safely', async () => {
  await assert.rejects(downloadPDF('https://example.test/a', { fetchImpl: async () => response(new ReadableStream({ start(c) { c.enqueue(bytes); c.enqueue(bytes); c.close(); } })), maxBytes: bytes.length }), /超过/);
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(downloadPDF('https://example.test/a', { signal: controller.signal, fetchImpl: async () => { called = true; return response(); } }), /取消/); assert.equal(called, false);
  await assert.rejects(downloadPDF('https://example.test/a', { fetchImpl: async () => response(new ReadableStream({ start() {} })), idleTimeoutMs: 10 }), /没有返回数据/);
  await assert.rejects(downloadPDF('https://example.test/a', { fetchImpl: async () => new Promise(() => {}), totalTimeoutMs: 10 }), /超时/);
});
test('concurrent download for one source is rejected and cancellation releases the source lock', async () => {
  const controller = new AbortController(); let started;
  const ready = new Promise(resolve => started = resolve);
  const first = downloadPDF('https://example.test/concurrent', { signal: controller.signal, fetchImpl: async () => { started(); return response(new ReadableStream({ start() {} })); } });
  await ready;
  await assert.rejects(downloadPDF('https://example.test/concurrent', { fetchImpl: async () => response() }), /正在读取/);
  controller.abort(); await assert.rejects(first, /取消/);
  assert.equal((await downloadPDF('https://example.test/concurrent', { fetchImpl: async () => response() })).data.length, bytes.length);
});
test('network failures never reveal signed URLs or arbitrary upstream error text', async () => {
  await assert.rejects(downloadPDF('https://example.test/a?signature=secret', { fetchImpl: async () => { throw new Error('文件 https://example.test/a?signature=secret'); } }), e => !e.message.includes('secret'));
});

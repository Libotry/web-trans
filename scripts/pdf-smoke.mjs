// Real Chrome + unpacked extension + real local PDF.js/Worker. Only model
// responses are mocked; no personal Chrome profile or real API Key is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Self-generated, copyright-free PDF with correct byte offsets and base font.
// Deliberately no document scripts, network resources, embedded fonts or images.
function makePDF() {
  const streams = [
    'BT /F1 18 Tf 50 740 Td (First PDF page) Tj /F1 12 Tf 0 -40 Td (Reading English documents helps us learn.) Tj 0 -36 Td (This paragraph belongs only to the first page.) Tj ET',
    'BT /F1 18 Tf 50 740 Td (Second PDF page) Tj /F1 12 Tf 0 -40 Td (The second page is translated only on demand.) Tj 0 -36 Td (No page is uploaded as an entire document.) Tj ET'
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let body = '%PDF-1.4\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}
const fixture = fileURLToPath(new URL('../tests/fixtures/pdf/two-page-text.pdf', import.meta.url));
await mkdir(fileURLToPath(new URL('../tests/fixtures/pdf/', import.meta.url)), { recursive: true });
await writeFile(fixture, makePDF());
if (process.argv.includes('--fixture-only')) { console.log('Generated', fixture); process.exit(0); }
const profile = await mkdtemp(join(tmpdir(), 'web-trans-pdf-smoke-'));
// Ignore stdio instead of capturing Chromium output: Windows confined named
// pipes otherwise prevent launch. Read Chrome's own DevToolsActivePort file.
const proc = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--enable-unsafe-extension-debugging',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, page, worker, browserPort, spawnError;
proc.once('error', error => { spawnError = error; });
const sockets = [];
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); sockets.push(ws);
    const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 10000);
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      clearTimeout(timer); let sequence = 0; const pending = new Map(), listeners = new Map();
      ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method) for (const listener of listeners.get(message.method) || []) listener(message.params);
        if (!message.id) return;
        const waiter = pending.get(message.id); if (!waiter) return;
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
      });
      resolve({ on(method, listener) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(listener); }, call(method, params = {}, sessionId) { return new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
        pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }); } });
    });
  });
}
async function evaluate(client, expression) {
  const r = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
}
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await delay(100); }
  throw new Error('Timeout: ' + label + (last ? ': ' + last.message : ''));
}
async function targets() { return (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json(); }
const ui = expression => evaluate(page, expression);
const bg = expression => evaluate(worker, expression);
const calls = () => bg('globalThis.pdfSmokeCalls.length');
const click = id => ui(`document.getElementById(${JSON.stringify(id)}).click()`);
const pageReady = n => until(() => ui(`document.querySelector('#pageNumber').value===${JSON.stringify(String(n))} && document.querySelector('#status').textContent.includes('本地解析') && document.querySelectorAll('#blocks .source').length>0`), 'page ' + n + ' preview');
const translated = () => until(() => ui(`document.querySelectorAll('#blocks .translation').length>0 && [...document.querySelectorAll('#blocks .translation')].every(n=>n.textContent.startsWith('中文测试译文'))`), 'translated chunks');
try {
  const debugging = await until(async () => { if (spawnError) throw spawnError; try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; } }, 'Chrome startup');
  const [port, route] = debugging.trim().split(/\r?\n/); browserPort = port;
  socket = await connect(`ws://127.0.0.1:${port}${route}`);
  const loaded = await socket.call('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../extension/', import.meta.url)) });
  const created = await socket.call('Target.createTarget', { url: `chrome-extension://${loaded.id}/pdf.html` });
  const target = await until(async () => (await targets()).find(t => t.id === created.targetId), 'reader target');
  page = await connect(target.webSocketDebuggerUrl);
  await until(() => ui(`document.querySelector('#file') && document.querySelector('#status')!==null`), 'reader DOM');
  const readerErrors = []; let parserSession;
  page.on('Target.attachedToTarget', event => { if (event.targetInfo.type === 'worker') parserSession = event.sessionId; });
  await page.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  page.on('Runtime.exceptionThrown', event => readerErrors.push(event.exceptionDetails?.text || JSON.stringify(event)));
  page.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') readerErrors.push(entry.text); });
  await page.call('Runtime.enable'); await page.call('Log.enable');
  // Starting the trusted config message wakes the actual extension worker.
  const initial = await ui(`chrome.runtime.sendMessage({type:'GET_CONFIG'})`); assert.equal(initial.ok, true);
  const workerTarget = await until(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.includes(loaded.id)), 'worker target');
  worker = await connect(workerTarget.webSocketDebuggerUrl);
  await bg(`globalThis.pdfSmokeCalls=[];globalThis.pdfSmokeDelay=0;chrome.permissions.contains=async()=>true;globalThis.fetch=async(url,options)=>{
    const segments=JSON.parse(JSON.parse(options.body).messages[1].content).segments;
    globalThis.pdfSmokeCalls.push(segments);
    if(globalThis.pdfSmokeDelay)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,globalThis.pdfSmokeDelay);options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({translations:segments.map(s=>({id:s.id,text:'中文测试译文：'+s.text}))})}}],usage:{total_tokens:15}}),{status:200});
  };`);
  await page.call('DOM.enable'); const root = await page.call('DOM.getDocument');
  const fileNode = await page.call('DOM.querySelector', { nodeId: root.root.nodeId, selector: '#file' });
  await page.call('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [fixture] });
  await pageReady(1);
  assert.equal(await calls(), 0, 'local preview must not call API');
  assert.match(await ui(`document.querySelector('#blocks').textContent`), /Reading English documents/);
  assert.equal(await ui(`document.querySelector('#canvas').width>1`), true, 'real PDF.js canvas rendered');
  const actualTargets = await socket.call('Target.getTargets', { filter: [{ type: 'worker', exclude: false }, { exclude: true }] });
  const pdfWorkerTarget = actualTargets.targetInfos.find(t => t.type === 'worker' && (t.parentId === created.targetId || t.parentFrameId === created.targetId || t.url.startsWith(`chrome-extension://${loaded.id}/`)));
  assert.ok(pdfWorkerTarget, 'reader must own a real dedicated Worker: ' + JSON.stringify(actualTargets.targetInfos));
  // Chrome may leave TargetInfo.url empty for extension dedicated workers.
  // Attach to that worker and inspect its own execution context instead.
  await until(() => parserSession, 'reader-owned parser debug session');
  await page.call('Runtime.enable', {}, parserSession);
  const location = await page.call('Runtime.evaluate', { expression: 'self.location.href', returnByValue: true }, parserSession);
  assert.equal(location.exceptionDetails, undefined);
  assert.ok(location.result.value.startsWith(`chrome-extension://${loaded.id}/`) && location.result.value.includes('pdf.worker'), 'PDF Worker must run local bundled code: ' + location.result.value);
  console.log('Actual local PDF Worker:', location.result.value);
  console.log('PASS: real local PDF.js Worker, two-page file import, rendered canvas and zero-API preview.');
  const saved = await ui(`chrome.runtime.sendMessage({type:'SAVE_CONFIG',config:{endpoint:'https://mock.example.test/v1/chat/completions',model:'pdf-smoke',limit:10},key:'mock-not-real'})`);
  assert.equal(saved.ok, true);
  await bg('pdfSmokeDelay=600');
  await click('translate'); await until(async () => (await calls()) === 1, 'first page in-flight request');
  await click('next'); await pageReady(2); await delay(900);
  assert.equal(await calls(), 1, 'old-page completion must not auto-dispatch page 2');
  assert.ok((await bg('pdfSmokeCalls.flat().every(s=>!s.text.includes("Second PDF")&&!s.text.includes("second page"))')));
  assert.match(await ui(`document.querySelector('#blocks').textContent`), /等待翻译/);
  await click('prev'); await pageReady(1); await translated();
  await click('next'); await pageReady(2);
  assert.equal(await calls(), 1, 'page 2 must not auto-translate by default');
  await bg('pdfSmokeDelay=0');
  await click('translate'); await translated(); assert.equal(await calls(), 2);
  await ui(`document.querySelector('#zoom').value='1.25';document.querySelector('#zoom').dispatchEvent(new Event('change'))`);
  await pageReady(2); await translated(); await click('prev'); await pageReady(1); await translated();
  assert.equal(await calls(), 2, 'zoom and back navigation must reuse completed results');
  console.log('PASS: current-page translation, no next-page prefetch, on-demand second page, zoom/back reuse.');
  await ui(`window.confirm=()=>true`); await click('stop');
  await until(() => ui(`document.querySelector('#status').textContent.includes('任务已停止')`), 'stop completion');
  assert.match(await ui(`document.querySelector('#stats').textContent`), /请求 2 \/ 10/);
  await click('clear'); await until(() => ui(`document.querySelector('#status').textContent.includes('已清除')`), 'clear completion');
  assert.match(await ui(`document.querySelector('#stats').textContent`), /请求 2 \/ 10/);
  await click('translate'); await translated(); assert.equal(await calls(), 2, 'cached repeat should not call model');
  await click('clear'); await until(() => ui(`document.querySelector('#status').textContent.includes('已清除')`), 'second clear');
  await ui(`chrome.runtime.sendMessage({type:'CLEAR_CACHE'})`); await bg('pdfSmokeDelay=5000');
  await click('translate'); await until(async () => (await calls()) === 3, 'in-flight third model request');
  await click('stop'); await until(() => ui(`document.querySelector('#status').textContent.includes('任务已停止')`), 'in-flight cancellation');
  assert.match(await ui(`document.querySelector('#stats').textContent`), /请求 3 \/ 10/, 'cancelled in-flight request remains counted');
  await click('clear'); await until(() => ui(`document.querySelector('#status').textContent.includes('已清除')`), 'post-cancel clear');
  assert.match(await ui(`document.querySelector('#stats').textContent`), /请求 3 \/ 10/);
  await delay(300); assert.equal(await calls(), 3, 'cancel/clear cannot dispatch additional requests');
  assert.match(await ui(`document.querySelector('#blocks').textContent`), /等待翻译/);
  console.log('PASS: stop/clear preserve cumulative count, cache avoids model calls, cancellation counts sent requests.');
  // Delay only the START reply, not the real background registration. This exposes
  // user controls racing an asynchronous handshake without mocking reader code.
  await ui(`globalThis.originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);globalThis.startPending=false;
    chrome.runtime.sendMessage=async message=>{const result=await originalSend(message);if(message.type==='PDF_START'){startPending=true;await new Promise(r=>setTimeout(r,700));startPending=false;}return result;};`);
  await click('translate'); await until(() => ui('startPending'), 'delayed start');
  await click('stop'); await delay(1100);
  assert.equal(await calls(), 3, 'stop during START must invalidate the pending start before any paid request');
  await click('next'); await pageReady(2);
  assert.match(await ui(`document.querySelector('#blocks').textContent`), /等待翻译/, 'stopped documents still allow local page reading');
  await click('translate'); await until(() => ui('startPending'), 'second delayed start');
  await click('prev'); await pageReady(1); await delay(1100);
  assert.equal(await calls(), 3, 'page change during START must not translate the newly selected page');
  await ui('chrome.runtime.sendMessage=originalSend');
  console.log('PASS: stop/page change during delayed START cannot dispatch new-page or stopped requests.');
  await bg('pdfSmokeDelay=0'); await click('translate'); await translated();
  const beforeConfig = await calls();
  const changed = await ui(`chrome.runtime.sendMessage({type:'SAVE_CONFIG',config:{endpoint:'https://mock.example.test/v1/chat/completions',model:'pdf-smoke-changed',limit:10},key:'mock-not-real'})`);
  assert.equal(changed.ok, true);
  await click('translate'); await until(async () => (await calls()) > beforeConfig, 'new model must replace old displayed translation'); await translated();
  assert.equal(await calls(), beforeConfig + 1, 'restarting a completed page after config change must not reuse old-model results');
  const beforeAuto = await calls();
  await ui(`document.querySelector('#auto').checked=true;globalThis.pausePending=false;
    chrome.runtime.sendMessage=async message=>{const result=await originalSend(message);if(message.type==='PDF_PAUSE'){pausePending=true;await new Promise(r=>setTimeout(r,700));pausePending=false;}return result;};`);
  await click('next'); await until(() => ui('pausePending'), 'page load delayed control reply');
  await click('stop'); await delay(1300);
  assert.equal(await calls(), beforeAuto, 'stop during page load must not create a later automatic-translation timer');
  await ui('chrome.runtime.sendMessage=originalSend');
  console.log('PASS: model change replaces old results; stop during page loading defeats automatic translation.');
  assert.equal(readerErrors.length, 0, JSON.stringify(readerErrors));
  console.log('PASS: PDF real-extension smoke complete (mock model only).');
} catch (error) {
  if (page) console.error('Reader failure snapshot:', await ui(`({status:document.querySelector('#status')?.textContent,warning:document.querySelector('#warning')?.textContent,stats:document.querySelector('#stats')?.textContent,text:document.querySelector('#blocks')?.textContent})`).catch(() => null));
  throw error;
} finally {
  if (socket) await socket.call('Browser.close').catch(() => {});
  for (const ws of sockets) ws.close(); proc.kill();
}

// Real native-PDF tab -> exact popup -> same-tab extension reader -> real HTTPS PDF.
// A temporary extension copy pregrants ONLY the W3C test host. Production manifest
// is unchanged; this validates routing/download, NOT the optional-permission dialog.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const sourceURL = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';
const temporary = await mkdtemp(join(tmpdir(), 'web-trans-source-smoke-'));
const extensionPath = join(temporary, 'extension');
await cp(fileURLToPath(new URL('../extension/', import.meta.url)), extensionPath, { recursive: true });
const manifestPath = join(extensionPath, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (process.argv.includes('--with-tabs-experiment')) manifest.permissions = [...manifest.permissions, 'tabs'];
manifest.host_permissions = ['https://www.w3.org/*'];
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const profile = join(temporary, 'profile');
const processHandle = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let startupError, port, browser, popup, reader, worker;
const downloadDiagnostics = [], sourceRequestIds = new Set();
processHandle.once('error', error => startupError = error);
const sockets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) { const end = Date.now() + timeout; let last; while (Date.now() < end) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await delay(100); } throw new Error('Timeout: ' + label + (last ? ': ' + last.message : '')); }
function connect(url) { return new Promise((resolve, reject) => {
  const ws = new WebSocket(url); sockets.push(ws); ws.addEventListener('error', reject);
  ws.addEventListener('open', () => { let sequence = 0; const pending = new Map(), listeners = new Map();
    ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method) for (const fn of listeners.get(m.method) || []) fn(m.params); if (!m.id) return; const task = pending.get(m.id); if (!task) return; pending.delete(m.id); clearTimeout(task.timer); if (m.error) task.reject(new Error(JSON.stringify(m.error))); else task.resolve(m.result); });
    resolve({ on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })); }); } });
  });
}); }
async function evaluate(client, expression) { const r = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
try {
  const endpoint = await until(async () => { if (startupError) throw startupError; try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return false; } }, 'Chrome startup');
  const [debugPort, route] = endpoint.trim().split(/\r?\n/); port = debugPort; browser = await connect(`ws://127.0.0.1:${port}${route}`);
  const loaded = await browser.call('Extensions.loadUnpacked', { path: extensionPath });
  console.log('Test-only W3C host pregrant; production optional-permission UI is NOT tested.');
  const created = await browser.call('Target.createTarget', { url: sourceURL });
  const nativeTarget = await until(async () => (await targets()).find(t => t.id === created.targetId && t.url === sourceURL), 'native PDF tab');
  reader = await connect(nativeTarget.webSocketDebuggerUrl);
  const navigation = await reader.call('Page.navigate', { url: sourceURL });
  console.log('Native PDF navigation result:', navigation);
  await until(() => evaluate(reader, `document.readyState==='complete'`), 'native PDF document readiness', 45000);
  console.log('Native document snapshot (pending PDF navigations may still show about:blank):', await evaluate(reader, `({url:location.href,ready:document.readyState})`));
  await reader.call('Network.enable');
  const sourceRequests = [], runtimeErrors = [];
  reader.on('Network.requestWillBeSent', e => { if (e.request.url === sourceURL) { sourceRequests.push(e.request); sourceRequestIds.add(e.requestId); } });
  reader.on('Network.loadingFailed', e => { if (sourceRequestIds.has(e.requestId)) downloadDiagnostics.push({ error: e.errorText, blockedReason: e.blockedReason, corsError: e.corsErrorStatus }); });
  reader.on('Network.responseReceived', e => { if (sourceRequestIds.has(e.requestId)) downloadDiagnostics.push({ status: e.response.status, mimeType: e.response.mimeType }); });
  reader.on('Runtime.exceptionThrown', e => runtimeErrors.push(e.exceptionDetails?.text || 'runtime exception'));
  await reader.call('Runtime.enable');
  const infos = await browser.call('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const tab = infos.targetInfos.find(t => t.url === sourceURL);
  await browser.call('Extensions.triggerAction', { id: loaded.id, targetId: tab?.targetId || created.targetId });
  let popupTarget = await until(async () => (await targets()).find(t => t.url === `chrome-extension://${loaded.id}/popup.html`), 'real extension popup');
  popup = await connect(popupTarget.webSocketDebuggerUrl);
  const activeTab = await evaluate(popup, `chrome.tabs.query({active:true,currentWindow:true}).then(t=>t.map(x=>({id:x.id,url:x.url,pendingUrl:x.pendingUrl,active:x.active})))`);
  console.log('Actual popup active tab snapshot:', activeTab);
  if (!activeTab[0]?.url && !activeTab[0]?.pendingUrl) {
    console.log('LIMITATION: this Chrome native PDF tab exposes neither URL nor pending URL; exercising explicit popup paste fallback, without broad tabs permission.');
    await evaluate(popup, `document.querySelector('#sourceURL').value=${JSON.stringify(sourceURL)};document.querySelector('#sourceURL').dispatchEvent(new Event('input'));true`);
  }
  await until(() => evaluate(popup, `document.querySelector('#sourceHint')?.textContent.includes('www.w3.org') && !document.querySelector('#pdfSource').disabled`), 'popup explicit source selection');
  console.log('Popup source selection:', await evaluate(popup, `document.querySelector('#sourceHint').textContent`));
  const workerTarget = await until(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.includes(loaded.id)), 'extension background');
  worker = await connect(workerTarget.webSocketDebuggerUrl);
  await evaluate(worker, `globalThis.sourceSmokeAPICalls=0;const originalFetch=globalThis.fetch;globalThis.fetch=(...args)=>{sourceSmokeAPICalls++;return originalFetch(...args);};`);
  // Use the actual popup button. PREPARE is not forged from a reader or options page.
  await evaluate(popup, `document.querySelector('#pdfSource').click();true`);
  await until(async () => (await targets()).some(t => t.id === created.targetId && t.url === `chrome-extension://${loaded.id}/pdf.html`), 'same tab reader navigation');
  const readerTarget = (await targets()).find(t => t.id === created.targetId);
  reader = await connect(readerTarget.webSocketDebuggerUrl);
  await until(() => evaluate(reader, `document.querySelector('#canvas')?.width>1 && document.querySelectorAll('#blocks .source').length>0`), 'actual remote PDF local preview', 70000);
  const snapshot = await evaluate(reader, `({url:location.href,text:document.querySelector('#blocks').textContent,status:document.querySelector('#status').textContent})`);
  assert.equal(new URL(snapshot.url).search, ''); assert.equal(new URL(snapshot.url).hash, ''); assert.match(snapshot.text, /Dummy PDF file/i);
  assert.equal(await evaluate(worker, 'sourceSmokeAPICalls'), 0, 'source preview must not call the model API');
  assert.ok(sourceRequests.some(r => r.method === 'GET'), 'reader fetched the actual public HTTPS PDF');
  for (const req of sourceRequests) assert.equal(Object.keys(req.headers).some(k => /^(authorization|cookie)$/i.test(k)), false);
  assert.equal(runtimeErrors.length, 0, JSON.stringify(runtimeErrors));
  console.log('PASS: real popup source selection, permission/preparation, same-tab handoff, actual W3C GET, canvas/text preview, zero model calls.');
  await evaluate(reader, `document.querySelector('#returnSource').click();true`);
  await until(async () => (await targets()).some(t => t.id === created.targetId && t.url === sourceURL), 'return to recorded native PDF source');
  console.log('PASS: return source restores the recorded original URL in the same tab.');
} catch (error) {
  console.error('Public test PDF network diagnostics:', downloadDiagnostics);
  if (popup) console.error('Popup state:', await evaluate(popup, `({hint:document.querySelector('#sourceHint')?.textContent,status:document.querySelector('#status')?.textContent})`).catch(() => null));
  if (reader) console.error('Reader state:', await evaluate(reader, `({url:location.href,status:document.querySelector('#status')?.textContent,source:document.querySelector('#sourceStatus')?.textContent})`).catch(() => null));
  throw error;
} finally {
  if (browser) await browser.call('Browser.close').catch(() => {});
  for (const ws of sockets) ws.close(); processHandle.kill();
}

const $ = id => document.getElementById(id); let tabId, polling = false;
async function request(m) { const r = await chrome.runtime.sendMessage(m); if (!r?.ok) throw new Error(r?.error || '操作失败'); return r; }
function render(r) {
  $('stats').textContent = r.active ? `已翻译 ${r.done} 段 · 待处理 ${r.pending} 段 · 失败 ${r.failed} 段\n请求 ${r.requests} 次 · 缓存命中 ${r.hits} 个片段${r.tokens === null ? '' : ' · 已知用量 ' + r.tokens + ' tokens'}` : '尚未开始翻译';
  $('pause').textContent = r.paused ? '继续' : '暂停'; $('hide').textContent = r.hidden ? '显示译文' : '隐藏译文';
  $('extend').hidden = !r.limited;
  for (const id of ['pause', 'hide', 'restore', 'retry']) $(id).disabled = !r.active;
  if (r.message) { $('status').textContent = r.message; $('status').className = 'status error'; }
}
async function update() {
  if (polling || !tabId) return; polling = true;
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'STATUS' }, { frameId: 0 }); if (r?.ok) render(r); }
  catch { render({ active: false }); } finally { polling = false; }
}
async function act(fn) { $('status').textContent = ''; try { await fn(); await update(); } catch (e) { $('status').textContent = e.message; $('status').className = 'status error'; } }
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('pdf').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('pdf.html') });
$('start').onclick = () => act(async () => { $('start').disabled = true; try { await request({ type: 'START', tabId, scope: $('scope').value }); } finally { $('start').disabled = false; } });
for (const action of ['pause', 'hide', 'restore', 'retry', 'extend']) $(action).onclick = () => act(async () => {
  const r = await chrome.tabs.sendMessage(tabId, { type: 'CONTROL', action }, { frameId: 0 }); if (!r?.ok) throw new Error(r?.error || '操作失败'); render(r);
});
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id;
  const r = await request({ type: 'GET_CONFIG' }); $('model').textContent = r.config.model ? `模型：${r.config.model}${r.hasKey ? '' : '（请补充 API Key）'}` : '请先打开设置，配置 API 地址、模型和 Key。';
  await update(); setInterval(update, 1000);
} catch (e) { $('status').textContent = e.message; }

import { validateConfig } from './core.js';
const $ = id => document.getElementById(id); const fields = ['endpoint', 'model', 'remember', 'jsonMode', 'timeout', 'limit', 'fontSize', 'gap', 'color', 'tint'];
async function request(m) { const r = await chrome.runtime.sendMessage(m); if (!r?.ok) throw new Error(r?.error || '操作失败'); return r; }
function notice(text, error = false) { $('status').textContent = text; $('status').className = 'status ' + (error ? 'error' : 'success'); }
async function save(test) {
  if (!$('form').reportValidity()) return;
  try {
    const c = validateConfig(Object.fromEntries(fields.map(k => [k, $(k).type === 'checkbox' ? $(k).checked : $(k).value])));
    // Request permission directly within the click gesture, before asynchronous storage calls.
    const granted = await chrome.permissions.request({ origins: [new URL(c.endpoint).origin + '/*'] });
    if (!granted) throw new Error('未获得 API 域名权限，配置未保存。');
    await request({ type: 'SAVE_CONFIG', config: c, key: $('key').value.trim() }); $('key').value = '';
    $('keyHint').textContent = 'Key 已保存。留空将保留当前 Key。';
    notice(test ? '配置已保存，正在测试…' : '配置已保存，可以返回英文网页开始翻译。');
    if (test) { const r = await request({ type: 'TEST' }); const t = r.translations?.[0]?.text; if (!t) throw new Error('连接成功，但模型没有返回有效的对应译文。'); notice('连接成功：' + t); }
  } catch (e) { notice(e.message, true); }
}
$('form').onsubmit = e => { e.preventDefault(); save(false); };
$('test').onclick = () => save(true);
$('clear').onclick = async () => { try { await request({ type: 'CLEAR_CACHE' }); notice('翻译缓存已清除。'); } catch (e) { notice(e.message, true); } };
$('forget').onclick = async () => { try { await request({ type: 'FORGET_KEY' }); $('key').value = ''; $('keyHint').textContent = 'Key 已删除，请重新填写。'; notice('已删除 Key。'); } catch (e) { notice(e.message, true); } };
try { const r = await request({ type: 'GET_CONFIG' }); for (const k of fields) if ($(k).type === 'checkbox') $(k).checked = !!r.config[k]; else $(k).value = r.config[k]; if (r.hasKey) $('keyHint').textContent = '已有 Key，留空可保留；填写新值会替换。'; }
catch (e) { notice(e.message, true); }

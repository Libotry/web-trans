// Public HTTPS PDF sources only. No cookies, API credentials, redirects or URL proxy.
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const activeDownloads = new Set();
const knownErrors = new WeakSet();
function sourceError(message) { const error = new Error(message); knownErrors.add(error); return error; }
export function validateSourceURL(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 16384) throw sourceError('请输入有效的 HTTPS PDF 地址。');
  let u; try { u = new URL(input); } catch { throw sourceError('请输入有效的 HTTPS PDF 地址。'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw sourceError('来源只支持不含账号密码的 HTTPS 地址；请保存后导入其他文件。');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  // IPv6 literals are conservatively unsupported, including mapped IPv4 forms.
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.startsWith('[')) throw sourceError('不支持本机、局域网或 IPv6 字面量来源，请保存后导入。');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))) throw sourceError('不支持本机或私有网络地址，请保存后导入。');
  }
  const match = u.hash.match(/^#page=(\d+)$/i); const parsed = match ? Number(match[1]) : 1;
  const initialPage = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 500 ? parsed : 1;
  u.hash = match && initialPage === parsed ? 'page=' + initialPage : '';
  const sourceURL = u.href; u.hash = '';
  let name; try { name = decodeURIComponent(u.pathname.split('/').pop() || 'document.pdf'); } catch { name = 'document.pdf'; }
  const filename = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 180);
  return { sourceURL, fetchURL: u.href, origin: u.origin, permissionOrigin: 'https://' + u.hostname + '/*', displayHost: u.host, filename: /\.pdf$/i.test(filename) ? filename : 'document.pdf', initialPage };
}
export async function downloadPDF(source, { signal, onProgress, fetchImpl = globalThis.fetch, maxBytes = MAX_PDF_BYTES, totalTimeoutMs = 60000, idleTimeoutMs = 15000 } = {}) {
  const info = validateSourceURL(typeof source === 'string' ? source : source?.sourceURL);
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(MAX_PDF_BYTES, maxBytes) : MAX_PDF_BYTES, controller = new AbortController();
  let reader, totalTimer, idleTimer, failure;
  if (signal?.aborted) throw sourceError('文件读取已取消。');
  if (activeDownloads.has(info.fetchURL)) throw sourceError('来源正在读取，请先取消当前读取再重试。');
  activeDownloads.add(info.fetchURL);
  const abort = message => { if (!failure) failure = sourceError(message); controller.abort(); };
  const externalAbort = () => abort('文件读取已取消。');
  if (signal?.aborted) externalAbort(); else signal?.addEventListener('abort', externalAbort, { once: true });
  const aborted = new Promise((_, reject) => {
    const rejectAbort = () => reject(failure || new Error('文件读取已取消。'));
    if (controller.signal.aborted) rejectAbort(); else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => abort('文件来源长时间没有返回数据，请手动重试或本地导入。'), Math.min(15000, Math.max(1, idleTimeoutMs))); };
  totalTimer = setTimeout(() => abort('文件读取超时，请手动重试或本地导入。'), Math.min(60000, Math.max(1, totalTimeoutMs))); resetIdle();
  try {
    const response = await Promise.race([fetchImpl(info.fetchURL, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal }), aborted]);
    if (response.status !== 200 || response.redirected || ['opaque', 'opaqueredirect'].includes(response.type)) throw sourceError('无法完整读取来源 PDF（HTTP ' + response.status + '）；登录、重定向或临时链接请保存后导入。');
    const type = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (type && !['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(type)) throw sourceError('来源返回的不是 PDF 文件，可能为登录页面，请保存后导入。');
    const rawLength = response.headers.get('Content-Length');
    const expected = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected > cap)) throw sourceError('文件超过允许大小（最大 50 MiB）。');
    if (!response.body?.getReader) throw sourceError('来源没有可读取的文件内容。');
    reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]); if (done) break;
      if (!(value instanceof Uint8Array)) throw sourceError('文件流无效。');
      if (!value.byteLength) continue;
      size += value.byteLength; if (size > cap) { abort('文件超过允许大小（最大 50 MiB）。'); throw failure; }
      chunks.push(value); resetIdle(); onProgress?.({ received: size, total: expected });
    }
    if (!size) throw sourceError('来源文件为空。');
    const encoding = response.headers.get('Content-Encoding');
    if (expected !== null && (!encoding || encoding === 'identity') && size !== expected) throw sourceError('文件传输不完整，请手动重试或本地导入。');
    const data = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
    const tail = new TextDecoder('latin1').decode(data.subarray(Math.max(0, size - 2048)));
    if (!head.includes('%PDF-') || !tail.includes('%%EOF')) throw sourceError('来源不是完整 PDF，可能已截断或返回其他内容，请保存后导入。');
    return { ...info, data };
  } catch (error) {
    controller.abort();
    // Browser network exceptions often contain a signed URL. Never forward them.
    if (failure) throw failure;
    if (knownErrors.has(error)) throw error;
    throw sourceError('无法读取 PDF 来源，请检查权限、网络或重定向，或保存后本地导入。');
  } finally {
    activeDownloads.delete(info.fetchURL);
    clearTimeout(totalTimer); clearTimeout(idleTimer); signal?.removeEventListener('abort', externalAbort);
    if (reader) { try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} }
  }
}

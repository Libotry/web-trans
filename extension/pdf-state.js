// Small, testable queue/state helpers. All IDs remain below the background's 100-character limit.
export function pageState(number, extraction) {
  return { number, ...extraction, blocks: extraction.blocks.map((b, bi) => ({ ...b, id: `p${number}b${bi}`, chunks: b.chunks.map((c, ci) => ({ id: `p${number}b${bi}c${ci}`, text: c.text, state: 'pending', translation: '', error: '' })) })) };
}
export function chunksOf(page) { return page?.blocks.flatMap(b => b.chunks) || []; }
export function nextBatch(page) {
  const batch = []; let length = 0;
  for (const chunk of chunksOf(page)) {
    if (chunk.state !== 'pending') continue;
    if (batch.length >= 6 || length + chunk.text.length > 6500) break;
    batch.push(chunk); length += chunk.text.length;
  }
  return batch;
}
export function applyResult(batch, result) {
  const found = new Map((result.translations || []).map(t => [t.id, t.text]));
  for (const chunk of batch) {
    const text = found.get(chunk.id);
    chunk.state = typeof text === 'string' && text.trim() ? 'done' : 'failed';
    chunk.translation = chunk.state === 'done' ? text : '';
    chunk.error = chunk.state === 'failed' ? '未返回有效译文，可手动重试。' : '';
  }
}
export function textBytes(pages) {
  let bytes = 0;
  for (const page of pages.values()) for (const block of page.blocks) {
    bytes += block.text.length * 2;
    for (const chunk of block.chunks) bytes += (chunk.text.length + chunk.translation.length) * 2;
  }
  return bytes;
}

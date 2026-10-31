// PDF DOM overlays. Source rectangles and all overrides use scale=1 top-left
// page coordinates; nothing in this module fetches data or changes PDF state.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const median = values => { const a = [...values].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const area = r => r.width * r.height;
function intersection(a, b) { return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)); }
export function validRect(r, width, height) {
  return !!r && [r.x, r.y, r.width, r.height, width, height].every(finite) && width > 0 && height > 0 && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= width + 0.01 && r.y + r.height <= height + 0.01;
}
export function clampBox(box, width, height) {
  if (![box?.x, box?.y, box?.width, box?.height, width, height].every(finite) || width <= 0 || height <= 0) throw new TypeError('Invalid overlay box or page size.');
  const w = Math.min(width, Math.max(Math.min(24, width), box.width));
  const h = Math.min(height, Math.max(Math.min(16, height), box.height));
  return { x: Math.min(width - w, Math.max(0, box.x)), y: Math.min(height - h, Math.max(0, box.y)), width: w, height: h };
}
export function adjustBox(box, dx, dy, width, height, resize = false) {
  if (![dx, dy].every(finite)) throw new TypeError('Invalid movement.');
  return clampBox(resize ? { ...box, width: box.width + dx, height: box.height + dy } : { ...box, x: box.x + dx, y: box.y + dy }, width, height);
}
export function blockLayout(block, width, height) {
  const rects = block?.rects;
  if (!Array.isArray(rects) || !rects.length || rects.length > 5000 || rects.some(r => !validRect(r, width, height))) return { reason: '文字坐标无效，保留原文；请使用段落列表。' };
  if ((Array.isArray(block.layoutRisk) && block.layoutRisk.length) || (Array.isArray(block.warnings) && block.warnings.length)) return { reason: '段落版面有风险，保留原文；请使用段落列表。' };
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width)), bottom = Math.max(...rects.map(r => r.y + r.height));
  const bounds = { x, y, width: right - x, height: bottom - y };
  if (area(bounds) > width * height * 0.45 || rects.some(r => r.height > height * 0.15)) return { reason: '段落范围异常，保留原文；请使用段落列表。' };
  // Detect a block spanning an obvious inter-column gap on the same text row.
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    if (Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.4 && b.x - a.x - a.width > width * 0.08) return { reason: '疑似跨栏段落，保留原文；请使用段落列表。' };
  }
  const fontSize = Math.min(32, Math.max(8, finite(block.fontSize) && block.fontSize > 0 ? block.fontSize : median(rects.map(r => r.height))));
  return { rects: rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })), box: clampBox(bounds, width, height), fontSize };
}
export function planOverlays(page, width, height) {
  if (![width, height].every(finite) || width <= 0 || height <= 0) throw new TypeError('Invalid page dimensions.');
  const entries = [], reasons = [];
  const blocks = page?.blocks || [];
  const tooManyRects = blocks.length > 1000 || blocks.reduce((n, b) => n + (b.rects?.length || 0), 0) > 5000;
  const pageRisk = (page?.warnings || []).some(w => /跨栏|重叠|阅读顺序|非横排|混合旋转|坐标无效/.test(String(w)));
  for (const block of page?.blocks || []) {
    if (!Array.isArray(block.chunks) || !block.chunks.length || !block.chunks.every(c => c.state === 'done' && typeof c.translation === 'string' && c.translation.trim())) continue;
    const layout = blockLayout(block, width, height);
    const reason = tooManyRects ? '本页覆盖层区域过多，请使用段落列表。' : pageRisk ? '本页阅读顺序或版面不可靠，请使用段落列表。' : layout.reason;
    if (reason) { reasons.push({ blockId: block.id, reason }); continue; }
    entries.push({ block, ...layout, translation: block.chunks.map(c => c.translation).join('\n') });
  }
  // Never mask rectangles belonging to a different block. Disqualify both.
  const unsafe = new Set();
  for (let i = 0; i < entries.length; i++) for (const other of blocks) {
    if (other === entries[i].block || !Array.isArray(other.rects)) continue;
    if (entries[i].rects.some(a => other.rects.some(b => validRect(b, width, height) && intersection(a, b) > Math.min(area(a), area(b)) * 0.15))) { unsafe.add(i); break; }
  }
  for (const i of unsafe) reasons.push({ blockId: entries[i].block.id, reason: '段落文字区域重叠，保留原文；请使用段落列表。' });
  return { entries: entries.filter((_, i) => !unsafe.has(i)), reasons };
}
const CSS = `
.pdf-overlay-root{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:2}
.pdf-overlay-root .pdf-source-mask{position:absolute;background:white;pointer-events:none;z-index:0}
.pdf-overlay-root .pdf-translation-box{position:absolute;pointer-events:auto;box-sizing:border-box;color:#172033;background:transparent;outline:1px solid transparent;z-index:1}
.pdf-overlay-root .pdf-translation-box:focus-within,.pdf-overlay-root .pdf-translation-box:hover{outline-color:#648ac4}
.pdf-overlay-root .pdf-overlay-text{white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere;line-height:1.35;height:100%;width:100%;margin:0;padding:1px;box-sizing:border-box;user-select:text}
.pdf-overlay-root .pdf-overlay-tools{position:absolute;right:0;bottom:100%;display:flex;gap:2px;max-width:100%;opacity:0;pointer-events:none;background:#fff;border:1px solid #b8cbe3;border-radius:4px;z-index:5}
.pdf-overlay-root .pdf-translation-box:focus-within .pdf-overlay-tools,.pdf-overlay-root .pdf-translation-box:hover .pdf-overlay-tools{opacity:1;pointer-events:auto}
.pdf-overlay-root button{font:12px/1.3 system-ui;cursor:pointer;padding:2px 4px;color:#24476e;background:#fff;border:1px solid #b8cbe3;border-radius:3px}
.pdf-overlay-root .pdf-overflow-button{position:absolute;right:0;bottom:0;background:#eaf2ff;font-size:11px}
.pdf-overlay-root .pdf-move-handle{cursor:move;touch-action:none}.pdf-overlay-root .pdf-resize-handle{cursor:nwse-resize;touch-action:none}
.pdf-overlay-root .pdf-overlay-fallback{position:absolute;pointer-events:auto;z-index:6;left:0;top:0;max-width:90%;background:#fff4da;color:#754611;font:12px/1.4 system-ui;padding:4px}
.pdf-overlay-dialog{max-width:min(760px,90vw);max-height:85vh;overflow:auto;border:1px solid #b8cbe3;border-radius:10px;padding:22px;color:#172033;background:#fff;font:15px/1.7 system-ui}
.pdf-overlay-dialog::backdrop{background:#16263b88}.pdf-overlay-dialog p{white-space:pre-wrap;overflow-wrap:anywhere}.pdf-overlay-dialog button{font:inherit;padding:6px 12px}.pdf-overlay-dialog h2{font-size:18px}
`;
export function createOverlay({ host, onNotice = () => {} } = {}) {
  if (!host?.ownerDocument || typeof host.append !== 'function') throw new TypeError('An overlay host element is required.');
  const document = host.ownerDocument, window = document.defaultView;
  const overrides = new Map(); let active, destroyed = false, frame, drawer, dragCleanup, lastSignature, lastResult;
  const signature = ({ page, width, height, scale = 1, fontScale = 1, mask = true }) => JSON.stringify([
    page?.documentId, page?.number ?? page?.pageNumber ?? 1, page?.extractionVersion || 1, page?.warnings,
    (page?.blocks || []).map(b => [b.id, b.text, b.rects, b.fontSize, b.layoutRisk, b.warnings, b.chunks?.map(c => [c.state, c.translation])]),
    width, height, scale, fontScale, mask, [...overrides]
  ]);
  const element = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const root = element('div', 'pdf-overlay-root'); root.setAttribute('aria-label', 'PDF 页内译文');
  const style = element('style', '', CSS); host.append(style, root);
  const prefix = page => `${page.documentId || ''}:${page.number ?? page.pageNumber ?? 1}:${page.extractionVersion || 1}:`;
  const keyFor = (page, block) => prefix(page) + block.id;
  function closeDrawer() { if (drawer) { if (drawer.open && drawer.close) drawer.close(); drawer.remove(); drawer = null; } }
  function openDrawer(block, translation) {
    closeDrawer(); drawer = element('dialog', 'pdf-overlay-dialog');
    drawer.setAttribute('aria-label', '完整原文与译文');
    const close = element('button', '', '关闭'); close.type = 'button'; close.onclick = closeDrawer;
    drawer.append(element('h2', '', '英文原文'), element('p', '', block.text || ''), element('h2', '', '完整中文译文'), element('p', '', translation), close);
    drawer.addEventListener('cancel', e => { e.preventDefault(); closeDrawer(); });
    document.body.append(drawer);
    if (typeof drawer.showModal === 'function') drawer.showModal(); else drawer.setAttribute('open', '');
    close.focus();
  }
  function cancelFrame() { if (frame !== undefined) window?.cancelAnimationFrame?.(frame); frame = undefined; }
  function clear() { lastSignature = undefined; cancelFrame(); dragCleanup?.(); dragCleanup = null; closeDrawer(); root.replaceChildren(); }
  function render(args) {
    if (destroyed) throw new Error('Overlay was destroyed.');
    const { page, width, height, scale = 1, fontScale = 1, mask = true } = args;
    if (!finite(scale) || scale <= 0 || scale > 20 || !finite(fontScale) || fontScale < 0.5 || fontScale > 2 || typeof mask !== 'boolean') throw new TypeError('Invalid overlay display options.');
    const nextSignature = signature(args);
    if (nextSignature === lastSignature) { active = { page, width, height, scale, fontScale, mask }; return lastResult; }
    const plan = planOverlays(page, width, height); active = { page, width, height, scale, fontScale, mask };
    clear(); root.style.width = width * scale + 'px'; root.style.height = height * scale + 'px';
    const measure = []; let covered = 0;
    const position = (node, r) => Object.assign(node.style, { left: r.x * scale + 'px', top: r.y * scale + 'px', width: r.width * scale + 'px', height: r.height * scale + 'px' });
    for (const entry of plan.entries) {
      const { block, rects, fontSize, translation } = entry, key = keyFor(page, block);
      const state = overrides.get(key) || {}; if (state.hidden) continue;
      const masks = (mask ? rects : []).map(r => {
        const mask = element('div', 'pdf-source-mask'); mask.setAttribute('aria-hidden', 'true');
        // Small inset reduces accidental masking outside approximate glyph rows.
        const inset = Math.min(0.15, r.width / 4, r.height / 4);
        position(mask, { x: r.x + inset, y: r.y + inset, width: r.width - inset * 2, height: r.height - inset * 2 }); root.append(mask); return mask;
      });
      let box = clampBox(state.box || entry.box, width, height);
      const card = element('section', 'pdf-translation-box'); card.dataset.blockId = block.id; card.setAttribute('aria-label', '译文段落'); card.tabIndex = 0;
      const text = element('p', 'pdf-overlay-text', translation); text.lang = 'zh-Hans'; text.style.fontSize = fontSize * scale * fontScale + 'px';
      const tools = element('div', 'pdf-overlay-tools'); tools.setAttribute('role', 'toolbar'); tools.setAttribute('aria-label', '译文段落操作');
      const button = (label, title, action, className = '') => { const b = element('button', className, label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); if (action) b.onclick = action; tools.append(b); return b; };
      button('原文/全文', '展开完整原文和译文', () => openDrawer(block, translation));
      button('隐藏', '隐藏本段译文并恢复原文', () => { overrides.set(key, { ...state, box, hidden: true }); render(active); });
      const move = button('移动', '拖动移动；方向键移动，Shift 加速', null, 'pdf-move-handle');
      const resize = button('大小', '拖动调整大小；方向键调整宽高，Shift 加速', null, 'pdf-resize-handle');
      const overflow = element('button', 'pdf-overflow-button', '展开全文'); overflow.type = 'button'; overflow.hidden = true; overflow.onclick = () => openDrawer(block, translation);
      function layout() { position(card, box); tools.style.top = box.y * scale < 28 ? '0' : 'auto'; tools.style.bottom = box.y * scale < 28 ? 'auto' : '100%'; }
      function saveBox() { overrides.set(key, { ...state, box: { ...box }, hidden: false }); lastSignature = signature(active); }
      function measureOverflow() { overflow.hidden = !(text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1); card.dataset.overflow = String(!overflow.hidden); }
      function keyboard(event, resizing) {
        const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, delta = moves[event.key]; if (!delta) return;
        event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1;
        box = adjustBox(box, delta[0] * step, delta[1] * step, width, height, resizing); saveBox(); layout(); measureOverflow();
      }
      move.addEventListener('keydown', e => keyboard(e, false)); resize.addEventListener('keydown', e => keyboard(e, true));
      function drag(event, resizing) {
        if (event.button !== 0) return; event.preventDefault(); dragCleanup?.();
        const start = { ...box }, x = event.clientX, y = event.clientY, pointerId = event.pointerId;
        const update = e => { if (e.pointerId !== pointerId) return; box = adjustBox(start, (e.clientX - x) / scale, (e.clientY - y) / scale, width, height, resizing); saveBox(); layout(); measureOverflow(); };
        const finish = e => { if (e && e.pointerId !== pointerId) return; window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); dragCleanup = null; };
        window.addEventListener('pointermove', update); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish); dragCleanup = finish;
      }
      move.addEventListener('pointerdown', e => drag(e, false)); resize.addEventListener('pointerdown', e => drag(e, true));
      card.append(text, tools, overflow); root.append(card); layout(); measure.push(measureOverflow); covered++;
      // Masks intentionally have no reference to box: dragging/resizing only changes the card.
      void masks;
    }
    if (plan.reasons.length) {
      const fallback = element('button', 'pdf-overlay-fallback', `${plan.reasons.length} 段未覆盖：版面不可靠，请切换段落列表`); fallback.type = 'button';
      fallback.onclick = () => onNotice(plan.reasons.map(r => r.reason).filter((r, i, a) => a.indexOf(r) === i).join(' ')); root.append(fallback);
    }
    const check = () => { frame = undefined; if (!destroyed) for (const fn of measure) fn(); };
    if (window?.requestAnimationFrame) frame = window.requestAnimationFrame(check); else check();
    lastSignature = nextSignature;
    lastResult = { covered, skipped: plan.reasons.length, reasons: plan.reasons };
    return lastResult;
  }
  function resetPage(pageNumber = active?.page.number ?? active?.page.pageNumber) {
    for (const key of overrides.keys()) {
      const parts = key.split(':'); if (String(parts[1]) === String(pageNumber)) overrides.delete(key);
    }
    if (active && String(active.page.number ?? active.page.pageNumber ?? 1) === String(pageNumber)) render(active);
  }
  function resetAll() { overrides.clear(); active = null; clear(); }
  function destroy() { if (destroyed) return; clear(); destroyed = true; active = null; overrides.clear(); root.remove(); style.remove(); }
  return { render, clear, resetPage, resetAll, destroy };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { validRect, clampBox, adjustBox, blockLayout, planOverlays, createOverlay } from '../extension/pdf-overlay.js';
const rect = (x = 20, y = 40, width = 120, height = 12) => ({ x, y, width, height });
const block = (id = 'b1', r = rect(), state = 'done') => ({ id, text: '<script>English source</script>', rects: [r], chunks: [{ id: id + 'c1', text: 'English source', state, translation: '中文 <img src=x onerror=alert(1)>' }] });
const page = blocks => ({ number: 1, extractionVersion: 1, blocks, warnings: [] });

// Minimal DOM contract, intentionally no HTML parser: all UI content must be
// expressed as elements and textContent. No browser dependency is needed here.
function dom() {
  class Events {
    listeners = new Map();
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatch(type, fields = {}) { const event = { type, preventDefault() {}, stopPropagation() {}, ...fields }; for (const fn of this.listeners.get(type) || []) fn(event); this['on' + type]?.(event); return event; }
  }
  class Element extends Events {
    constructor(tag, document) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.scrollHeight = this.scrollWidth = 0; this.clientHeight = this.clientWidth = 0; }
    set textContent(value) { this.text = String(value); this.replaceChildren(); }
    get textContent() { return (this.text || '') + this.children.map(n => n.textContent).join(''); }
    set innerHTML(_) { throw new Error('Unsafe innerHTML use.'); }
    append(...nodes) { for (const n of nodes) { n.remove(); n.parent = this; this.children.push(n); } }
    replaceChildren(...nodes) { for (const n of this.children) n.parent = null; this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; } }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const frames = new Map(); let nextFrame = 0;
  const window = new Events(); window.requestAnimationFrame = fn => { frames.set(++nextFrame, fn); return nextFrame; }; window.cancelAnimationFrame = id => frames.delete(id);
  const document = { defaultView: window, createElement(tag) { return new Element(tag, this); } };
  document.body = document.createElement('body'); const host = document.createElement('div'); document.body.append(host);
  const nodes = (className, root = document.body) => { const all = []; const walk = n => { if ((n.className || '').split(' ').includes(className)) all.push(n); n.children.forEach(walk); }; walk(root); return all; };
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  return { document, host, window, nodes, flush, frames };
}

test('overlay rectangles reject invalid, outside, nonfinite and zero geometry', () => {
  assert.equal(validRect(rect(), 600, 800), true);
  for (const r of [rect(-1), rect(590), rect(1, 1, 0), rect(NaN), rect(1, 1, 10, Infinity)]) assert.equal(validRect(r, 600, 800), false);
  assert.ok(blockLayout(block(), 600, 800).fontSize > 0);
  assert.match(blockLayout(block('huge', rect(0, 0, 500, 500)), 600, 800).reason, /异常/);
  assert.throws(() => clampBox(rect(), NaN, 800), TypeError);
});
test('unit-coordinate move and resize clamp boxes to the page, including tiny pages', () => {
  assert.deepEqual(adjustBox(rect(), -999, 999, 600, 800), { x: 0, y: 784, width: 120, height: 16 });
  assert.deepEqual(adjustBox(rect(), 999, 999, 600, 800, true), { x: 0, y: 0, width: 600, height: 800 });
  assert.deepEqual(clampBox(rect(), 10, 8), { x: 0, y: 0, width: 10, height: 8 });
  assert.throws(() => adjustBox(rect(), NaN, 0, 600, 800), TypeError);
});
test('only complete, nonempty translations overlay; input state is never mutated', () => {
  const b = block(), pending = block('pending', rect(200), 'pending'), partial = block('partial', rect(350));
  partial.chunks.push({ id: 'missing', state: 'failed', translation: '' });
  const p = page([b, pending, partial]), before = structuredClone(p);
  assert.deepEqual(planOverlays(p, 600, 800).entries.map(e => e.block.id), ['b1']);
  b.chunks[0].translation = ''; assert.equal(planOverlays(p, 600, 800).entries.length, 0);
  b.chunks[0].translation = before.blocks[0].chunks[0].translation; assert.deepEqual(p, before);
});
test('overlap with complete OR unfinished source blocks fails conservatively', () => {
  let plan = planOverlays(page([block('a'), block('b', rect(30))]), 600, 800);
  assert.equal(plan.entries.length, 0); assert.equal(plan.reasons.length, 2);
  plan = planOverlays(page([block('a'), block('b', rect(30), 'pending')]), 600, 800);
  assert.equal(plan.entries.length, 0); assert.equal(plan.reasons.length, 1);
});
test('cross-column, layout-risk and severe page warnings retain original text', () => {
  const b = block(); b.rects.push(rect(350)); assert.match(blockLayout(b, 600, 800).reason, /跨栏/);
  const risky = block(); risky.layoutRisk = ['rotated']; assert.equal(planOverlays(page([risky]), 600, 800).entries.length, 0);
  const p = page([block()]); p.warnings = ['阅读顺序可能不准确']; assert.equal(planOverlays(p, 600, 800).entries.length, 0);
  p.warnings = ['本页仅提取到少量英文']; assert.equal(planOverlays(p, 600, 800).entries.length, 1, 'sparse but valid text is not blanket rejected');
});
test('DOM uses safe text, source masks stay anchored during keyboard move/resize and zoom', () => {
  const d = dom(), overlay = createOverlay({ host: d.host }); const p = page([block()]);
  assert.equal(overlay.render({ page: p, scale: 2, width: 600, height: 800 }).covered, 1);
  assert.match(d.nodes('pdf-overlay-text')[0].textContent, /<img/); assert.equal(d.nodes('pdf-overlay-text')[0].children.length, 0);
  const maskStyle = { ...d.nodes('pdf-source-mask')[0].style };
  d.nodes('pdf-move-handle')[0].dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(d.nodes('pdf-translation-box')[0].style.left, '60px');
  d.nodes('pdf-resize-handle')[0].dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(d.nodes('pdf-translation-box')[0].style.height, '52px');
  assert.deepEqual(d.nodes('pdf-source-mask')[0].style, maskStyle, 'source mask cannot follow edited translation box');
  overlay.clear(); assert.equal(d.nodes('pdf-translation-box').length, 0);
  overlay.render({ page: p, scale: 1, width: 600, height: 800 });
  assert.equal(d.nodes('pdf-translation-box')[0].style.left, '30px'); assert.equal(d.nodes('pdf-translation-box')[0].style.height, '26px');
  overlay.destroy(); assert.equal(d.host.children.length, 0);
});
test('pointer dragging saves bounded unit overrides and clear removes global listeners', () => {
  const d = dom(), overlay = createOverlay({ host: d.host }); overlay.render({ page: page([block()]), scale: 2, width: 600, height: 800 });
  d.nodes('pdf-move-handle')[0].dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  d.window.dispatch('pointermove', { pointerId: 1, clientX: 40, clientY: 20 });
  assert.equal(d.nodes('pdf-translation-box')[0].style.left, '80px');
  overlay.clear(); assert.equal(d.window.listeners.get('pointermove').size, 0); assert.equal(d.frames.size, 0);
});
test('hide restores source by removing masks, reset restores defaults, versions isolate overrides', () => {
  const d = dom(), overlay = createOverlay({ host: d.host }), p = page([block()]); overlay.render({ page: p, scale: 1, width: 600, height: 800 });
  const hide = d.nodes('pdf-overlay-tools')[0].children.find(b => b.textContent === '隐藏'); hide.dispatch('click');
  assert.equal(d.nodes('pdf-source-mask').length, 0); assert.equal(d.nodes('pdf-translation-box').length, 0);
  overlay.clear(); overlay.render({ page: p, scale: 2, width: 600, height: 800 }); assert.equal(d.nodes('pdf-translation-box').length, 0);
  overlay.resetPage(); assert.equal(d.nodes('pdf-translation-box').length, 1);
  d.nodes('pdf-move-handle')[0].dispatch('keydown', { key: 'ArrowRight' });
  overlay.render({ page: { ...p, extractionVersion: 2 }, scale: 1, width: 600, height: 800 }); assert.equal(d.nodes('pdf-translation-box')[0].style.left, '20px');
  overlay.resetAll(); overlay.destroy(); assert.throws(() => overlay.render({ page: p, width: 600, height: 800 }), /destroyed/);
});
test('overflow opens complete plain-text source/translation dialog, clear closes and releases it', () => {
  const d = dom(), overlay = createOverlay({ host: d.host }); overlay.render({ page: page([block()]), scale: 1, width: 600, height: 800 });
  const text = d.nodes('pdf-overlay-text')[0]; text.scrollHeight = 100; text.clientHeight = 16; d.flush();
  const expand = d.nodes('pdf-overflow-button')[0]; assert.equal(expand.hidden, false); expand.dispatch('click');
  assert.match(d.nodes('pdf-overlay-dialog')[0].textContent, /<script>English source<\/script>/); assert.match(d.nodes('pdf-overlay-dialog')[0].textContent, /中文 <img/);
  assert.equal(d.nodes('pdf-overlay-dialog')[0].open, true); overlay.clear(); assert.equal(d.nodes('pdf-overlay-dialog').length, 0);
});
test('identical state preserves DOM focus/drag, while real content updates rebuild safely', () => {
  const d = dom(), overlay = createOverlay({ host: d.host }), p = page([block()]);
  const args = { page: p, scale: 1, width: 600, height: 800 }; overlay.render(args);
  const original = d.nodes('pdf-translation-box')[0], move = d.nodes('pdf-move-handle')[0]; move.focus();
  overlay.render({ ...args, page: structuredClone(p) }); assert.equal(d.nodes('pdf-translation-box')[0], original); assert.equal(d.document.activeElement, move);
  move.dispatch('keydown', { key: 'ArrowRight' }); overlay.render(args); assert.equal(d.nodes('pdf-translation-box')[0], original, 'manual override is included in the retained signature');
  move.dispatch('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  overlay.render(args); assert.equal(d.window.listeners.get('pointermove').size, 1, 'unchanged repaint cannot cancel drag');
  p.blocks[0].chunks[0].translation = '新译文'; overlay.render(args); assert.notEqual(d.nodes('pdf-translation-box')[0], original); assert.equal(d.window.listeners.get('pointermove').size, 0);
  overlay.resetAll(); assert.equal(d.nodes('pdf-translation-box').length, 0, 'resetAll must not resurrect an old document');
  overlay.destroy();
});
test('display options affect font/mask only; fallback button reports risks without masking', () => {
  const d = dom(); let notice; const overlay = createOverlay({ host: d.host, onNotice: text => { notice = text; } });
  overlay.render({ page: page([block()]), scale: 2, fontScale: 1.25, mask: false, width: 600, height: 800 });
  assert.equal(d.nodes('pdf-source-mask').length, 0); assert.equal(d.nodes('pdf-overlay-text')[0].style.fontSize, '30px');
  overlay.render({ page: page([block('bad', rect(-1))]), scale: 1, width: 600, height: 800 });
  d.nodes('pdf-overlay-fallback')[0].dispatch('click'); assert.match(notice, /坐标无效/);
  assert.throws(() => overlay.render({ page: page([]), scale: 0, width: 600, height: 800 }), TypeError);
  overlay.destroy();
});

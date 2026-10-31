import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from '../extension/pdf-extract.js';

const page = { width: 600, height: 800 };
function item(str, x = 40, baseline = 740, width = str.length * 5, size = 10, extra = {}) {
  return { str, transform: [size, 0, 0, size, x, baseline], width, height: size, dir: 'ltr', ...extra };
}
const texts = result => result.blocks.map(b => b.text);

test('empty pages and non-text marked content are safe and warn without mutation', () => {
  const input = [{ type: 'beginMarkedContent', id: 'p1' }, item('   ')];
  const copy = structuredClone(input);
  const r = extractPage(input, page);
  assert.equal(r.quality, 'empty'); assert.deepEqual(r.blocks, []);
  assert.match(r.warnings.join(' '), /扫描页/); assert.deepEqual(input, copy);
});

test('fragmented glyphs and words form readable lines using geometric gaps', () => {
  const input = [item('world.', 78, 740, 30), item('Hello', 40, 740, 25), item('The ', 40, 725, 20), item('re', 60, 725, 10), item('ader', 70, 725, 20)];
  const copy = structuredClone(input), r = extractPage(input, page);
  assert.deepEqual(texts(r), ['Hello world. The reader']);
  assert.equal(r.quality, 'ok'); assert.deepEqual(input, copy);
  assert.equal(r.blocks[0].rects.length, 5);
  assert.deepEqual(r.blocks[0].rects[0], { x: 40, y: 52, width: 25, height: 10 });
  assert.deepEqual(extractPage(input, page), r);
});

test('normal line spacing merges while paragraph gaps, headings and lists stay separate', () => {
  const r = extractPage([
    item('A useful heading', 40, 760, 200, 16),
    item('The first line of the paragraph', 40, 730),
    item('continues on another line.', 40, 715),
    item('Another paragraph begins here.', 40, 680),
    item('1. First list item', 40, 665),
    item('2. Second list item', 40, 650)
  ], page);
  assert.deepEqual(texts(r), ['A useful heading', 'The first line of the paragraph continues on another line.', 'Another paragraph begins here.', '1. First list item', '2. Second list item']);
});

test('conservative dehyphenation joins known incomplete and soft-hyphen words, preserving compounds', () => {
  assert.deepEqual(texts(extractPage([item('The transla-'), item('tion works well.', 40, 725)], page)), ['The translation works well.']);
  assert.deepEqual(texts(extractPage([item('The docu\u00ad'), item('ment works well.', 40, 725)], page)), ['The document works well.']);
  assert.deepEqual(texts(extractPage([item('A well-'), item('known method works.', 40, 725)], page)), ['A well-known method works.']);
  assert.deepEqual(texts(extractPage([item('An unknown-'), item('compound stays intact.', 40, 725)], page)), ['An unknown-compound stays intact.']);
});

test('two columns read down the left before the right, with spanning headings first', () => {
  const r = extractPage([
    item('A title spanning both columns', 40, 770, 500, 16),
    item('Right paragraph starts.', 330, 740, 210),
    item('Left paragraph starts.', 40, 740, 210),
    item('Right continuation ends.', 330, 725, 210),
    item('Left continuation ends.', 40, 725, 210)
  ], page);
  assert.deepEqual(texts(r), ['A title spanning both columns', 'Left paragraph starts. Left continuation ends.', 'Right paragraph starts. Right continuation ends.']);
  assert.match(r.warnings.join(' '), /双栏/);
});

test('staggered column baselines still read as columns rather than interleaved rows', () => {
  const r = extractPage([
    item('Left paragraph starts.', 40, 740, 210), item('Left continuation ends.', 40, 725, 210),
    item('Right paragraph starts.', 330, 733, 210), item('Right continuation ends.', 330, 718, 210)
  ], page);
  assert.deepEqual(texts(r), ['Left paragraph starts. Left continuation ends.', 'Right paragraph starts. Right continuation ends.']);
  assert.match(r.warnings.join(' '), /双栏/);
});

test('a later spanning heading is a reading-order barrier between column zones', () => {
  const r = extractPage([
    item('Left first.', 40, 740, 210), item('Right first.', 330, 740, 210),
    item('Left second.', 40, 725, 210), item('Right second.', 330, 725, 210),
    item('Second spanning heading', 40, 680, 500, 16),
    item('Left below.', 40, 640, 210), item('Right below.', 330, 640, 210),
    item('Left last.', 40, 625, 210), item('Right last.', 330, 625, 210)
  ], page);
  assert.deepEqual(texts(r), ['Left first. Left second.', 'Right first. Right second.', 'Second spanning heading', 'Left below. Left last.', 'Right below. Right last.']);
});

test('English filtering excludes Chinese, numbers, URL, obvious code and simple formula, retains AI', () => {
  const r = extractPage([
    item('这是中文段落。', 40, 760), item('123456', 40, 720),
    item('https://example.com/test', 40, 680), item('const value = 3;', 40, 640),
    item('E = mc^2', 40, 600), item('AI', 40, 560), item('This English paragraph is eligible.', 40, 520)
  ], page);
  assert.deepEqual(texts(r), ['AI', 'This English paragraph is eligible.']);
  assert.equal(extractPage([item('只有中文。')], page).quality, 'empty');
});

test('very short English is kept with a sparse/poor extraction warning', () => {
  const r = extractPage([item('AI')], page);
  assert.equal(r.quality, 'poor'); assert.deepEqual(texts(r), ['AI']);
  assert.match(r.warnings.join(' '), /少量/);
});

test('paragraphs are sliced into stable unique chunks of at most 1800 characters without text loss', () => {
  const text = 'This is a useful English sentence. '.repeat(180).trim();
  const r = extractPage([item(text, 40, 740, 500)], page), b = r.blocks[0];
  assert.equal(b.text, text); assert.ok(b.chunks.length > 3);
  assert.equal(b.chunks.map(c => c.text).join(''), text);
  assert.ok(b.chunks.every(c => c.text.length <= 1800 && c.id.length <= 100));
  assert.equal(new Set(b.chunks.map(c => c.id)).size, b.chunks.length);
  const continuous = 'English'.repeat(700);
  assert.ok(extractPage([item(continuous, 40, 740, 500)], page).blocks[0].chunks.every(c => c.text.length <= 1800));
});

test('limits fail closed rather than translating a truncated page', () => {
  const many = Array.from({ length: 50001 }, () => item('English'));
  const tooMany = extractPage(many, page);
  assert.equal(tooMany.quality, 'poor'); assert.deepEqual(tooMany.blocks, []); assert.match(tooMany.warnings[0], /50,000/);
  const huge = extractPage([item('a'.repeat(200001), 40, 740, 500)], page);
  assert.equal(huge.quality, 'poor'); assert.deepEqual(huge.blocks, []); assert.match(huge.warnings[0], /200,000/);
});

test('garbled encoding and private-use characters are rejected before translation', () => {
  for (const text of ['\ufffd'.repeat(20) + 'Some English', '\ue001'.repeat(20) + 'Some English']) {
    const r = extractPage([item(text)], page);
    assert.equal(r.quality, 'poor'); assert.deepEqual(r.blocks, []); assert.match(r.warnings.join(' '), /乱码/);
  }
  const minor = extractPage([item('A relatively long English paragraph contains one missing glyph \ufffd and remains readable.', 40, 740, 500)], page);
  assert.equal(minor.quality, 'poor'); assert.match(minor.warnings.join(' '), /少量缺失/);
});

test('rotation uses natural top-left coordinates after page rotation', () => {
  const r = extractPage([item('Rotated English text', 500, 40, 100, 10, { transform: [0, 10, -10, 0, 500, 40] })], { ...page, rotation: 90 });
  assert.deepEqual(texts(r), ['Rotated English text']);
  assert.deepEqual(r.blocks[0].rects, [{ x: 40, y: 492, width: 100, height: 10 }]);
  const turned = extractPage([item('Upside down English', 500, 40, 100, 10, { transform: [-10, 0, 0, -10, 500, 40] })], { ...page, rotation: 180 });
  assert.deepEqual(turned.blocks[0].rects, [{ x: 100, y: 32, width: 100, height: 10 }]);
});

test('invalid, out-of-page and unsupported vertical items warn and never produce invalid rectangles', () => {
  const r = extractPage([
    item('Invalid', 40, 740, 100, 10, { transform: [10, 0, 0, 10, NaN, 740] }),
    item('Outside page', 900, 740),
    item('Vertical', 100, 500, 100, 10, { transform: [0, 10, -10, 0, 100, 500], dir: 'ttb' }),
    item('Valid English remains readable.', 40, 700)
  ], page);
  assert.deepEqual(texts(r), ['Valid English remains readable.']);
  assert.match(r.warnings.join(' '), /坐标无效/); assert.match(r.warnings.join(' '), /范围外/); assert.match(r.warnings.join(' '), /非横排/);
  for (const rect of r.blocks.flatMap(b => b.rects)) assert.ok(Object.values(rect).every(Number.isFinite));
});

test('unconfirmed columns and overlapping text report ordering warnings', () => {
  const r = extractPage([item('Left region', 40, 740, 100), item('Right region', 400, 740, 100)], page);
  assert.match(r.warnings.join(' '), /阅读顺序可能不准确/);
  const overlap = extractPage([item('Some English text', 40, 740, 100), item('overlapping text', 50, 740, 100)], page);
  assert.match(overlap.warnings.join(' '), /重叠文字/);
});

test('API validates dimensions, rotations and item-array shape', () => {
  assert.throws(() => extractPage(null, page), TypeError);
  assert.throws(() => extractPage([], { width: 0, height: 100 }), TypeError);
  assert.throws(() => extractPage([], { ...page, rotation: 45 }), TypeError);
  assert.throws(() => extractPage([], { ...page, width: Infinity }), TypeError);
  assert.deepEqual(extractPage([], { ...page, rotation: -90 }), extractPage([], { ...page, rotation: 270 }));
});

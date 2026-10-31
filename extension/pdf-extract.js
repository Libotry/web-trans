import { english, splitText } from './core.js';

const MAX_ITEMS = 50000, MAX_CHARS = 200000;
const median = values => { const a = [...values].sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 1; };
const right = r => r.x + r.width;
const bottom = r => r.y + r.height;
const listStart = text => /^(?:[•●▪◦*-]\s|\(?\d+[.)]\s|[a-z][.)]\s)/i.test(text);

/**
 * Pure PDF.js TextItem extraction, with no DOM, network or PDF.js dependency.
 * width/height are the unrotated PDF page dimensions (viewBox extent), not a
 * zoomed viewport. rects use TOP-LEFT coordinates at scale 1 AFTER clockwise
 * page rotation; 90/270 swap the output page dimensions. TextItem positions
 * are PDF bottom-left coordinates. Font ascenders are unavailable here, so
 * boxes approximate 0.8 ascent / 0.2 descent; use them as reading highlights,
 * not glyph-exact selections. IDs are stable within this page, not globally.
 */
export function extractPage(items, { width, height, rotation = 0 } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items 必须是 PDF.js 文字项数组。');
  if (![width, height, rotation].every(Number.isFinite) || width <= 0 || height <= 0 || rotation % 90 !== 0) {
    throw new TypeError('页面尺寸必须为正数，旋转角度必须是 90 度的整数倍。');
  }
  const warnings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const result = (blocks, quality) => ({ blocks, warnings, quality });
  if (items.length > MAX_ITEMS) { warn('本页超过 50,000 个文字项，已停止提取与翻译。'); return result([], 'poor'); }
  let charCount = 0, badCount = 0, rawLetters = 0, contentCount = 0;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    charCount += item.str.length;
    contentCount += item.str.trim().length;
    if (charCount > MAX_CHARS) { warn('本页超过 200,000 个字符，已停止提取与翻译。'); return result([], 'poor'); }
    badCount += (item.str.match(/[\ufffd\u0000-\u0008\u000b\u000c\u000e-\u001f\ue000-\uf8ff]/g) || []).length;
    rawLetters += (item.str.match(/[a-z]/gi) || []).length;
  }
  if (badCount && badCount / Math.max(1, charCount) > 0.05) {
    warn('本页文字含较多乱码或缺失字符，已停止翻译，请检查提取预览。'); return result([], 'poor');
  }
  if (badCount) warn('本页含少量缺失字符，提取结果可能不完整。');
  const angle = ((rotation % 360) + 360) % 360;
  const pageWidth = angle % 180 ? height : width, pageHeight = angle % 180 ? width : height;
  const point = (x, y) => angle === 90 ? [y, x] : angle === 180 ? [width - x, y] : angle === 270 ? [height - y, width - x] : [x, height - y];
  const words = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6 || !t.slice(0, 6).every(Number.isFinite) || !Number.isFinite(item.width) || item.width < 0) {
      warn('部分文字项坐标无效，已跳过。'); continue;
    }
    const length = Math.hypot(t[0], t[1]);
    const h = Number.isFinite(item.height) && item.height > 0 ? item.height : Math.hypot(t[2], t[3]);
    if (!(length > 0 && h > 0)) { warn('部分文字项缺少有效尺寸，已跳过。'); continue; }
    const [bx, by] = point(t[4], t[5]), [ex, ey] = point(t[4] + t[0], t[5] + t[1]);
    if (item.dir === 'ttb' || Math.abs(ey - by) > Math.abs(ex - bx) * 0.25 || ex <= bx) {
      warn('本页含非横排或混合旋转文字，已跳过不支持的文字，阅读顺序可能不准确。'); continue;
    }
    const ux = t[0] / length, uy = t[1] / length;
    const upLength = Math.hypot(t[2], t[3]);
    const vx = upLength ? t[2] / upLength : -uy, vy = upLength ? t[3] / upLength : ux;
    const corners = [];
    for (const advance of [0, item.width]) for (const ascent of [-0.2 * h, 0.8 * h]) {
      corners.push(point(t[4] + ux * advance + vx * ascent, t[5] + uy * advance + vy * ascent));
    }
    const x = Math.max(0, Math.min(...corners.map(p => p[0]))), y = Math.max(0, Math.min(...corners.map(p => p[1])));
    const r = Math.min(pageWidth, Math.max(...corners.map(p => p[0]))), b = Math.min(pageHeight, Math.max(...corners.map(p => p[1])));
    if (r <= x || b <= y) { warn('部分文字位于页面范围外，已跳过。'); continue; }
    words.push({ x, y, width: r - x, height: b - y, baseline: by, fontSize: h, text: item.str.replace(/[\u0000-\u001f\ufffd]/g, ' ').replace(/\s+/g, ' '), index });
  }
  if (!words.length) {
    warn(contentCount ? '本页没有可处理的横排文字。' : '本页未提取到可翻译文字，可能为空白页或扫描页。');
    return result([], contentCount ? 'poor' : 'empty');
  }

  // Group only neighbouring baselines, then split large horizontal gaps before
  // column detection. Otherwise two columns on the same baseline become one.
  words.sort((a, b) => a.baseline - b.baseline || a.x - b.x || a.index - b.index);
  const rows = [];
  for (const word of words) {
    let row = rows[rows.length - 1];
    if (!row || Math.abs(word.baseline - row.baseline) > Math.min(word.fontSize, row.fontSize) * 0.3) {
      row = { baseline: word.baseline, fontSize: word.fontSize, words: [] }; rows.push(row);
    }
    row.words.push(word);
  }
  const runs = [], candidates = new Map();
  for (const row of rows) {
    row.words.sort((a, b) => a.x - b.x || a.index - b.index);
    let run;
    for (const word of row.words) {
      const gap = run ? word.x - right(run) : Infinity;
      if (!run || gap > Math.max(30, word.fontSize * 3)) {
        if (run && gap > pageWidth * 0.06) {
          const mid = (right(run) + word.x) / 2;
          if (mid > pageWidth * 0.25 && mid < pageWidth * 0.75) {
            const key = Math.round(mid / (pageWidth * 0.03));
            const entry = candidates.get(key) || { total: 0, count: 0 };
            entry.total += mid; entry.count++; candidates.set(key, entry);
          }
        }
        run = { x: word.x, y: word.y, width: word.width, height: word.height, fontSize: word.fontSize, baseline: word.baseline, text: word.text, rects: [rect(word)] };
        runs.push(run);
      } else {
        if (gap < -Math.min(word.width, run.width) * 0.2) warn('本页含重叠文字，阅读顺序可能不准确。');
        const needsSpace = gap > Math.max(0.5, word.fontSize * 0.12) && !/\s$/.test(run.text) && !/^\s|^[,.;:!?%)\]}]/.test(word.text);
        run.text += (needsSpace ? ' ' : '') + word.text;
        run.width = Math.max(right(run), right(word)) - run.x;
        const newY = Math.min(run.y, word.y), newBottom = Math.max(bottom(run), bottom(word));
        run.y = newY; run.height = newBottom - newY; run.rects.push(rect(word));
      }
    }
  }
  const fontSize = median(runs.map(r => r.fontSize));
  // Columns need not share baselines. Also probe a bounded set of central
  // gutters, requiring repeated sizeable lines with overlapping vertical spans.
  for (const fraction of [0.4, 0.45, 0.5, 0.55, 0.6]) {
    const mid = pageWidth * fraction;
    const l = runs.filter(r => right(r) < mid - fontSize && r.width >= pageWidth * 0.12);
    const r = runs.filter(r => r.x > mid + fontSize && r.width >= pageWidth * 0.12);
    if (l.length < 2 || r.length < 2) continue;
    const overlap = Math.min(Math.max(...l.map(x => bottom(x))), Math.max(...r.map(x => bottom(x)))) - Math.max(Math.min(...l.map(x => x.y)), Math.min(...r.map(x => x.y)));
    const gap = Math.min(...r.map(x => x.x)) - Math.max(...l.map(x => right(x)));
    if (overlap > fontSize && gap > pageWidth * 0.06) candidates.set(`probe${fraction}`, { total: mid * 2, count: 2 });
  }
  let gutter = null, best = 0;
  for (const candidate of [...candidates.values()].sort((a, b) => b.count - a.count).slice(0, 8)) {
    const mid = candidate.total / candidate.count;
    const left = runs.filter(r => right(r) < mid - fontSize), rightRuns = runs.filter(r => r.x > mid + fontSize);
    const score = Math.min(left.length, rightRuns.length);
    if (candidate.count >= 2 && score >= 2 && score > best) { best = score; gutter = mid; }
  }
  if (candidates.size && gutter === null) warn('本页存在分栏或较大空隙，阅读顺序可能不准确。');
  if (gutter !== null) warn('本页按双栏顺序提取；复杂表格或多栏的阅读顺序可能不准确。');
  const orderedGroups = [];
  const sortLines = a => a.sort((x, y) => x.y - y.y || x.x - y.x);
  if (gutter === null) orderedGroups.push(sortLines(runs));
  else {
    const spans = sortLines(runs.filter(r => r.x < gutter && right(r) > gutter));
    const spanSet = new Set(spans);
    const remaining = sortLines(runs.filter(r => !spanSet.has(r)));
    let cursor = 0;
    const columns = group => {
      const left = group.filter(r => r.x + r.width / 2 < gutter), r = group.filter(r => r.x + r.width / 2 >= gutter);
      if (left.length) orderedGroups.push(sortLines(left));
      if (r.length) orderedGroups.push(sortLines(r));
    };
    for (const span of spans) {
      const start = cursor;
      while (cursor < remaining.length && remaining[cursor].y < span.y) cursor++;
      columns(remaining.slice(start, cursor));
      orderedGroups.push([span]);
    }
    columns(remaining.slice(cursor));
  }
  const paragraphs = [];
  for (const group of orderedGroups) {
    let paragraph, previous;
    for (const line of group) {
      line.text = line.text.trim();
      if (!line.text) continue;
      const newParagraph = !previous || line.y - previous.y > Math.max(previous.fontSize, line.fontSize) * 1.75 ||
        line.y - previous.y < Math.min(previous.fontSize, line.fontSize) * 0.5 ||
        Math.abs(line.x - previous.x) > line.fontSize * 1.5 ||
        Math.max(line.fontSize, previous.fontSize) / Math.min(line.fontSize, previous.fontSize) > 1.2 || listStart(line.text);
      if (newParagraph) { paragraph = { text: line.text, rects: [...line.rects] }; paragraphs.push(paragraph); }
      else { paragraph.text = joinLines(paragraph.text, line.text); paragraph.rects.push(...line.rects); }
      previous = line;
    }
  }
  const blocks = [];
  for (const p of paragraphs) {
    const text = p.text.replace(/\u00ad/g, '').trim();
    if (!translatable(text)) continue;
    const id = `b${blocks.length + 1}`;
    blocks.push({ id, text, rects: p.rects, chunks: splitText(text, 1800).map((text, i) => ({ id: `${id}c${i + 1}`, text })) });
  }
  if (!blocks.length) { warn('本页未发现可翻译英文，可能为中文页、公式页或扫描页。'); return result([], 'empty'); }
  if (rawLetters < 30) warn('本页仅提取到少量英文文字，图片区域未识别。');
  return result(blocks, badCount || rawLetters < 10 ? 'poor' : 'ok');
}

function rect({ x, y, width, height }) { return { x, y, width, height }; }
function translatable(text) {
  if (!english(text) && !/^[A-Z]{2}$/.test(text)) return false;
  // Avoid obvious executable/code and formula blocks, without excluding prose
  // containing ordinary parentheses, numbers or mathematical terminology.
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(text) || /(?:=>|\b(?:const|let|var|function|import)\s+\w+\s*[=(]|[{};].*[{};])/.test(text)) return false;
  if (/^[\w\s+*/^().-]+=[\w\s+*/^().=-]+$/.test(text) && !/\b[a-z]{4,}\b/i.test(text)) return false;
  return true;
}
function joinLines(before, after) {
  // Soft hyphens explicitly mark discretionary breaks. For ASCII hyphens be
  // deliberately conservative: only known incomplete stems are joined. Unknown
  // cases (and compounds such as well-known/state-of-the-art) retain the '-'.
  if (/\u00ad$/.test(before) && /^[a-z]/.test(after)) return before.slice(0, -1) + after;
  const stem = before.match(/([a-z]+)-$/i)?.[1].toLowerCase();
  const incomplete = new Set(['transla', 'informa', 'docu', 'implemen', 'para', 'continua', 'hyphen', 'recogni', 'repre', 'computa', 'evalua']);
  if (stem && incomplete.has(stem) && /^[a-z]{2}/.test(after)) return before.slice(0, -1) + after;
  if (/-$/.test(before) && /^[a-z]/.test(after)) return before + after;
  return before + ' ' + after;
}

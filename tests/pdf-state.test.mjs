import test from 'node:test';
import assert from 'node:assert/strict';
import { pageState, chunksOf, nextBatch, applyResult, textBytes } from '../extension/pdf-state.js';
const extraction = texts => ({ quality: 'ok', warnings: [], blocks: texts.map((text, i) => ({ id: `b${i}`, text, rects: [], chunks: [{ id: `c${i}`, text }] })) });

test('page identity prefixes isolate identical extraction blocks across pages without mutation', () => {
  const input = extraction(['First paragraph', 'Second paragraph']), snapshot = structuredClone(input);
  const one = pageState(1, input), two = pageState(2, input);
  assert.equal(one.number, 1); assert.equal(chunksOf(one)[0].state, 'pending');
  assert.notEqual(chunksOf(one)[0].id, chunksOf(two)[0].id);
  assert.deepEqual(input, snapshot); assert.deepEqual(chunksOf(undefined), []);
  assert.ok(chunksOf(one).every(c => c.id.length <= 100));
});

test('queue only chooses pending chunks, at most six and 6500 characters', () => {
  const page = pageState(1, extraction(Array(9).fill('Short English paragraph')));
  chunksOf(page)[0].state = 'done'; chunksOf(page)[1].state = 'inflight'; chunksOf(page)[2].state = 'failed';
  assert.equal(nextBatch(page).length, 6); assert.equal(nextBatch(page)[0], chunksOf(page)[3]);
  const long = pageState(2, extraction(Array(6).fill('a'.repeat(1800))));
  assert.equal(nextBatch(long).length, 3);
  assert.ok(nextBatch(long).reduce((sum, c) => sum + c.text.length, 0) <= 6500);
});

test('results map by ID, missing or empty results fail without erasing good siblings', () => {
  const page = pageState(1, extraction(['one', 'two', 'three'])), batch = chunksOf(page);
  applyResult(batch, { translations: [{ id: batch[1].id, text: '第二段' }, { id: batch[0].id, text: '' }, { id: 'unrelated', text: '不应配对' }] });
  assert.deepEqual(batch.map(c => c.state), ['failed', 'done', 'failed']);
  assert.equal(batch[1].translation, '第二段'); assert.equal(batch[0].translation, '');
  assert.match(batch[2].error, /重试/); assert.deepEqual(nextBatch(page), []);
});

test('text budget counts block text, chunk copies and translations as UTF-16 estimates', () => {
  const page = pageState(1, extraction(['abcd']));
  assert.equal(textBytes(new Map([[1, page]])), 16);
  chunksOf(page)[0].translation = '中文';
  assert.equal(textBytes(new Map([[1, page]])), 20);
  assert.equal(textBytes(new Map()), 0);
});

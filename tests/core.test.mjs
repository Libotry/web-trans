import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, parseTranslations, english, splitText, buildRequest } from '../extension/core.js';
const segments = [{ id: 'a', text: 'Hello world.' }, { id: 'b', text: 'Read more.' }];
test('strict HTTPS endpoint and bounded configuration', () => {
  const c = validateConfig({ endpoint: 'https://example.test/v1/chat/completions', model: ' model ' }); assert.equal(c.model, 'model');
  for (const endpoint of ['http://example.test', 'https://user:pass@example.test', 'https://example.test?key=abc', 'javascript:alert(1)']) assert.throws(() => validateConfig({ endpoint, model: 'x' }));
  assert.throws(() => validateConfig({ ...c, color: 'red;display:none' })); assert.throws(() => validateConfig({ ...c, limit: 1001 }));
});
test('out of order results are matched by ID, duplicate and missing IDs fail', () => {
  assert.deepEqual(parseTranslations('{"translations":[{"id":"b","text":"阅读更多。"},{"id":"a","text":"你好，世界。"}]}', segments), [{ id: 'a', text: '你好，世界。' }, { id: 'b', text: '阅读更多。' }]);
  const r = parseTranslations('{"translations":[{"id":"a","text":"一"},{"id":"a","text":"二"},{"id":"unknown","text":"三"}]}', segments); assert.equal(r[0].text, null); assert.equal(r[1].text, null);
  assert.throws(() => parseTranslations('not json', segments));
});
test('language filter and lossless bounded long paragraph segmentation', () => {
  assert.equal(english('这是一段中文'), false); assert.equal(english('https://example.com'), false); assert.equal(english('API'), true);
  const text = 'English sentence with a URL https://example.test. '.repeat(200); const parts = splitText(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(p => p.length <= 1800));
});
test('provider keeps source in data and enables JSON mode only when requested', () => {
  const c = { model: 'test', jsonMode: false }; const r = buildRequest(c, segments); assert.equal(r.response_format, undefined); assert.equal(r.stream, false);
  assert.deepEqual(JSON.parse(r.messages[1].content).segments, segments); assert.deepEqual(buildRequest({ ...c, jsonMode: true }, segments).response_format, { type: 'json_object' });
});

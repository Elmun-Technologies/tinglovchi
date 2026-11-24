import test from 'node:test';
import assert from 'node:assert/strict';
import { wordsToUtterances } from '../lib/stt.mjs';
import { normalizeAnalysis, ANALYSIS_SCHEMA } from '../lib/analyze.mjs';
import {
  renderPresentation,
  renderMarkdown,
  buildSlides,
  formatDuration,
  mindMapSvg,
} from '../lib/presentation.mjs';
import { DEMO_ANALYSIS, demoWords } from '../lib/demo.mjs';

const meeting = { createdAt: '2026-11-24T10:00:00.000Z', durationMs: 4 * 3600_000 + 12 * 60_000 };

test('so‘zlar spiker bo‘yicha replikalarga yig‘iladi va vaqt bo‘lak boshlanishiga suriladi', () => {
  const words = [
    { text: 'Salom', start: 0.5, end: 0.9, speaker: 'speaker_0' },
    { text: ',', start: 0.9, end: 0.9, speaker: 'speaker_0' },
    { text: 'yaxshimisiz', start: 1.0, end: 1.6, speaker: 'speaker_0' },
    { text: 'Rahmat', start: 2.0, end: 2.4, speaker: 'speaker_1' },
    { text: 'Davom', start: 9.0, end: 9.4, speaker: 'speaker_1' },
  ];
  const u = wordsToUtterances(words, { offsetSec: 1200, segmentNo: 2 });
  assert.equal(u.length, 3);
  assert.deepEqual(u[0], {
    start: 1200.5,
    end: 1201.6,
    speaker: 'Q2/S1',
    text: 'Salom, yaxshimisiz',
  });
  assert.equal(u[1].speaker, 'Q2/S2');
  assert.equal(u[2].text, 'Davom'); // uzoq pauzadan keyin yangi replika
});

test('tahlil sxemasi: barcha obyektlar qat’iy (additionalProperties=false, hammasi required)', () => {
  const walk = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    } else if (node.type === 'array') walk(node.items);
  };
  walk(ANALYSIS_SCHEMA);
});

test('namuna tahlil sxemaga mos va normalizatsiyadan o‘zgarmay o‘tadi', () => {
  assert.deepEqual(normalizeAnalysis(DEMO_ANALYSIS), DEMO_ANALYSIS);
  assert.deepEqual(
    Object.keys(DEMO_ANALYSIS).sort(),
    Object.keys(ANALYSIS_SCHEMA.properties).sort(),
  );
});

test('normalizatsiya buzuq yoki chala javobni xavfsiz shaklga keltiradi', () => {
  const a = normalizeAnalysis({
    title: null,
    tasks: [{ title: 'X', priority: 'URGENT', side: 'client' }, null, 'matn'],
    risks: 'yo‘q',
  });
  assert.equal(a.title, 'Suhbat tahlili');
  assert.equal(a.tasks.length, 1);
  assert.equal(a.tasks[0].priority, 'P2');
  assert.equal(a.tasks[0].side, 'nomalum');
  assert.equal(a.tasks[0].owner, 'Belgilanmagan');
  assert.deepEqual(a.risks, []);
  assert.doesNotThrow(() => renderPresentation(a, meeting));
  assert.doesNotThrow(() => renderPresentation(normalizeAnalysis(null), meeting));
});

test('prezentatsiya: HTML maxsus belgilar ekranlanadi (transkriptdagi matn kod sifatida ishlamaydi)', () => {
  const evil = structuredClone(DEMO_ANALYSIS);
  evil.title = '<script>alert(1)</script>';
  evil.tasks[0].title = '"><img src=x onerror=alert(1)>';
  evil.topics[0].points[0] = '</text><script>x</script>';
  const html = renderPresentation(evil, meeting);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('</text><script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('prezentatsiya: asosiy bo‘limlar bor, uzun ro‘yxatlar sahifalarga bo‘linadi', () => {
  const big = structuredClone(DEMO_ANALYSIS);
  big.tasks = Array.from({ length: 23 }, (_, i) => ({
    ...DEMO_ANALYSIS.tasks[i % 6],
    title: `Vazifa ${i + 1}`,
  }));
  const slides = buildSlides(big, meeting);
  const html = slides.join('\n');
  for (const heading of [
    'Suhbatdan nima anglashildi',
    'Suhbat xaritasi',
    'Kim tarafdan qanday talablar',
    'Kim nimani yuborishi kerak',
    'Kim nimani ko‘rib berishi kerak',
    'Vazifalar — muhimlik bo‘yicha (1/5)',
    'Kim nima qiladi',
    'Yo‘l xaritasi',
    'Endi nima qilamiz',
  ]) {
    assert.ok(html.includes(heading), heading);
  }
  assert.ok(html.includes('Vazifa 23'));
  // P1 vazifalar birinchi turadi
  assert.ok(html.indexOf('pri-border-P1') < html.indexOf('pri-border-P3'));
  assert.ok(mindMapSvg(big).startsWith('<svg'));
});

test('matnli xulosa va davomiylik formati', () => {
  const md = renderMarkdown(DEMO_ANALYSIS, meeting);
  assert.ok(md.includes('## Vazifalar'));
  assert.ok(md.includes('## Kim nimani yuboradi'));
  assert.equal(formatDuration(meeting.durationMs), '4 soat 12 daqiqa');
  assert.equal(formatDuration(12_000), '12 soniya');
  assert.equal(formatDuration(45 * 60_000), '45 daqiqa');
  assert.ok(demoWords(1).length > 50);
});

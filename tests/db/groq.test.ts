import './setup';
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { db } from '../../src/lib/db';
import { env } from '../../src/lib/env';
import { clearAiWait } from '../../src/lib/llm';
import { draftNext } from '../../src/lib/pipeline/drafting';
import * as C from '../../src/lib/pipeline/campaigns';
import { profileNext } from '../../src/lib/pipeline/profile';
import { demoPdf, DEMO_ABOUT, DEMO_CV } from '../../scripts/seed';
import { wipe } from './setup';

/** Groq is replaced by a stand-in: no network. */
const realFetch = globalThis.fetch;
let calls: any[] = [];
let checks: any[] = [];
let answer: (body: any) => Response;
let verdict: () => string[] = () => [];
const isRepair = (b: any) => b.messages[0].content.startsWith('You correct the body');
const isCheck = (b: any) => b.messages[0].content.startsWith('You check one email');
const ok = (o: unknown) => Response.json({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const MAIL = { hook: 'signal research', greeting: 'Dear Professor Smith,', fit: 'some', fitNote: 'n', body: `${'I would like to study signals with you and learn from your group. '.repeat(11)}\n\nI hope there may be a funded position. My CV is attached, and I would welcome a call of 10 to 20 minutes.` };

beforeEach(async () => {
  Object.assign(env(), { LLM_PROVIDER: 'groq', GROQ_API_KEY: 'test-key', LLM_RATE_PER_MIN: 100000 });
  clearAiWait();
  calls = [];
  checks = [];
  verdict = () => [];
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body);
    if (isCheck(body)) {
      checks.push(body);
      return ok({ unsupported: verdict() });
    }
    calls.push(body);
    return answer(body);
  }) as any;
  await wipe();
});
after(async () => {
  globalThis.fetch = realFetch;
  await db.$disconnect();
});

async function campaign(count = 1) {
  const s = await db.student.create({ data: { fullName: 'Ayesha Rahman Demo', email: 'g@gmail.com', isDemo: true, phone: '+880 1700 000000', notes: DEMO_ABOUT } });
  const b = demoPdf(DEMO_CV);
  const cv = await db.cv.create({ data: { studentId: s.id, version: 1, fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: b.length, sha256: 'x', content: b } });
  const l = await db.professorList.create({ data: { studentId: s.id, fileName: 'l', status: 'IMPORTED', headers: [], rows: [], mapping: {}, createdBy: 't' } });
  await db.professor.createMany({ data: Array.from({ length: count }, (_, i) => ({ listId: l.id, rowNumber: i, name: 'Prof. Jo Smith', email: `p${i}@u.edu` })) });
  return C.createCampaign({ studentId: s.id, listId: l.id, cvId: cv.id, name: 'c', startDate: '2030-01-01', windowStart: '19:30', windowEnd: '20:30', timezone: 'Asia/Dhaka', minPerDay: 1, maxPerDay: 2, weekdays: [1], autoSchedule: false }, 't');
}

test('emails are written through Groq from the student text; the CV never leaves the system', async () => {
  const c = await campaign(2);
  answer = () => ok(MAIL);
  while (await draftNext());
  const e = await db.email.findMany({ where: { campaignId: c.id } });
  assert.ok(e.every((x) => x.status === 'DRAFT' && x.subject === 'Prospective PhD Researcher | signal research' && x.body.endsWith('Email: g@gmail.com | Phone: +880 1700 000000')));
  const b = calls[0];
  assert.equal(b.model, 'openai/gpt-oss-120b');
  assert.deepEqual([...new Set(checks.map((x) => x.model))], ['openai/gpt-oss-20b'], 'nothing suspected: the big model is not used for checking');
  assert.equal(b.response_format.json_schema.strict, true);
  assert.deepEqual(b.response_format.json_schema.schema.required, Object.keys(b.response_format.json_schema.schema.properties));
  assert.match(b.messages[1].content, /CGPA 3\.72/);
  assert.ok(b.messages.every((m: any) => typeof m.content === 'string' && !m.content.includes('%PDF')));
});

test('usage limit: writing waits as long as Groq says, loses nothing, then continues', async () => {
  const c = await campaign(3);
  answer = () => new Response('limit', { status: 429, headers: { 'retry-after': '120' } });
  for (let i = 0; i < 10; i++) await draftNext();
  assert.equal(calls.length, 1, 'no more requests while waiting');
  let all = await db.email.findMany({ where: { campaignId: c.id } });
  assert.ok(all.every((e) => e.status === 'PENDING' && e.attempts === 0));
  const waiting = all.find((e) => e.notBefore)!;
  assert.ok(Math.abs(waiting.notBefore!.getTime() - Date.now() - 120_000) < 5000);
  clearAiWait();
  await db.email.updateMany({ data: { notBefore: null } });
  answer = () => ok(MAIL);
  while (await draftNext());
  all = await db.email.findMany({ where: { campaignId: c.id } });
  assert.ok(all.every((e) => e.status === 'DRAFT'));
});

test('a wrong key stops with the reason', async () => {
  const c = await campaign(1);
  answer = () => new Response('no', { status: 401 });
  await draftNext();
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(e.status, 'GEN_FAILED');
  assert.match(e.error ?? '', /key was not accepted/);
});

test('an answer in the wrong form is tried again, then given to a person', async () => {
  const c = await campaign(1);
  answer = () => ok({ nothing: 1 });
  for (let i = 0; i < 3; i++) {
    await draftNext();
    await db.email.updateMany({ data: { notBefore: null } });
  }
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(e.status, 'GEN_FAILED');
  assert.equal(calls.length, 3);
});

test('an invented claim is sent back; if it cannot be cut out either, the email is held for a person', async () => {
  const c = await campaign(1);
  let n = 0;
  answer = (b) => ok(isRepair(b) ? { hook: MAIL.hook, body: MAIL.body } : MAIL);
  verdict = () => (n++ < 2 ? ['I would like to study signals'] : []);
  await draftNext();
  let [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /I would like to study signals/);
  assert.equal((e.flags as any[]).some((f) => f.code === 'unsupported'), false);

  await db.email.update({ where: { id: e.id }, data: { status: 'PENDING' } });
  verdict = () => ['I would like to study signals'];
  calls = [];
  await draftNext();
  [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(calls.length, 3, 'two repairs, then a person');
  assert.equal(e.status, 'DRAFT');
  assert.ok((e.flags as any[]).some((f) => f.code === 'unsupported' && f.level === 'block'));
});

test('a short limit in the middle of an email is waited for; nothing is written twice', async () => {
  const c = await campaign(1);
  let limited = 0;
  answer = () => ok(MAIL);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    if (isCheck(JSON.parse(init.body)) && limited++ === 0) return new Response('limit', { status: 429, headers: { 'retry-after': '1' } });
    return inner(u, init);
  }) as any;
  await draftNext();
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(e.status, 'DRAFT');
  assert.equal(calls.length, 1);
});

test('a claim that is not in the email is the checker\u2019s mistake, and only the big model decides', async () => {
  const c = await campaign(1);
  answer = () => ok(MAIL);
  verdict = () => ['AutoCAD Civil 3D'];
  await draftNext();
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(calls.length, 1);
  assert.equal((e.flags as any[]).length, 0);
  await db.email.update({ where: { id: e.id }, data: { status: 'PENDING' } });
  checks = [];
  let n = 0;
  verdict = () => (n++ === 0 ? ['I would like to study signals'] : []);
  await draftNext();
  assert.deepEqual(checks.map((x) => x.model), ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  assert.equal(((await db.email.findUniqueOrThrow({ where: { id: e.id } })).flags as any[]).length, 0);
});

test('a usage limit in the middle of a Profile loses no batch; invented facts are dropped', async () => {
  const s = await db.student.create({ data: { fullName: 'P', email: 'p@gmail.com', isDemo: true } });
  const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i}: the thesis tested asphalt mixtures with recycled plastic in the laboratory for one year.`).join('\n');
  const p = await db.studentProfile.create({ data: { studentId: s.id, version: 1, fileName: 'p', sizeBytes: 1, content: new Uint8Array(1), text } });
  const facts = (research: string[]) => ok({ education: [], research, experience: [], publications: [], proposedResearch: [], skills: [], tests: [], goal: [] });
  let n = 0;
  answer = () => (++n === 2 ? new Response('limit', { status: 429, headers: { 'retry-after': '600' } }) : facts(['The thesis tested asphalt mixtures with recycled plastic in the laboratory', 'Won a national award in robotics in 1987', ...Array.from({ length: 4 }, (_, i) => `Sentence ${i}: the thesis tested asphalt mixtures with recycled plastic`)]));
  await profileNext();
  await profileNext();
  let r = await db.studentProfile.findUniqueOrThrow({ where: { id: p.id } });
  assert.equal((r.parts as any[]).length, 1);
  assert.equal(r.status, 'PENDING');
  assert.equal(await profileNext(), false, 'waits');
  clearAiWait();
  await db.studentProfile.updateMany({ data: { notBefore: null } });
  while (await profileNext());
  r = await db.studentProfile.findUniqueOrThrow({ where: { id: p.id } });
  assert.equal(r.status, 'READY', r.error ?? '');
  assert.match(r.brief!, /recycled plastic/);
  assert.doesNotMatch(r.brief!, /robotics/);
  assert.ok(calls.every((c) => JSON.stringify(c).length < 16_000), 'every request stays small');
});

test('an email that repeats an example is corrected', async () => {
  const c = await campaign(1);
  const { PDF_RULES } = await import('../../src/lib/prompt');
  const copy = PDF_RULES.examples.split(/\n-{3,}\n/)[1];
  answer = (b) => ok(isRepair(b) ? { hook: MAIL.hook, body: MAIL.body } : { ...MAIL, body: copy });
  await draftNext();
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /repeats sentences of an example/);
  assert.doesNotMatch(e.body, /wind and battery/);
});

test('a claim the AI will not give up is cut out, and the email goes on', async () => {
  const c = await campaign(1);
  const bad = { ...MAIL, body: MAIL.body.replace('\n\nI hope', ' I led a team of twelve engineers at a bank.\n\nI hope') };
  answer = (b) => ok(isRepair(b) ? { hook: MAIL.hook, body: bad.body } : bad);
  verdict = () => ['I led a team of twelve engineers'];
  await draftNext();
  const [e] = await db.email.findMany({ where: { campaignId: c.id } });
  assert.doesNotMatch(e.body, /twelve engineers/);
  assert.match(e.body, /CV is attached/);
  assert.equal((e.flags as any[]).some((f) => f.level === 'block'), false);
  assert.ok((e.flags as any[]).some((f) => f.code === 'cut'));
});

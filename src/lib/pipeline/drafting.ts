import crypto from 'node:crypto';
import type { Professor } from '@prisma/client';
import { z } from 'zod';
import { db, stops } from '../db';
import { env, ownTestAddress } from '../env';
import { aiWaiting, assertMayProcess, LlmError, llmJson, objectSchema } from '../llm';
import { blocked, checkEmail, checkRules, claimRemains, cutSentences, planAsDone, coreText, composeBody, lastName, similarity, SUBJECT_PREFIX, tidy, type Flag } from '../checks';
import { REPAIR_PROMPT, systemPrompt, VERIFY_PROMPT, writingRules } from '../prompt';
import { findPapers, type Paper } from '../research';
import { scheduleOne } from './campaigns';
import { pushOne } from './sender';

const Reply = z.object({
  hook: z.string().min(1).max(200),
  greeting: z.string().max(200).catch(''),
  body: z.string().min(1).max(6000),
  fit: z.enum(['strong', 'some', 'weak', 'unknown']).catch('unknown'),
  fitNote: z.string().max(500).catch(''),
});

const MAX_ATTEMPTS = 3;
const SCHEMA = objectSchema({ hook: 'string', greeting: 'string', body: 'string', fit: ['strong', 'some', 'weak', 'unknown'], fitNote: 'string' });
/** Problems worth a second try by the AI. */
const REPAIR_SCHEMA = objectSchema({ hook: 'string', body: 'string' });
const VERIFY_SCHEMA = objectSchema({ unsupported: 'list' });
const RETRY = new Set(['length', 'hook_long', 'no_cv', 'no_call', 'no_funding', 'praise', 'begging', 'stock', 'like_example', 'unknown_number']);

export const loadForDraft = (id: string) =>
  db.email.findUniqueOrThrow({
    where: { id },
    include: { professor: true, student: { include: { mailbox: true, profiles: { where: { status: 'READY' }, orderBy: { version: 'desc' }, take: 1, select: { brief: true, text: true } } } }, campaign: { include: { list: { include: { professors: { select: { id: true, name: true, university: true } } } } } } },
  });
type Loaded = Awaited<ReturnType<typeof loadForDraft>>;

/** What the AI may say about the student: the brief from the Profile PDF, and staff's notes. */
export const aboutStudent = (s: { notes: string | null; profiles: { brief: string | null }[] }) => [s.profiles[0]?.brief, s.notes && `Notes from staff:\n${s.notes}`].filter(Boolean).join('\n\n');

export const papersOf = (p: Pick<Professor, 'papers'>): Paper[] => (Array.isArray(p.papers) ? (p.papers as unknown as Paper[]) : []);

/** Looks a professor's papers up once; the same address in another list reuses them. Never fatal. */
export async function ensurePapers(p: Professor): Promise<Professor> {
  if (env().RESEARCH === 'off') return p;
  const recent = new Date(Date.now() - 90 * 86_400_000);
  if (p.papersAt && p.papersAt > recent) return p;
  const known = await db.professor.findFirst({ where: { email: p.email, name: p.name, university: p.university, papersAt: { gt: recent } } });
  const papers = known ? papersOf(known) : await findPapers(p);
  if (papers === null) return p; // not reachable now: looked up again next time
  return db.professor.update({ where: { id: p.id }, data: { papers: papers as any, papersAt: new Date() } });
}

/** Checks any text (the AI's, or an edit by staff) against the student text, the list and the writing rules. */
export function checkDraft(e: Loaded, subject: string, body: string): Flag[] {
  const others = e.campaign.list.professors.filter((p) => p.id !== e.professorId);
  const p = e.professor;
  const papers = papersOf(p);
  const flags = checkEmail({
    subject,
    body,
    studentName: e.student.fullName,
    professor: p,
    otherNames: others.map((o) => o.name),
    otherUniversities: [...new Set(others.map((o) => o.university).filter((u): u is string => !!u))],
    facts: [e.student.fullName, e.student.email, e.student.phone, e.student.notes, e.student.profiles[0]?.brief, e.student.profiles[0]?.text, e.campaign.intake, e.campaign.instructions, p.name, p.university, p.department, p.researchArea, p.country, p.notes, ...papers.map((x) => `${x.title} ${x.year} ${x.venue}`), '10 15 20'].filter(Boolean).join('\n'),
  });
  flags.push(...checkRules({ subject, body, email: e.student.email, phone: e.student.phone, toEmail: e.toEmail }).filter((f) => !(f.code === 'unverified_address' && ownTestAddress(e.toEmail))));
  for (const s of planAsDone(body, aboutStudent(e.student))) flags.push({ code: 'plan_as_done', level: 'block', text: `This is planned, not done yet: "${s.trim().slice(0, 180)}"` });
  if (env().RESEARCH !== 'off' && !papers.length) flags.push({ code: 'no_research', level: 'warn', text: 'No certain papers were found for this professor: the email uses only the list.' });
  return flags;
}

const paperLines = (p: Professor) => papersOf(p).slice(0, 5).map((x, i) => `${x.title} (${x.year}${x.venue ? `, ${x.venue}` : ''})${x.abstract && i < 3 ? `. Abstract: ${x.abstract}` : ''}`);

/** Asks the AI, as a strict reader, which claims are not in the student text or the professor's data. */
export async function unsupported(e: Loaded, body: string): Promise<string[]> {
  // the small model looks first and misses little; the big one is asked only when something is suspected
  const suspects = await readClaims(e, body, true);
  return suspects.length ? readClaims(e, body, false, suspects) : [];
}

const bare = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

async function readClaims(e: Loaded, body: string, check: boolean, suspects: string[] = []): Promise<string[]> {
  const list = suspects.length ? ['', '', 'SUSPECTED:', ...suspects.map((x) => `- ${x}`)].join('\n') : '';
  const p = e.professor;
  const raw = await llmJson({
    operation: 'email_verify',
    check,
    system: VERIFY_PROMPT,
    temperature: 0,
    schema: VERIFY_SCHEMA,
    prompt: `STUDENT:\n${JSON.stringify({ name: e.student.fullName, about: aboutStudent(e.student), intake: e.campaign.intake, staffNote: e.campaign.instructions })}\n\nPROFESSOR:\n${JSON.stringify({ name: p.name, university: p.university, department: p.department, researchArea: p.researchArea, notes: p.notes, papers: paperLines(p) })}\n\nEMAIL:\n${coreText(body)}${list}`,
    mock: () => ({ unsupported: [] }),
  });
  const r = z.object({ unsupported: z.array(z.string()) }).safeParse(raw);
  if (!r.success) throw new LlmError('The AI did not answer in the expected form.', true);
  // a claim that is not in the email is the checker's own mistake
  const there = new Set(bare(coreText(body)));
  const inEmail = (s: string) => {
    const w = bare(s);
    return w.length >= 2 && w.filter((x) => there.has(x)).length / w.length >= 0.75;
  };
  return r.data.unsupported.map((s) => s.trim().slice(0, 200)).filter(inEmail).slice(0, 6);
}

const claimFlags = (claims: string[]): Flag[] => claims.map((c) => ({ code: 'unsupported', level: 'block', text: `Not in the student text or the professor\u2019s data: "${c}"` }));

async function write(e: Loaded, system: string) {
  const p = e.professor;
  const papers = paperLines(p);
  const raw = await llmJson({
    operation: 'email_draft',
    system,
    temperature: 0.5,
    maxOutputTokens: 2000,
    schema: SCHEMA,
    prompt: [
      `STUDENT:\n${JSON.stringify({ name: e.student.fullName, about: aboutStudent(e.student) }, null, 1)}`,
      `INTAKE: ${e.campaign.intake || 'not given'}`,
      e.campaign.instructions ? `STAFF NOTE: ${e.campaign.instructions}` : '',
      `PROFESSOR:\n${JSON.stringify({ name: p.name, university: p.university, department: p.department, researchArea: p.researchArea, country: p.country, notes: p.notes, papers: papers.length ? papers : 'none found' }, null, 1)}`,
    ].filter(Boolean).join('\n\n'),
    mock: () => mockDraft(e),
  });
  const r = Reply.safeParse(raw);
  if (!r.success) throw new LlmError('The AI did not answer in the expected form.', true);
  return { ...compose(e, r.data.hook, r.data.greeting, r.data.body), fit: r.data.fit, fitNote: r.data.fitNote };
}

function compose(e: Loaded, rawHook: string, greeting: string, body: string) {
  const hook = tidy(rawHook).replace(/^prospective phd researcher\s*\|\s*/i, '').replace(/^["'“]+|["'”.]+$/g, '').replace(/\s+/g, ' ').trim();
  return {
    subject: `${SUBJECT_PREFIX}${hook}`,
    body: composeBody({ greeting: greeting || `Dear Professor ${lastName(e.professor.name)},`, body, name: e.student.fullName, email: e.student.email, phone: e.student.phone, signature: e.student.signature }),
  };
}

async function repair(e: Loaded, d: { subject: string; body: string }, problems: string[]) {
  const p = e.professor;
  const hook = d.subject.slice(SUBJECT_PREFIX.length);
  const raw = await llmJson({
    operation: 'email_repair',
    system: REPAIR_PROMPT,
    temperature: 0.2,
    schema: REPAIR_SCHEMA,
    prompt: `STUDENT:\n${JSON.stringify({ name: e.student.fullName, about: aboutStudent(e.student), intake: e.campaign.intake })}\n\nPROFESSOR:\n${JSON.stringify({ name: p.name, university: p.university, researchArea: p.researchArea, papers: paperLines(p) })}\n\nHOOK: ${hook}\n\nBODY:\n${coreText(d.body)}\n\nPROBLEMS:\n${problems.map((x) => `- ${x}`).join('\n')}`,
    mock: () => ({ hook, body: coreText(d.body) }),
  });
  const r = z.object({ hook: z.string().min(1).max(200), body: z.string().min(1).max(6000) }).safeParse(raw);
  if (!r.success) throw new LlmError('The AI did not answer in the expected form.', true);
  return compose(e, r.data.hook, d.body.split('\n', 1)[0], r.data.body);
}

const score = (flags: Flag[]) => flags.reduce((n, f) => n + (f.level === 'block' && f.code !== 'unverified_address' ? 10 : RETRY.has(f.code) ? 1 : 0), 0);

/** Takes one email waiting to be written. Returns false when there is none. */
export async function draftNext(): Promise<boolean> {
  if (aiWaiting()) return false;
  const claim = crypto.randomUUID();
  const rows = await db.$queryRaw<{ id: string; attempts: number }[]>`
    UPDATE "Email" SET status = 'GENERATING', "claimToken" = ${claim}, "claimedAt" = now(), attempts = attempts + 1, "updatedAt" = now()
    WHERE id = (
      SELECT e.id FROM "Email" e
      JOIN "Campaign" c ON c.id = e."campaignId" JOIN "Professor" p ON p.id = e."professorId"
      WHERE NOT c.paused AND c.status IN ('GENERATING', 'REVIEW', 'ACTIVE')
        AND ((e.status = 'PENDING' AND (e."notBefore" IS NULL OR e."notBefore" <= now()))
          OR (e.status = 'GENERATING' AND e."claimedAt" < now() - interval '30 minutes'))
      ORDER BY p."rowNumber", e."createdAt", e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
    RETURNING id, attempts`;
  if (!rows.length) return false;
  const { id, attempts } = rows[0];
  const mine = { id, claimToken: claim, status: 'GENERATING' as const };
  const e = await loadForDraft(id);
  try {
    assertMayProcess(e.student);
    const step = (s: string) => db.email.updateMany({ where: mine, data: { step: s } });
    await step('Reading the professor\u2019s papers');
    e.professor = await ensurePapers(e.professor);
    await step('Writing');
    const rules = await writingRules();
    const system = systemPrompt(rules);
    const examples = rules.examples.split(/\n-{3,}\n/).filter((x) => x.trim().length > 200);
    const like = (body: string): Flag[] => (examples.some((x) => similarity(x, coreText(body)) > 0.12) ? [{ code: 'like_example', level: 'warn', text: 'It repeats sentences of an example email: say them in other words.' }] : []);
    let d = await write(e, system);
    await step('Checking every claim');
    let flags = [...checkDraft(e, d.subject, d.body), ...like(d.body), ...claimFlags(await unsupported(e, d.body))];
    // one repair for small things, up to three when something must not be sent
    for (let round = 0; round < (score(flags) >= 10 ? 2 : 1) && score(flags); round++) {
      await step('Correcting');
      const next = await repair(e, d, flags.filter((f) => f.code !== 'unverified_address' && f.code !== 'no_research').map((f) => f.text));
      const f2 = [...checkDraft(e, next.subject, next.body), ...like(next.body), ...claimFlags(await unsupported(e, next.body))];
      if (score(f2) <= score(flags)) {
        d = { ...d, ...next };
        flags = f2;
      }
    }
    // what still must not be said is taken out, sentence by sentence; only code decides, nothing is rewritten
    const shorter = blocked(flags) ? cutSentences(d.body, flags) : null;
    if (shorter) {
      const kept = flags.filter((f) => f.code === 'unsupported' && claimRemains(shorter, f));
      const f3 = [...checkDraft(e, d.subject, shorter), ...like(shorter), ...kept];
      if (!blocked(f3.filter((f) => f.code !== 'unverified_address'))) {
        d = { ...d, body: shorter };
        flags = [...f3, { code: 'cut', level: 'warn', text: 'A sentence that could not be proved was taken out.' }];
      }
    }
    const others = await db.email.findMany({
      where: { toEmail: e.toEmail, studentId: { not: e.studentId }, status: { in: ['SCHEDULED', 'SENDING', 'SENT', 'BOUNCED'] } },
      select: { student: { select: { fullName: true } } },
      take: 3,
    });
    if (others.length) flags.push({ code: 'also_contacted', level: 'warn', text: `Also contacted for ${others.map((o) => o.student.fullName).join(', ')}.` });
    await db.email.updateMany({
      where: mine,
      data: { status: 'DRAFT', subject: d.subject, body: d.body, fit: d.fit, fitNote: d.fitNote, flags: flags as any, claimToken: null, step: null, error: null, attempts: 0, notBefore: null, contentVersion: { increment: 1 } },
    });
    // the whole way for this professor before the next one: send time, then the draft in Gmail
    if (e.campaign.autoSchedule && !blocked(flags) && e.student.mailbox?.status === 'CONNECTED' && (await scheduleOne(id))) {
      const st = await stops();
      if (!st.sending) await pushOne(id);
    }
  } catch (err: any) {
    // a usage limit is not the email's fault: it waits and does not count as a failed try
    const wait = err instanceof LlmError ? err.waitMs : undefined;
    const again = wait !== undefined || (!(err instanceof LlmError && !err.retryable) && attempts < MAX_ATTEMPTS);
    await db.email.updateMany({
      where: mine,
      data: { status: again ? 'PENDING' : 'GEN_FAILED', claimToken: null, step: null, error: String(err?.message ?? err).slice(0, 500), notBefore: again ? new Date(Date.now() + (wait ?? 20_000 * 2 ** attempts)) : null, ...(wait !== undefined ? { attempts: { decrement: 1 } } : {}) },
    });
  }
  await finishGeneration(e.campaignId);
  return true;
}

/** When the last email is written: look for texts that are too alike, then open the campaign for review. */
export async function finishGeneration(campaignId: string) {
  const left = await db.email.count({ where: { campaignId, status: { in: ['PENDING', 'GENERATING'] } } });
  if (left) return;
  const moved = await db.campaign.updateMany({ where: { id: campaignId, status: 'GENERATING' }, data: { status: 'REVIEW' } });
  if (!moved.count) return;
  const drafts = await db.email.findMany({ where: { campaignId, status: 'DRAFT' }, select: { id: true, body: true, flags: true } });
  const alike = new Set<string>();
  for (let a = 0; a < drafts.length; a++) for (let b = a + 1; b < drafts.length; b++) if (similarity(drafts[a].body, drafts[b].body) > 0.6) alike.add(drafts[a].id).add(drafts[b].id);
  for (const d of drafts) {
    if (!alike.has(d.id)) continue;
    const flags = [...(d.flags as unknown as Flag[]).filter((f) => f.code !== 'alike'), { code: 'alike', level: 'warn', text: 'Very similar to another email in this campaign.' }];
    await db.email.update({ where: { id: d.id }, data: { flags: flags as any } });
  }
}

/** Fixed text for development without an AI key. */
function mockDraft(e: Loaded) {
  const p = e.professor;
  const area = p.researchArea;
  const about = aboutStudent(e.student).replace(/\s+/g, ' ').slice(0, 260);
  return {
    hook: area ? area.split(/[\s,]+/).slice(0, 5).join(' ') : 'Graduate Research',
    greeting: `Dear Professor ${lastName(p.name)},`,
    body: `${area ? `Your work on ${area} is close to the direction I hope to follow, and I would like to learn how your group approaches its main questions.` : 'I would like to learn more about the research carried out in your department and whether my background could be useful there.'}

${about}

During my studies I have learned to plan a project carefully, to read the literature critically and to report results honestly, including the results that did not work. I believe these habits would let me contribute to a research group from an early stage while I continue to learn from its members, and I would be glad to take part in the routine work of the group as well as in its larger questions.

I would be grateful to know whether there may be a funded position or project in your group${e.campaign.intake ? ` for ${e.campaign.intake}` : ''} where I could be useful. I have attached my CV. If it suits you, a brief call of 10 to 20 minutes would help me understand how I could best contribute to your current plans.`,
    fit: area ? 'some' : 'unknown',
    fitNote: area ? 'Mock text: no real matching was done.' : 'The list gives no research area.',
  };
}

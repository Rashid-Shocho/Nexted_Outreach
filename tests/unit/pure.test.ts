import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { DateTime } from 'luxon';
import { stampOf } from '../../src/lib/stamp';
import { reach } from '../../src/lib/reach';
import { PDF_RULES } from '../../src/lib/prompt';
import { batches, phoneIn, scrub, supported } from '../../src/lib/pipeline/profile';
import { allocateSlots, dayKey, insideWindow, nextSlot, planProblems, type SchedulePlan, slowCap } from '../../src/lib/schedule';
import { checkRows, cleanPerson, firstEmail, guessMapping, normaliseEmail, parseCsv, readSheet, splitPlace } from '../../src/lib/excel';
import { blocked, checkEmail, checkRules, claimRemains, composeBody, cutSentences, planAsDone, lastName, similarity, tidy, type CheckInput } from '../../src/lib/checks';
import { readGoogleSheet, sheetRef } from '../../src/lib/gsheet';
import { isAuthor, pickPapers, placeWords } from '../../src/lib/research';
import { addressOf, buildMime, classify, toHtml, toPlain, encodeHeader, htmlToText, nameOf, parseGmailMessage, resolveRecipient, quotedPrintable } from '../../src/lib/mail/mime';
import { parseEnv, safetyProblems, sandboxAllow } from '../../src/lib/env';

const plan: SchedulePlan = { startDate: '2026-11-30', windowStart: '19:30', windowEnd: '20:30', timezone: 'Asia/Dhaka', minPerDay: 15, maxPerDay: 20, weekdays: [1, 2, 3, 4, 5] };
const dhaka = (s: string) => DateTime.fromISO(s, { zone: 'Asia/Dhaka' }).toJSDate();

test('250 emails: every time is in the window, on a weekday, 15 to 20 per day, spaced', () => {
  const slots = allocateSlots(250, plan, { now: dhaka('2026-11-23T10:00') });
  assert.equal(slots.length, 250);
  const days = new Map<string, Date[]>();
  for (const s of slots) {
    assert.ok(insideWindow(s, plan), s.toISOString());
    const k = dayKey(s, plan.timezone);
    days.set(k, [...(days.get(k) ?? []), s]);
  }
  const sizes = [...days.values()].map((d) => d.length);
  assert.ok(sizes.slice(0, -1).every((n) => n >= 15 && n <= 20), sizes.join());
  assert.ok(sizes.length >= 13 && sizes.length <= 17);
  for (const d of days.values()) for (let i = 1; i < d.length; i++) assert.ok(d[i].getTime() - d[i - 1].getTime() >= 30_000);
  assert.equal([...days.keys()][0], '2026-11-30');
  // 19:30 in Dhaka is 13:30 UTC
  assert.ok(slots.every((s) => s.getUTCHours() === 13 || s.getUTCHours() === 14));
});

test('another campaign of the same student shares the daily limit', () => {
  const used = new Map([['2026-11-30', 18], ['2026-12-01', 20]]);
  const slots = allocateSlots(10, plan, { now: dhaka('2026-11-23T10:00'), used, rng: () => 0.999 });
  const per = (k: string) => slots.filter((s) => dayKey(s, plan.timezone) === k).length;
  assert.equal(per('2026-11-30'), 2);
  assert.equal(per('2026-12-01'), 0);
  assert.equal(per('2026-12-02'), 8);
});

test('approving during or after the window does not squeeze a full day into what is left', () => {
  const late = allocateSlots(20, plan, { now: dhaka('2026-11-30T20:15'), rng: () => 0.5 });
  const today = late.filter((s) => dayKey(s, plan.timezone) === '2026-11-30');
  assert.ok(today.length <= 5, String(today.length));
  assert.ok(today.every((s) => s > dhaka('2026-11-30T20:15') && s < dhaka('2026-11-30T20:30')));
  assert.equal(dayKey(allocateSlots(1, plan, { now: dhaka('2026-11-30T21:00') })[0], plan.timezone), '2026-12-01');
  assert.equal(dayKey(allocateSlots(1, plan, { now: dhaka('2026-12-04T21:00') })[0], plan.timezone), '2026-12-07', 'skips the weekend');
});

test('bad schedules are refused', () => {
  assert.ok(planProblems({ ...plan, windowEnd: '19:00' }).length);
  assert.ok(planProblems({ ...plan, windowStart: '17:20', windowEnd: '17:22' }).length, 'two minutes');
  assert.equal(planProblems({ ...plan, windowStart: '17:20', windowEnd: '17:30' }).length, 0);
  assert.ok(planProblems({ ...plan, minPerDay: 30 }).length);
  assert.ok(planProblems({ ...plan, weekdays: [] }).length);
  assert.ok(planProblems({ ...plan, timezone: 'Nowhere/City' }).length);
  assert.ok(planProblems({ ...plan, startDate: '2026-13-40' }).length);
  assert.equal(planProblems(plan).length, 0);
});

test('Excel: finds the heading row, links, rich text, and bad rows', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Cover').addRow(['hello']);
  const ws = wb.addWorksheet('List');
  ws.addRow(['My professors']);
  ws.addRow(['SL', 'Professor Name', 'E-mail', 'Institution', 'Research Interest']);
  ws.addRow([1, 'Dr. Ana Silva', { text: 'ana@uni.edu', hyperlink: 'mailto:ana@uni.edu' }, 'Uni', 'optics']);
  ws.addRow([2, { richText: [{ text: 'Bo ' }, { text: 'Li' }] }, ' Bo.Li@Uni.EDU ', 'Uni', '']);
  ws.addRow([3, 'Copy', 'ana@uni.edu', 'Uni', 'x']);
  ws.addRow([4, 'Bad', 'bad at uni', 'Uni', 'x']);
  ws.addRow([5, '', 'noname@uni.edu', 'Uni', 'x']);
  ws.addRow([6, 'Known', 'known@uni.edu', 'Uni', 'x']);
  const s = await readSheet('a.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
  const map = guessMapping(s.headers);
  assert.deepEqual(map, { email: 2, researchArea: 4, university: 3, name: 1 });
  const rows = checkRows(s.rows, map, { sameStudent: new Set(['known@uni.edu']), otherStudents: new Map([['bo.li@uni.edu', ['Other']]]) });
  assert.deepEqual(rows.map((r) => r.errors.length), [0, 0, 1, 1, 1, 1]);
  assert.equal(rows[1].email, 'bo.li@uni.edu');
  assert.equal(rows[1].values.name, 'Bo Li');
  assert.equal(rows[1].warnings.length, 2);
  await assert.rejects(readSheet('x.xlsx', Buffer.from('nope')));
  await assert.rejects(readSheet('x.xls', Buffer.from('nope')));
  await assert.rejects(readSheet('x.csv', Buffer.from('a,b\n1,2')));
});

test('CSV with quotes, and email cleaning', () => {
  assert.deepEqual(parseCsv('name,email\r\n"Li, Bo","a""b"\r\n'), [['name', 'email'], ['Li, Bo', 'a"b']]);
  assert.deepEqual(parseCsv('name;email\nA;b@c.de'), [['name', 'email'], ['A', 'b@c.de']]);
  assert.equal(normaliseEmail('<A.B@Uni.edu>,'), 'a.b@uni.edu');
  for (const bad of ['a@b', 'a b@c.de', 'a@b.de, c@d.de', 'a@@b.de', '', 'x@-a.de', '.a@b.de']) assert.equal(normaliseEmail(bad), null, bad);
});

const base: CheckInput = {
  subject: 'PhD enquiry',
  studentName: 'Ayesha Rahman',
  professor: { name: 'Prof. John A. Smith', university: 'Alpha University', researchArea: 'optics' },
  otherNames: ['Dr. Mary Jones', 'John Smithson'],
  otherUniversities: ['Beta University', 'University of Gamma'],
  facts: 'Ayesha Rahman CGPA 3.72 IELTS 7.5 2024 "A study of small lasers in practice" Alpha University optics',
  body: `Dear Professor Smith,\n\n${'I am interested in optics and I would like to study with you because my work fits. '.repeat(7)}My CGPA is 3.72.\n\nKind regards,\nAyesha Rahman`,
};
const codes = (o: Partial<CheckInput>) => checkEmail({ ...base, ...o }).map((f) => f.code);

test('a correct email passes; wrong ones are stopped', () => {
  assert.deepEqual(codes({}), []);
  assert.ok(codes({ body: base.body.replace('Smith', 'Miller') }).includes('professor_name'));
  assert.ok(codes({ body: base.body.replace('my work fits', 'Mary Jones told me') }).includes('other_professor'));
  assert.ok(codes({ body: base.body.replace('my work fits', 'I like Beta University') }).includes('other_university'));
  assert.ok(codes({ body: base.body.replace('my work fits', '[insert topic]') }).includes('placeholder'));
  assert.ok(codes({ body: base.body.replace('Ayesha Rahman', '') }).includes('student_name'));
  assert.ok(codes({ body: base.body.replace('my work fits', 'of "A paper that does not exist at all"') }).includes('unknown_title'));
  assert.ok(!codes({ body: base.body.replace('my work fits', 'of "A study of small lasers in practice"') }).includes('unknown_title'));
  assert.ok(codes({ body: base.body.replace('3.72', '3.95') }).includes('unknown_number'));
  assert.ok(codes({ subject: 'a\nBcc: x@y.zz' }).includes('subject_lines'));
  assert.equal(blocked(checkEmail({ ...base, subject: '' })), true);
});

test('family names', () => {
  assert.equal(lastName('Prof. Dr. Maria García'), 'García');
  assert.equal(lastName('Smith, John'), 'Smith');
  assert.equal(lastName('Associate Professor Wei Zhang (EE)'), 'Zhang');
  assert.ok(codes({ professor: { name: 'Prof. María García' }, body: base.body.replace('Smith', 'Garcia') }).length === 0);
});

test('similar texts are recognised', () => {
  assert.ok(similarity(base.body, base.body) === 1);
  assert.ok(similarity(base.body, 'A completely different text about another thing entirely, with nothing the same.') < 0.1);
});

test('messages: header injection is impossible, long subjects and names survive, attachments decode', () => {
  const m = buildMime('me@gmail.com', { fromName: 'Eve"\r\nBcc: a@b.cc', to: 'p@uni.edu', subject: 'Hi\r\nBcc: x@y.zz', body: 'a\nb', attachments: [{ fileName: 'CV_Zoë.pdf', mimeType: 'application/pdf', bytes: Buffer.from('PDF!') }] });
  const head = m.split('\r\n\r\n')[0];
  assert.ok(!/^bcc:/im.test(head), head);
  assert.ok(m.includes(Buffer.from('PDF!').toString('base64')));
  assert.ok(m.includes("filename*=UTF-8''CV_Zo%C3%AB.pdf"));
  assert.throws(() => buildMime('me@gmail.com', { to: 'a@b.cc, c@d.ee', subject: 's', body: 'b' }));
  assert.throws(() => buildMime('me@gmail.com', { to: 'a@b.cc\r\nBcc: z@z.zz', subject: 's', body: 'b' }));
  const long = 'Prüfung '.repeat(30).trim();
  const enc = encodeHeader(long);
  assert.ok(enc.split('\r\n ').every((l) => l.length <= 75));
  assert.equal(enc.split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), long);
});

test('reading messages', () => {
  assert.equal(addressOf('"Smith, J" <J@Uni.edu>'), 'j@uni.edu');
  assert.equal(nameOf('"Smith, J" <J@Uni.edu>'), 'Smith, J');
  assert.equal(htmlToText('<style>x{}</style><p>Hi&nbsp;<b>you</b></p><script>alert(1)</script><p>&#8364;5</p>'), 'Hi you\n€5');
  const p = parseGmailMessage({ id: '1', threadId: 't', labelIds: ['INBOX'], internalDate: '1000', snippet: 'a &amp; b', payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'x@y.zz' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hallo').toString('base64url') } }, { mimeType: 'application/pdf', filename: 'a.pdf', body: { attachmentId: 'A', size: 10 } }] } });
  assert.equal(p.body, 'Hallo');
  assert.equal(p.snippet, 'a & b');
  assert.equal(p.attachments.length, 1);
});

test('kinds of incoming mail', () => {
  const m = (from: string, subject: string, headers = {}) => ({ headers: { from, subject, ...headers }, snippet: '', body: '' });
  assert.equal(classify(m('p@uni.edu', 'Re: hello'), true), 'PROFESSOR');
  assert.equal(classify(m('p@uni.edu', 'Re: hello', { 'auto-submitted': 'no' }), true), 'PROFESSOR');
  assert.equal(classify(m('p@uni.edu', 'Automatic reply: hello'), true), 'AUTO_REPLY');
  assert.equal(classify(m('p@uni.edu', 'x', { 'auto-submitted': 'auto-replied' }), true), 'AUTO_REPLY');
  assert.equal(classify(m('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'x'), false), 'BOUNCE');
  assert.equal(classify(m('bank@bank.com', 'code'), false), 'OTHER');
});

test('the sandbox rewrites every recipient and refuses to run half set', () => {
  assert.deepEqual(resolveRecipient('p@uni.edu', 'S', { sandbox: true, sandboxTo: 't@t.tt' }), { to: 't@t.tt', subject: '[SANDBOX to p@uni.edu] S', sandboxed: true });
  assert.throws(() => resolveRecipient('p@uni.edu', 'S', { sandbox: true }));
});

test('unsafe settings stop the app', () => {
  const ok = { DATABASE_URL: 'x', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), EMAIL_SANDBOX_TO: 't@t.tt' };
  const problems = (o: Record<string, string>) => safetyProblems(parseEnv({ ...ok, ...o } as any)).length;
  assert.equal(problems({}), 0);
  assert.ok(problems({ EMAIL_SANDBOX: 'false' }));
  assert.equal(problems({ EMAIL_SANDBOX: 'false', EMAIL_REAL_LOCAL: 'true' }), 0);
  assert.ok(problems({ EMAIL_SANDBOX: 'false', EMAIL_REAL_LOCAL: 'true', EMAIL_SANDBOX_TO: '' }));
  assert.ok(problems({ EMAIL_SANDBOX_TO: '' }));
  assert.ok(problems({ APP_ENV: 'production', APP_URL: 'https://x.yy' }), 'fake mail and mock AI in production');
  assert.ok(problems({ EMAIL_TRANSPORT: 'gmail' }));
  assert.ok(problems({ TOKEN_ENCRYPTION_KEY: 'short' }));
  assert.equal(problems({ APP_ENV: 'production', APP_URL: 'https://x.yy', EMAIL_SANDBOX: 'false', EMAIL_TRANSPORT: 'gmail', GMAIL_OAUTH_CLIENT_ID: 'a', GMAIL_OAUTH_CLIENT_SECRET: 'b', LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'a', OPENAI_MODEL: 'b' }), 0);
});

test('the closing, the contact line and the greeting are ours; em dashes go away', () => {
  const b = composeBody({ greeting: 'Dear Professor Li', body: 'Dear Professor Li,\n\nHello \u2014 I read 10\u201320 papers.\n\nBest regards,\nSomebody Else', name: 'A B', email: 'a@b.cc', phone: '+88 1' });
  assert.equal(b, 'Dear Professor Li,\n\nHello, I read 10 to 20 papers.\n\nKind regards,\nA B\nEmail: a@b.cc | Phone: +88 1');
  assert.equal(tidy('a \u2013 b, well\u2011known'), 'a, b, well-known');
});

test('the rules of the NextED reference', () => {
  const good = `${'We study roads and bitumen with care and write it down. '.repeat(13)}I wonder whether a funded position may open. My CV is attached. Could we talk for 15 minutes?`;
  const run = (o: Partial<Parameters<typeof checkRules>[0]> & { core?: string }) =>
    checkRules({ subject: 'Prospective PhD Researcher | Bitumen Fatigue', email: 'a@b.cc', phone: '+88 1', toEmail: 'p@uni.edu', body: composeBody({ greeting: 'Dear Professor Li', body: o.core ?? good, name: 'A B', email: 'a@b.cc', phone: '+88 1' }), ...o }).map((f) => f.code);
  assert.deepEqual(run({}), []);
  assert.deepEqual(run({ subject: 'PhD enquiry' }), ['subject_form']);
  assert.deepEqual(run({ subject: 'Prospective PhD Researcher | one two three four five six seven eight' }), ['hook_long']);
  assert.ok(run({ core: 'Short. CV attached, 15 minutes, funded.' }).includes('length'));
  assert.deepEqual(run({ core: good.replace('My CV is attached.', '') }), ['no_cv']);
  assert.deepEqual(run({ core: good.replace('for 15 minutes', 'soon') }), ['no_call']);
  assert.deepEqual(run({ core: good.replace('a funded position may open', 'you are free') }), ['no_funding']);
  assert.deepEqual(run({ core: good.replace('with care', 'with renowned care') }), ['praise']);
  assert.deepEqual(run({ core: good.replace('I wonder', 'I beg you, I wonder') }), ['begging']);
  assert.deepEqual(run({ toEmail: 'p@gmail.com' }), ['unverified_address']);
  assert.deepEqual(run({ email: 'other@b.cc' }), ['contact']);
});

test('bold and italic become HTML, everything else is shown as written', () => {
  assert.equal(toPlain('**a** and *b*, 2 * 3 * 4'), 'a and b, 2 * 3 * 4');
  assert.equal(toHtml('Hi <script>\n**b** & *c*.\n\n- x\n- y'), '<p>Hi &lt;script&gt;<br><b>b</b> &amp; <i>c</i>.</p>\n<ul><li>x</li><li>y</li></ul>');
  const m = buildMime('me@gmail.com', { to: 'p@uni.edu', subject: 's', body: 'a **b**', markup: true, attachments: [{ fileName: 'cv.pdf', mimeType: 'application/pdf', bytes: Buffer.from('x') }] });
  assert.ok(m.includes('multipart/mixed') && m.includes('multipart/alternative') && m.includes('quoted-printable\r\n\r\n<p>a <b>b</b></p>\r\n') && m.includes('quoted-printable\r\n\r\na b\r\n'));
});

test('papers count only for the same name at the same university', () => {
  const who = { name: 'Leif Eriksson', university: 'Chalmers University of Technology', researchArea: 'Radar remote sensing of sea ice' };
  const item = (given: string, family: string, aff: string, title = 'Radar observations of sea ice drift in spring', year = 2020) => ({ title: [title], DOI: `10/${title.length}${given}`, issued: { 'date-parts': [[year]] }, author: [{ given, family, affiliation: [{ name: aff }] }] });
  assert.equal(isAuthor(item('Leif E. B.', 'Eriksson', 'Chalmers University of Technology, Gothenburg'), who), true);
  assert.equal(isAuthor(item('Lars', 'Eriksson', 'Chalmers University of Technology'), who), false, 'another first name');
  assert.equal(isAuthor(item('Leif', 'Eriksson', 'Uppsala University'), who), false, 'another university');
  assert.equal(isAuthor(item('L.', 'Eriksson', 'Chalmers'), who), true, 'an initial, on the right topic');
  assert.equal(isAuthor(item('L.', 'Eriksson', 'Chalmers', 'Sufficiency strategies in residential housing'), who), false, 'an initial, on another topic');
  assert.equal(isAuthor({ author: [{ given: 'Leif', family: 'Eriksson', affiliation: [] }] }, who), false, 'no affiliation');
  assert.deepEqual(placeWords('TU Braunschweig'), ['braunschweig']);
  assert.deepEqual(placeWords('Budapest University of Technology and Economics'), ['budapest']);
  const p = pickPapers([item('Leif', 'Eriksson', 'Chalmers', 'Radar &lt;i&gt;sea&lt;/i&gt; ice drift in the Arctic', 2012), item('Leif', 'Eriksson', 'Chalmers', 'Something from long ago about radar', 2005), item('Leif', 'Eriksson', 'Chalmers', 'Correction to: Radar observations', 2021)], who);
  assert.deepEqual(p.map((x) => x.title), ['Radar sea ice drift in the Arctic']);
});

test('a raw list without headings is understood and cleaned', async () => {
  const csv = [
    '1. Prof. Martin P. Testmann,"TU Braunschweig, Germany","Pavement mechanics, asphalt technology and recycling",m.testmann@tu-bs.de,Profile,Scholar',
    '2. Priv.-Doz. Jonas Müstermann (Associate-equivalent),"TU Braunschweig, Germany","Bitumen rheology, asphalt binder testing",j.b@tu-braunschweig.de,Profile,Scholar',
    '3. Prof. Clemens Mustermann,"University of Stuttgart, Germany","Geotechnical engineering and soil mechanics",Via University contact,University,Scholar',
    'Nils Provsson — Senior Professor,"Luleå University of Technology, Sweden","Soil mechanics and frost in ground engineering",nils@ltu.se,University,Scholar',
    'Nils Provsson — Senior Professor,"Luleå University of Technology, Sweden","Soil mechanics and frost in ground engineering",nils@ltu.se,University,Scholar',
  ].join('\r\n');
  const s = await readSheet('g.csv', Buffer.from(csv));
  assert.deepEqual(s.headers, ['Professor Name', 'University', 'Research Area', 'Email', 'Column 5', 'Column 6']);
  const r = checkRows(s.rows, guessMapping(s.headers));
  assert.deepEqual(r.map((x) => x.errors.length), [0, 0, 1, 0, 1]);
  assert.deepEqual([r[0].values.name, r[0].values.university, r[0].values.country, r[0].values.notes], ['Martin P. Testmann', 'TU Braunschweig', 'Germany', 'Position: Professor']);
  assert.equal(r[1].values.notes, 'Position: Privatdozent; Associate-equivalent');
  assert.deepEqual([r[3].values.name, r[3].values.notes], ['Nils Provsson', 'Position: Senior Professor']);
  await assert.rejects(readSheet('g.csv', Buffer.from('a,b\r\nc,d')));
});

test('names, places and several addresses in one cell', () => {
  const p = (s: string) => cleanPerson(s);
  assert.deepEqual(p('31. Prof. Hasan Beispiel (Associate Dean – Research)'), { name: 'Hasan Beispiel', position: 'Professor; Associate Dean – Research' });
  assert.deepEqual(p('Univ.-Prof. Dr. Maria García'), { name: 'Maria García', position: 'Professor' });
  assert.deepEqual(p('Associate Professor Wei Zhang, PhD'), { name: 'Wei Zhang', position: 'Associate Professor' });
  assert.deepEqual(p('Anna Smith'), { name: 'Anna Smith', position: '' });
  assert.deepEqual(p('Dr. Sabine Leischner'), { name: 'Sabine Leischner', position: 'Dr.' });
  assert.deepEqual(p('Professor'), { name: 'Professor', position: '' });
  assert.deepEqual(splitPlace('University of California, Berkeley'), { university: 'University of California, Berkeley', country: '' });
  assert.deepEqual(splitPlace('University of California, Berkeley, USA'), { university: 'University of California, Berkeley', country: 'USA' });
  assert.deepEqual(splitPlace('TU Delft, The Netherlands'), { university: 'TU Delft', country: 'The Netherlands' });
  assert.deepEqual(firstEmail('a@b.cc; d@e.ff'), { email: 'a@b.cc', more: true });
  assert.deepEqual(firstEmail('Via University contact'), { email: null, more: false });
});

test('only real Google Sheets links are followed', async () => {
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.deepEqual(sheetRef(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing#gid=42`), { id, gid: '42' });
  assert.deepEqual(sheetRef(`https://docs.google.com/spreadsheets/u/1/d/${id}/edit`), { id, gid: '0' });
  for (const bad of ['', 'hello', `http://docs.google.com/spreadsheets/d/${id}/edit`, `https://evil.test/spreadsheets/d/${id}/edit`, `https://docs.google.com.evil.test/spreadsheets/d/${id}`, 'https://docs.google.com/document/d/abc', 'https://docs.google.com/spreadsheets/d/../../etc', `https://docs.google.com@evil.test/spreadsheets/d/${id}`]) {
    assert.equal(sheetRef(bad), null, bad);
    await assert.rejects(readGoogleSheet(bad), /not a Google Sheets link/);
  }
  const real = globalThis.fetch;
  const answer = (status: number, body: string, headers: Record<string, string>, url = 'https://doc-0.googleusercontent.com/x') => {
    globalThis.fetch = (async () => Object.defineProperty(new Response(body, { status, headers }), 'url', { value: url })) as any;
    return readGoogleSheet(`https://docs.google.com/spreadsheets/d/${id}/edit`);
  };
  try {
    const ok = await answer(200, 'Name,Email\nA,a@b.cc', { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="x.csv"; filename*=UTF-8''My%20list%20-%20Tab.csv` });
    assert.equal(ok.name, 'My list - Tab');
    await assert.rejects(answer(200, '<html>', { 'content-type': 'text/html' }, 'https://accounts.google.com/signin'), /not shared/);
    await assert.rejects(answer(401, '', { 'content-type': 'text/html' }), /not shared/);
    await assert.rejects(answer(404, '', { 'content-type': 'text/html' }), /not found/);
    await assert.rejects(answer(200, 'x'.repeat(6 * 1024 * 1024), { 'content-type': 'text/csv' }), /too large/);
  } finally {
    globalThis.fetch = real;
  }
});

test('one send time at a time: same daily number every time, spaced, inside the window', () => {
  const taken: Date[] = [];
  for (let i = 0; i < 100; i++) taken.push(nextSlot(plan, { now: dhaka('2026-11-23T10:00'), taken, seed: 's' }));
  assert.ok(taken.every((t) => insideWindow(t, plan)));
  const days = new Map<string, number[]>();
  for (const t of taken) days.set(dayKey(t, plan.timezone), [...(days.get(dayKey(t, plan.timezone)) ?? []), t.getTime()].sort((a, b) => a - b));
  const sizes = [...days.values()].map((d) => d.length);
  assert.ok(sizes.slice(0, -1).every((n) => n >= 15 && n <= 20), sizes.join());
  for (const d of days.values()) for (let i = 1; i < d.length; i++) assert.ok(d[i] - d[i - 1] > 45_000, String((d[i] - d[i - 1]) / 1000));
  const late = nextSlot(plan, { now: dhaka('2026-11-30T21:00'), taken: [], seed: 's' });
  assert.equal(dayKey(late, plan.timezone), '2026-12-01');
});

test('a Profile: private lines out, whole sentences in small batches, only real facts', () => {
  const t = scrub('Name A\nDate of Birth: 1990\nFather: B\nCall +880 1711 222333 or 01711222333, mail a@b.cc, see linkedin.com/in/x\nCGPA 3.41 in 2011 to 2012');
  assert.doesNotMatch(t, /1990|Father|1711|a@b|linkedin/);
  assert.match(t, /CGPA 3\.41 in 2011 to 2012/);
  assert.equal(phoneIn('Dhaka | +8801700000000 | x'), '+8801700000000');
  assert.equal(phoneIn('GPA 3.50 2005 to 2006'), null);
  const long = Array.from({ length: 400 }, (_, i) => `This is sentence number ${i} of the profile.`).join(' ');
  const b = batches(long, 3000);
  assert.ok(b.length > 4 && b.every((x) => x.length <= 3000 && x.endsWith('.')));
  assert.equal(b.join(' ').replace(/\s+/g, ' '), long);
  const src = 'MSc in Computer Science, CGPA 3.41 of 4.00, 2011. The thesis reconstructed a software architecture.';
  assert.equal(supported('MSc in Computer Science, CGPA 3.41', src), true);
  assert.equal(supported('MSc in Computer Science, CGPA 3.91', src), false);
  assert.equal(supported('Thesis: reconstruction of a software architecture', src), true);
  assert.equal(supported('Led a team of engineers at a bank', src), false);
});

test('notes about the profile itself are taken out: doubtful sentences and whole boxes', () => {
  const t = scrub(['Cross-Check Summary and Corrections Applied', 'MBA CGPA set to 3.68.', 'Items still to verify before submitting', 'The CV shows 21 August, the form shows 31 July.', '1. Academic Overview', 'She holds an MBA. The earlier title was corrected from Officer. She works in Dhaka.', 'Applicant-reported: saved 12 percent.', '3.2 Merchandiser', 'Worked with buyers.', 'Date to reconcile', 'CV end date: May.', '3.3 Next job', 'Planned production.'].join('\n'));
  assert.equal(t, ['1. Academic Overview', 'She holds an MBA. She works in Dhaka.', '3.2 Merchandiser', 'Worked with buyers.', '3.3 Next job', 'Planned production.'].join('\n'));
});

test('signature lines, and the example emails keep the rules themselves', () => {
  const b = composeBody({ greeting: 'Dear Professor Li,', body: 'Hello.', name: 'A B', email: 'a@b.cc', phone: '+88 1', signature: 'Lecturer\nUniversity A' });
  assert.ok(b.endsWith('Kind regards,\nA B\nLecturer\nUniversity A\nEmail: a@b.cc | Phone: +88 1'));
  const ex = PDF_RULES.examples.split(/\n-{3,}\n/);
  assert.equal(ex.length, 2);
  for (const x of ex) {
    const flags = checkRules({ subject: 'Prospective PhD Researcher | x', body: composeBody({ greeting: 'Dear Professor Li,', body: x, name: 'A B', email: 'a@b.cc', phone: '+88 1' }), email: 'a@b.cc', phone: '+88 1', toEmail: 'p@uni.edu' }).map((f) => f.code);
    assert.deepEqual(flags.filter((f) => f !== 'length'), []);
    assert.doesNotMatch(x, /Zarin|Tasnim|North South|Mueed|Shadman|Flawless|Pelican|Memorial|Western|Polzer|3\.67/i);
  }
});

test('planned research told as done is stopped by plain code', () => {
  const brief = `Research and thesis:
- Thesis: Rutting Resistance of Asphalt Mixtures Modified with Waste Polyethylene
- Marshall stability, flow and wheel tracking tests were used.

Proposed research (a plan, nothing of it is done yet):
- Working title: Fatigue and Moisture Damage of Plastic-Modified Asphalt under Monsoon Conditions
- Methods: four-point bending fatigue tests, dynamic shear rheometer, statistical analysis in R.

Skills:
- Software: AutoCAD Civil 3D, R, basic ABAQUS.`;
  const hits = (s: string) => planAsDone(`Dear Professor Li,\n\n${s}\n\nKind regards,\nA`, brief).length;
  for (const bad of [
    'I have performed Marshall, wheel-tracking, and four-point bending fatigue tests, and I am proficient in dynamic shear rheometry and statistical analysis in R.',
    'I have also conducted four-point bending fatigue tests and used a dynamic shear rheometer.',
    'My laboratory experience covers fatigue tests with a dynamic shear rheometer.',
  ]) assert.ok(hits(bad) > 0, bad);
  for (const good of [
    'I plan to use four-point bending fatigue tests and a dynamic shear rheometer.',
    'My proposed study, *Fatigue and Moisture Damage of Plastic-Modified Asphalt under Monsoon Conditions*, examines fatigue under monsoon conditions.',
    'I completed a thesis on the rutting resistance of asphalt mixtures, where I used Marshall stability and wheel tracking tests.',
    'I have skills in AutoCAD Civil 3D and basic ABAQUS.',
    'My background in rutting tests is a foundation, although I would need training in fatigue tests with the dynamic shear rheometer.',
  ]) assert.equal(hits(good), 0, good);
});

test('every professor is greeted as Professor', () => {
  assert.ok(composeBody({ greeting: 'Dear Associate Professor Li', body: 'x', name: 'A', email: 'a@b.cc', phone: null }).startsWith('Dear Professor Li,\n'));
  assert.ok(composeBody({ greeting: 'Dear Dr. Li,', body: 'x', name: 'A', email: 'a@b.cc', phone: null }).startsWith('Dear Dr. Li,\n'));
});

test('a lost connection is tried again, but nothing that may have arrived is sent twice', async () => {
  const real = globalThis.fetch;
  const fails = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  const run = async (method: string, errors: unknown[]) => {
    let n = 0;
    globalThis.fetch = (async () => {
      const e = errors[n++];
      if (e) throw e;
      return new Response('ok');
    }) as any;
    const r = await reach('https://x.test', { method }, { waits: [1, 1, 1] }).then(() => 'ok', () => 'failed');
    return `${r} ${n}`;
  };
  try {
    const dead = fails('UND_ERR_CONNECT_TIMEOUT');
    assert.equal(await run('POST', [dead, dead]), 'ok 3');
    assert.equal(await run('GET', [dead, fails('ECONNRESET')]), 'ok 3');
    assert.equal(await run('POST', [fails('ECONNRESET')]), 'failed 1');
    assert.equal(await run('PUT', [fails('UND_ERR_SOCKET')]), 'failed 1');
    assert.equal(await run('POST', [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError', code: 23 })]), 'failed 1');
    assert.equal(await run('POST', [dead, dead, dead, dead]), 'failed 4');
    assert.equal(await run('POST', [Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ETIMEDOUT' }, { code: 'ENETUNREACH' }] } })]), 'ok 2');
  } finally {
    globalThis.fetch = real;
  }
});

test('a sentence with an unproved claim is taken out, the rest stays word for word', () => {
  const filler = 'We study roads and bitumen with care and write it down. '.repeat(10).trim();
  const body = composeBody({ greeting: 'Dear Professor Li,', body: `I am enquiring about supervision. ${filler}\n\nI led a team of twelve engineers at a bank. My CV is attached.`, name: 'A B', email: 'a@b.cc', phone: null });
  const f = { code: 'unsupported', level: 'block' as const, text: 'Not in the student text: "led a team of twelve engineers"' };
  assert.equal(claimRemains(body, f), true);
  const out = cutSentences(body, [f])!;
  assert.equal(out, body.replace('I led a team of twelve engineers at a bank. ', ''));
  assert.equal(claimRemains(out, f), false);
  assert.equal(cutSentences(body, [{ ...f, level: 'warn' }]), null);
  assert.equal(cutSentences(body, [{ code: 'professor_name', level: 'block', text: 'x "led a team of twelve engineers"' }]), null);
  const short = composeBody({ greeting: 'Dear Professor Li,', body: 'I led a team of twelve engineers at a bank. My CV is attached.', name: 'A B', email: 'a@b.cc', phone: null });
  assert.equal(cutSentences(short, [f]), null, 'too little would be left');
});

test('own test addresses: exact addresses only, at most ten, everybody else stays in the sandbox', () => {
  const allow = sandboxAllow('A@gmail.com, b@x.org;@gmail.com *@gmail.com gmail.com c@*.com');
  assert.deepEqual(allow, ['a@gmail.com', 'b@x.org']);
  assert.equal(sandboxAllow(Array.from({ length: 30 }, (_, i) => `p${i}@x.org`).join(',')).length, 10);
  const cfg = { sandbox: true, sandboxTo: 't@t.tt', allow };
  assert.deepEqual(resolveRecipient('a@Gmail.com', 'S', cfg), { to: 'a@Gmail.com', subject: '[TEST] S', sandboxed: true });
  for (const other of ['aa@gmail.com', 'a@gmail.com.evil.org', 'prof@uni.edu']) assert.equal(resolveRecipient(other, 'S', cfg).to, 't@t.tt', other);
  assert.equal(resolveRecipient('prof@uni.edu', 'S', { ...cfg, sandbox: false }).subject, 'S');
});

test('a change of settings or code is noticed, anything else is not', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'A=1');
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'x.ts'), '1');
  const a = stampOf(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  assert.deepEqual(stampOf(dir), a);
  fs.writeFileSync(path.join(dir, '.env'), 'A=2');
  assert.notEqual(stampOf(dir).settings, a.settings);
  assert.equal(stampOf(dir).code, a.code);
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'x.ts'), '2');
  assert.notEqual(stampOf(dir).code, a.code);
  fs.rmSync(dir, { recursive: true });
});

test('text is quoted-printable: short lines, ASCII only, and it reads back exactly', () => {
  const text = 'Dear Professor Müller,\n\n' + 'A long line with = signs, “quotes” and a tab\tinside. '.repeat(8) + '\ntrailing space \n.\nFrom here 👩‍🔬 end';
  const q = quotedPrintable(text);
  assert.ok(q.split('\r\n').every((l) => l.length <= 76 && /^[\x09\x20-\x7e]*$/.test(l) && !/[ \t]$/.test(l)), q);
  const back = Buffer.from(q.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  assert.equal(back, text.replace(/\n/g, '\r\n'));
  const m = buildMime('a@b.cc', { to: 'x@y.zz', subject: 's', body: text });
  assert.ok(m.includes('quoted-printable') && !/Content-Transfer-Encoding: base64/.test(m));
});

test('slow start: 3 a day, then 5, then 10, then the plan', () => {
  assert.deepEqual(['2026-11-24', '2026-11-26', '2026-11-27', '2026-11-30', '2026-12-01', '2026-12-07', '2026-12-08'].map((d) => slowCap(d, '2026-11-24')), [3, 3, 5, 5, 10, 10, Infinity]);
  assert.equal(slowCap('2026-11-24', null), Infinity);
  const p = { ...plan, startDate: '2026-11-24', minPerDay: 15, maxPerDay: 20, weekdays: [1, 2, 3, 4, 5, 6, 7], slowFrom: '2026-11-24' };
  const now = new Date('2026-11-23T00:00:00Z');
  const days = new Map<string, number>();
  for (const t of allocateSlots(60, p, { now })) days.set(dayKey(t, p.timezone), (days.get(dayKey(t, p.timezone)) ?? 0) + 1);
  assert.deepEqual([...days.values()].slice(0, 9), [3, 3, 3, 5, 5, 5, 5, 10, 10]);
  const taken: Date[] = [];
  for (let i = 0; i < 12; i++) taken.push(nextSlot(p, { now, taken, seed: 's' }));
  assert.deepEqual([...new Set(taken.map((t) => dayKey(t, p.timezone)))].map((d) => taken.filter((t) => dayKey(t, p.timezone) === d).length), [3, 3, 3, 3]);
});

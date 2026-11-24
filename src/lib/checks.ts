/** Checks on a written email, done by plain code and not by the AI. */

export interface Flag {
  code: string;
  level: 'block' | 'warn';
  text: string;
}

export interface CheckInput {
  subject: string;
  body: string;
  studentName: string;
  professor: { name: string; university?: string | null; researchArea?: string | null; notes?: string | null; department?: string | null };
  /** Every other professor and university of the same list */
  otherNames: string[];
  otherUniversities: string[];
  /** Everything the email may take facts from: the text about the student, the professor's row, staff instructions */
  facts: string;
}

const fold = (s: string) =>
  s
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const TITLES = /\b(prof(essor)?|dr|mr|mrs|ms|phd|ph\.d|assoc(iate)?|asst|assistant)\b\.?/gi;

export function lastName(full: string): string {
  const bare = full.replace(/\(.*?\)/g, ' ').replace(TITLES, ' ').trim();
  // "Smith, John" lists put the family name first
  const base = bare.includes(',') && bare.split(',')[0].trim() ? bare.split(',')[0] : bare;
  const parts = base.trim().split(/\s+/);
  return (bare.includes(',') ? base.trim() : parts[parts.length - 1] ?? '').replace(/[.,]+$/, '');
}

const bareName = (full: string) => fold(full.replace(/\(.*?\)/g, ' ').replace(TITLES, ' ')).replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();

const hasWord = (text: string, needle: string) =>
  needle.length > 1 && new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function checkEmail(i: CheckInput): Flag[] {
  const flags: Flag[] = [];
  const block = (code: string, text: string) => flags.push({ code, level: 'block', text });
  const warn = (code: string, text: string) => flags.push({ code, level: 'warn', text });
  const all = `${i.subject}\n${i.body}`;
  const folded = fold(all);
  const facts = fold(i.facts);

  if (!i.subject.trim()) block('no_subject', 'There is no subject.');
  if (/[\r\n]/.test(i.subject)) block('subject_lines', 'The subject has more than one line.');
  if (i.subject.length > 150) warn('long_subject', 'The subject is very long.');

  const last = fold(lastName(i.professor.name));
  if (last && !hasWord(fold(i.body.slice(0, 250)), last)) block('professor_name', `The greeting does not name ${i.professor.name}.`);
  if (!hasWord(folded, fold(i.studentName.trim().split(/\s+/).pop() ?? ''))) block('student_name', 'The student did not sign the email.');

  if (/\[[^\]\n]{2,60}\]|\{\{|\}\}|<[a-z_ ]{3,40}>|\bxxx+\b|lorem ipsum|your name|professor name|university name/i.test(all)) {
    block('placeholder', 'A placeholder was left in the text.');
  }

  const own = bareName(i.professor.name);
  for (const n of i.otherNames) {
    const b = bareName(n);
    if (b.includes(' ') && b !== own && !own.includes(b) && hasWord(folded, b) && !facts.includes(b)) {
      block('other_professor', `It names another professor: ${n}.`);
      break;
    }
  }
  const ownUni = fold(i.professor.university ?? '');
  for (const u of i.otherUniversities) {
    const b = fold(u).trim();
    if (b.length > 5 && b !== ownUni && !ownUni.includes(b) && !b.includes(ownUni || '\u0000') && hasWord(folded, b) && !facts.includes(b)) {
      block('other_university', `It names another university: ${u}.`);
      break;
    }
  }

  // Quoted titles must come from the text about the student or the professor's row.
  for (const m of all.matchAll(/["\u201c]([^"\u201d\n]{12,200})["\u201d]|\*([^*\n]{20,200})\*/g)) {
    const quoted = m[1] ?? m[2];
    const t = fold(quoted).replace(/[.,;:]+$/, '').trim();
    if (m[2] && m[2].trim().endsWith("?")) continue; // an emphasised question, not a title
    if (!facts.includes(t)) {
      block('unknown_title', `This title is not in the student text or the list: "${quoted.slice(0, 80)}".`);
      break;
    }
  }

  const years = new Set([String(new Date().getFullYear()), String(new Date().getFullYear() + 1)]);
  const unknown = [...new Set([...i.body.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]))].filter((n) => !years.has(n) && !new RegExp(`(^|[^\\d.,])${n.replace(/[.,]/g, '\\$&')}($|[^\\d])`).test(i.facts));
  if (unknown.length) warn('unknown_number', `Check these numbers, they are not in the student text or the list: ${unknown.slice(0, 5).join(', ')}.`);

  if (/https?:\/\/|www\./i.test(i.body)) warn('link', 'It contains a link.');
  return flags;
}

// ---------------------------------------------------------------- the writing rules of the NextED reference

export const SUBJECT_PREFIX = 'Prospective PhD Researcher | ';

/** No em dashes; ranges become words. */
export const tidy = (s: string) =>
  s
    .replace(/(\d)\s*[\u2012\u2013\u2014\u2015]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[\u2014\u2015]\s*/g, ', ')
    .replace(/\s+\u2013\s+/g, ', ')
    .replace(/[\u2010\u2011]/g, '-');

export const contactLine = (email: string, phone: string | null) => `Email: ${email}${phone ? ` | Phone: ${phone}` : ''}`;

/** Greeting, the AI's text, closing and contact line. Whatever greeting or closing the AI added itself is taken off. */
export function composeBody(i: { greeting: string; body: string; name: string; email: string; phone: string | null; signature?: string | null }): string {
  const greeting = `${i.greeting.replace(/\b(associate|assistant|adjunct|distinguished|emeritus|senior)\s+(?=prof)/gi, '').replace(/\s+/g, ' ').trim().replace(/[,;:.]*$/, '')},`;
  const core = tidy(i.body.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim())
    .replace(/^dear [^\n]{0,80}\n+/i, '')
    .replace(/\n+\s*(kind|best|warm|warmest)?\s*(regards|wishes)\b[\s\S]{0,200}$/i, '')
    .replace(/\n+\s*(yours )?(sincerely|faithfully)\b[\s\S]{0,200}$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${greeting}\n\n${core}\n\nKind regards,\n${i.name}\n${i.signature?.trim() ? `${i.signature.trim()}\n` : ''}${contactLine(i.email, i.phone)}`;
}

/** The body without greeting and closing, as the reference counts it. */
export const coreText = (body: string) => body.replace(/^dear [^\n]*\n+/i, '').replace(/\n+\s*kind regards,[\s\S]*$/i, '').trim();

const PRAISE = /\b(esteemed|renowned|prestigious|world[- ]?class|groundbreaking|ground-breaking|distinguished (work|career|professor)|deeply (inspired|impressed)|truly (inspiring|impressed)|great honou?r|i hope this (email|message) finds you well|remarkable (work|contributions?)|outstanding (work|contributions?)|immense (pleasure|respect)|i (was|am|have been) (very |so |truly |deeply |particularly )?(excited|impressed|intrigued|fascinated|thrilled|inspired|captivated))\b/i;
const STOCK = /\b(aligns? (closely|perfectly|well|directly)|closely aligns?|resonates? with|i am eager|underscores?|highlights the (need|importance|potential|challenges)|delve|testament to|pivotal|under your (esteemed )?guidance|directly (relevant|applicable|relates))\b/i;
const BEGGING = /\b(i beg|please help me|kindly (grant|give|provide|consider granting)|desperate(ly)?|i (badly|really) need|at your mercy|only hope|full(y)? scholarship)\b/i;
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|aol|gmx|web|proton|protonmail|mail)\.[a-z.]+$/i;

export function checkRules(i: { subject: string; body: string; email: string; phone: string | null; toEmail: string }): Flag[] {
  const flags: Flag[] = [];
  const block = (code: string, text: string) => flags.push({ code, level: 'block', text });
  const warn = (code: string, text: string) => flags.push({ code, level: 'warn', text });
  if (!i.subject.startsWith(SUBJECT_PREFIX) || i.subject.length <= SUBJECT_PREFIX.length) block('subject_form', `The subject must be "${SUBJECT_PREFIX}" and a hook.`);
  else {
    const n = wordCount(i.subject.slice(SUBJECT_PREFIX.length));
    if (n >= 8) warn('hook_long', `The hook after "${SUBJECT_PREFIX.trim()}" has ${n} words; it should be under 8.`);
  }
  const core = coreText(i.body);
  const n = wordCount(core);
  if (n < 150 || n > 200) warn('length', `The body has ${n} words; it should be 150 to 200.`);
  if (!/\b(CV|curriculum vitae|r[\u00e9e]sum[\u00e9e])\b/.test(core)) warn('no_cv', 'It does not say that the CV is attached.');
  if (!/\b(10|15|20|ten|fifteen|twenty)\b[^.]{0,30}minute/i.test(core)) warn('no_call', 'It does not ask for a brief 10 to 20 minute call.');
  if (!/\b(fund(ed|ing)?|stipend|studentship|position|opening|project (role|place)|support(ed)? (doctoral|phd))\b/i.test(core)) warn('no_funding', 'It does not ask about funding, indirectly.');
  if (/[\u2014\u2015]/.test(`${i.subject}${i.body}`)) warn('em_dash', 'It contains an em dash.');
  if (PRAISE.test(core)) warn('praise', `Generic praise: "${core.match(PRAISE)![0]}".`);
  if (STOCK.test(core)) warn('stock', `Stock phrase: "${core.match(STOCK)![0]}".`);
  if (BEGGING.test(core)) warn('begging', `It sounds like begging: "${core.match(BEGGING)![0]}".`);
  if (!i.body.includes(i.email) || (i.phone && !i.body.includes(i.phone))) warn('contact', 'The student\u2019s email and phone are not both in the closing.');
  if (FREE_MAIL.test(i.toEmail)) block('unverified_address', 'On hold: this is not an official university address. Verify it first.');
  return flags;
}

const shingles = (s: string) => {
  const w = fold(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let k = 0; k + 4 <= w.length; k++) out.add(w.slice(k, k + 4).join(' '));
  return out;
};

export function similarity(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size || !y.size) return 0;
  let same = 0;
  for (const s of x) if (y.has(s)) same++;
  return same / (x.size + y.size - same);
}

export const blocked = (flags: unknown): boolean => Array.isArray(flags) && (flags as Flag[]).some((f) => f.level === 'block');

const DONE = /\bI (?:have |had |also |have also |already )*(?:performed|conducted|used|employed|applied|analy[sz]ed|carried out|tested|developed|measured|completed|built|designed|implemented|investigated|examined|studied|worked|gained|acquired|am (?:proficient|experienced|skilled|familiar|trained))\b|\bmy (?:(?:practical|hands-on|laboratory|research|previous|current) )*(?:experience|proficiency|expertise|training|background)\b|\bI hold experience\b/i;
const PLAN = /\b(would|will|hope|plan|propose|intend|aim|wish|could|like to)\b/i;
const contentWords = (s: string) => fold(s).match(/[a-z][a-z0-9-]{3,}/g) ?? [];

/**
 * Sentences that tell the student's planned research as work already done. A word counts as planned
 * when it stands only under "Proposed research" of the brief and nowhere else in it.
 */
export function planAsDone(body: string, brief: string): string[] {
  const parts = brief.split(/\n(?=[A-Z][^\n]{2,70}:\n)/);
  const isPlan = (p: string) => /^\s*proposed research/i.test(p);
  const known = new Set(parts.filter((p) => !isPlan(p)).flatMap(contentWords));
  const stems = new Set([...known].map((w) => w.slice(0, 6)));
  const plan = new Set(parts.filter(isPlan).flatMap(contentWords).filter((w) => !known.has(w) && !(w.length > 6 && stems.has(w.slice(0, 6)))));
  if (!plan.size) return [];
  return coreText(body)
    .split(/(?<=[.!?])\s+|\n+/)
    .flatMap((s) => s.split(/[;]|,\s+(?:and|but|while)\s+(?=I\b)/))
    .filter((s) => DONE.test(s) && !PLAN.test(s) && new Set(contentWords(s.replace(/["\u201c*][^"\u201d*]{12,}["\u201d*]/g, '')).filter((w) => plan.has(w))).size >= 2);
}

/** Claims quoted in a blocking problem: the sentences that hold them can be taken out. */
const CUTTABLE = new Set(['unsupported', 'plan_as_done', 'unknown_title']);

const bareWords = (s: string) => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
const claimWords = (f: Flag) => bareWords(f.text.match(/"([^"]+)"\.?\s*$/)?.[1] ?? f.text.match(/"([^"]+)"/)?.[1] ?? '');
const holds = (sentence: string, claim: string[]) => {
  const w = new Set(bareWords(sentence));
  return claim.length >= 2 && claim.filter((x) => w.has(x)).length / claim.length >= 0.75;
};
const sentences = (line: string) => line.split(/(?<=[.!?])\s+(?=[\p{Lu}"\u201c*])/u);

/** Does any sentence of the email still make this claim? */
export const claimRemains = (body: string, f: Flag): boolean => coreText(body).split('\n').flatMap(sentences).some((x) => holds(x, claimWords(f)));

/**
 * Takes out the sentences with a blocking claim. Only whole sentences go, nothing is written, so
 * nothing new can be wrong. Null when that does not solve it or too little is left.
 */
export function cutSentences(body: string, flags: Flag[]): string | null {
  const claims = flags.filter((f) => f.level === 'block' && CUTTABLE.has(f.code)).map(claimWords).filter((c) => c.length >= 2);
  if (!claims.length) return null;
  const lines = body.split('\n');
  const closing = lines.findIndex((l) => /^kind regards,?$/i.test(l.trim()));
  const end = closing < 0 ? lines.length : closing;
  let cut = 0;
  const out = lines.map((l, i) => {
    if (i === 0 || i >= end || !l.trim()) return l;
    return sentences(l)
      .filter((x) => {
        const bad = claims.some((c) => holds(x, c));
        if (bad) cut++;
        return !bad;
      })
      .join(' ');
  });
  if (!cut) return null;
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return wordCount(coreText(text)) >= 90 ? text : null;
}

import ExcelJS from 'exceljs';

/** Reading a professor list (.xlsx or .csv) and checking every row. No database here. */

export const FIELDS = ['name', 'email', 'university', 'department', 'researchArea', 'country', 'notes'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, number>>;

export const FIELD_LABELS: Record<Field, string> = {
  name: 'Professor name',
  email: 'Email',
  university: 'University',
  department: 'Department',
  researchArea: 'Research area',
  country: 'Country',
  notes: 'Notes / papers',
};

export const MAX_ROWS = 2000;
const MAX_COLS = 40;

// Checked in this order, so "Email" is never taken as a name column.
const PATTERNS: [Field, RegExp][] = [
  ['email', /e-?mail|mail id/i],
  ['researchArea', /research|interest|field|area|speciali[sz]|expertise|topic/i],
  ['department', /dep(t|artment)|faculty|school|lab\b/i],
  ['university', /universit|institut|college|affiliation|organi[sz]ation/i],
  ['country', /country|location/i],
  ['name', /professor|supervisor|name|faculty member|prof\b/i],
  ['notes', /note|comment|paper|publication|remark|profile|bio/i],
];

export interface Sheet {
  headers: string[];
  rows: string[][];
}

const clean = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((r: any) => r.text ?? '').join('');
    if ('hyperlink' in o) {
      const text = typeof o.text === 'object' ? cellText(o.text) : String(o.text ?? '');
      return text || String(o.hyperlink).replace(/^mailto:/i, '');
    }
    if ('result' in o) return cellText(o.result);
    if ('error' in o || 'formula' in o || 'sharedFormula' in o) return '';
    return '';
  }
  return String(v);
}

/** RFC 4180 CSV: quotes, doubled quotes, commas and new lines inside quotes. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export async function readSheet(fileName: string, bytes: Buffer): Promise<Sheet> {
  let grid: string[][];
  if (/\.csv$/i.test(fileName)) {
    grid = parseCsv(bytes.toString('utf8'));
  } else if (/\.xlsx$/i.test(fileName)) {
    if (bytes.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('This is not a real .xlsx file.');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bytes as any);
    } catch {
      throw new Error('This Excel file could not be read. Save it again as .xlsx and try once more.');
    }
    // the sheet with the most rows: lists often have a cover sheet
    const ws = [...wb.worksheets].sort((a, b) => b.actualRowCount - a.actualRowCount)[0];
    if (!ws) throw new Error('The file has no sheets.');
    grid = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      if (grid.length > MAX_ROWS + 50) return;
      const line: string[] = [];
      for (let c = 1; c <= Math.min(ws.columnCount, MAX_COLS); c++) line.push(cellText(r.getCell(c).value));
      grid.push(line);
    });
  } else {
    throw new Error('Upload an .xlsx or .csv file. Old .xls files must be saved as .xlsx first.');
  }

  grid = grid.map((r) => r.slice(0, MAX_COLS).map(clean)).filter((r) => r.some(Boolean));
  if (!grid.length) throw new Error('The file is empty.');
  // The heading row: the first row (of the first ten) that names an email column and holds no address itself.
  const headerAt = grid.slice(0, 10).findIndex((r) => r.some((c) => /e-?mail/i.test(c)) && !r.some((c) => c.includes('@')));
  if (headerAt < 0) return inferSheet(grid);
  const rows = grid.slice(headerAt + 1);
  if (!rows.length) throw new Error('There are no professors under the heading row.');
  if (rows.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} professors per file.`);
  const width = Math.max(...[grid[headerAt], ...rows].map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  return { headers: pad(grid[headerAt]).map((h, i) => h || `Column ${i + 1}`), rows: rows.map(pad) };
}

const UNI = /universit|uniwersytet|politec|politech|polytech|hochschule|institut|college|\b(TU|RWTH|ETH|EPFL|KTH|KIT|NTNU|MIT|UCL|KU)\b/i;
const TITLE_RE = /^\s*\d*[.)]?\s*((full|associate|assistant|adjunct|distinguished|emeritus|senior|univ\.?|apl\.?|jun\.?|priv\.?-?doz\.?)[\s.-]*)*(prof|dr|professor|ing)\b/i;
const share = (cells: string[], test: (s: string) => boolean) => cells.filter(test).length / Math.max(1, cells.length);

/** A list without headings: the columns are recognised by what stands in them. */
export function inferSheet(grid: string[][]): Sheet {
  const width = Math.max(...grid.map((r) => r.length));
  const rows = grid.map((r) => [...r, ...Array(width - r.length).fill('')]);
  if (rows.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} professors per file.`);
  const col = (c: number) => rows.map((r) => r[c]).filter(Boolean);
  const all = Array.from({ length: width }, (_, i) => i);
  const best = (from: number[], score: (c: number) => number, min: number) => {
    const top = from.map((c) => [c, score(c)] as const).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= min ? top[0] : -1;
  };
  const email = best(all, (c) => rows.filter((r) => firstEmail(r[c]).email).length / rows.length, 0.4);
  if (email < 0) throw new Error('No column with email addresses was found.');
  let left = all.filter((c) => c !== email);
  const uni = best(left, (c) => share(col(c), (s) => UNI.test(s) && s.length < 120), 0.25);
  left = left.filter((c) => c !== uni);
  const name = best(left, (c) => {
    const v = col(c);
    const looks = (s: string) => TITLE_RE.test(s) || /^\d+[.)]\s+\p{Lu}/u.test(s) || (/^\p{Lu}[\p{L}.'’-]+(\s+\p{L}[\p{L}.'’-]*){1,4}$/u.test(s) && s.length < 50);
    return share(v, looks) * (v.length / rows.length) * (new Set(v).size / Math.max(1, v.length));
  }, 0.3);
  if (name < 0) throw new Error('No column with professor names was found. Add a heading row: Professor Name, Email, University, Research Area.');
  left = left.filter((c) => c !== name);
  const research = best(left, (c) => {
    const v = col(c).filter((s) => !/^https?:|@/.test(s));
    return (v.reduce((n, s) => n + s.length, 0) / Math.max(1, v.length)) * (v.length / rows.length);
  }, 18);
  const label = (c: number) => (c === email ? 'Email' : c === name ? 'Professor Name' : c === uni ? 'University' : c === research ? 'Research Area' : `Column ${c + 1}`);
  return { headers: all.map(label), rows };
}

const COUNTRIES: Set<string> = (() => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const out = new Set(['uk', 'usa', 'u.s.a.', 'us', 'the netherlands', 'holland', 'czech republic', 'turkey', 'south korea', 'korea', 'hong kong', 'macau', 'england', 'scotland', 'wales', 'northern ireland', 'uae', 'russia', 'taiwan']);
  for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) {
    const code = String.fromCharCode(a, b);
    const n = names.of(code);
    if (n && n !== code) out.add(n.toLowerCase());
  }
  return out;
})();

/** "TU Braunschweig, Germany" gives the university and the country. */
export function splitPlace(s: string): { university: string; country: string } {
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  const last = parts.at(-1) ?? '';
  if (parts.length > 1 && COUNTRIES.has(last.toLowerCase())) return { university: parts.slice(0, -1).join(', '), country: last };
  return { university: s.trim(), country: '' };
}

const POSITIONS: [RegExp, string][] = [
  [/^distinguished\s+prof(?:essor)?\.?\s+/i, 'Distinguished Professor'],
  [/^(?:associate|assoc\.?)\s+prof(?:essor)?\.?\s+/i, 'Associate Professor'],
  [/^(?:assistant|asst\.?)\s+prof(?:essor)?\.?\s+/i, 'Assistant Professor'],
  [/^adjunct\s+prof(?:essor)?\.?\s+/i, 'Adjunct Professor'],
  [/^(?:emeritus\s+prof(?:essor)?\.?|prof(?:essor)?\.?\s+emeritus)\s+/i, 'Professor Emeritus'],
  [/^senior\s+prof(?:essor)?\.?\s+/i, 'Senior Professor'],
  [/^apl\.?\s+prof\.?\s+/i, 'Adjunct Professor (apl.)'],
  [/^jun\.?-?\s*prof\.?\s+/i, 'Junior Professor'],
  [/^priv\.?-?\s*doz\.?\s+/i, 'Privatdozent'],
  [/^(?:full\s+|univ\.?-?\s*)?prof(?:essor)?\.?\s+/i, 'Professor'],
  [/^dr\.?\s+/i, 'Dr.'],
];

/** "1. Associate Prof. Denis Jelagin (Chair)" gives the bare name and the position. */
export function cleanPerson(raw: string): { name: string; position: string } {
  let s = raw.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
  const position: string[] = [];
  const end = s.match(/\s*\(([^)]*)\)\s*$/);
  if (end && end.index) {
    position.push(end[1].trim());
    s = s.slice(0, end.index);
  }
  const dash = s.split(/\s+[\u2013\u2014]\s+/);
  if (dash.length > 1) {
    position.unshift(dash.slice(1).join(', '));
    s = dash[0];
  }
  for (let again = true, first = true; again; ) {
    again = false;
    for (const [re, label] of POSITIONS) {
      if (re.test(s)) {
        s = s.replace(re, '').replace(/^(?:ing|habil|h\.?\s?c|rer\.?\s?nat|techn|phil)\.\s*/i, '');
        if (first && dash.length < 2) position.unshift(label);
        first = false;
        again = true;
        break;
      }
    }
  }
  s = s.replace(/,?\s*\b(ph\.?\s?d|p\.?\s?eng|dsc|msc|m\.?eng|fr?sc)\.?\s*$/i, '').replace(/[\s,;]+$/, '');
  return s ? { name: s, position: position.filter(Boolean).join('; ') } : { name: raw.trim(), position: '' };
}

/** The first address in a cell, and whether there were more. */
export function firstEmail(cell: string): { email: string | null; more: boolean } {
  const found = cell.split(/[\s;,/|]+/).map(normaliseEmail).filter((e): e is string => !!e);
  return { email: found[0] ?? null, more: new Set(found).size > 1 };
}

export function guessMapping(headers: string[]): Mapping {
  const map: Mapping = {};
  const taken = new Set<number>();
  for (const [field, re] of PATTERNS) {
    const i = headers.findIndex((h, n) => !taken.has(n) && re.test(h));
    if (i >= 0) {
      map[field] = i;
      taken.add(i);
    }
  }
  return map;
}

export function normaliseEmail(raw: string): string | null {
  const e = raw
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^[<("']+|[>)"',;.]+$/g, '')
    .toLowerCase();
  if (e.length > 254) return null;
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(e) ? e : null;
}

export interface CheckedRow {
  rowNumber: number;
  values: Record<Field, string>;
  email: string | null;
  errors: string[];
  warnings: string[];
}

export function checkRows(rows: string[][], map: Mapping, known?: { otherStudents?: Map<string, string[]>; sameStudent?: Set<string> }): CheckedRow[] {
  const seen = new Map<string, number>();
  return rows.map((r, i) => {
    const values = Object.fromEntries(FIELDS.map((f) => [f, map[f] === undefined ? '' : (r[map[f]!] ?? '')])) as Record<Field, string>;
    const errors: string[] = [];
    const warnings: string[] = [];
    const mail = firstEmail(values.email);
    const email = mail.email;
    const person = cleanPerson(values.name);
    values.name = person.name;
    if (person.position) values.notes = [`Position: ${person.position}`, values.notes].filter(Boolean).join('. ');
    if (values.university && !values.country) Object.assign(values, splitPlace(values.university));
    if (mail.more) warnings.push('More than one email: the first is used');
    if (!values.email) errors.push('No email');
    else if (!email) errors.push('Email is not valid');
    if (!values.name) errors.push('No name');
    if (email) {
      const first = seen.get(email);
      if (first !== undefined) errors.push(`Same email as row ${first}`);
      else seen.set(email, i + 1);
      if (known?.sameStudent?.has(email)) errors.push('This student already has an email to this professor');
      const others = known?.otherStudents?.get(email);
      if (others?.length) warnings.push(`Also contacted for ${others.join(', ')}`);
    }
    if (!values.researchArea && !values.notes.replace(/^Position: [^.]*\.?\s*/, '')) warnings.push('No research area: the email will be general');
    return { rowNumber: i + 1, values, email, errors, warnings };
  });
}

/** Development only: a demo staff account and sample files (all names made up). */
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { db } from '../src/lib/db';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/crypto';

export const DEMO = { email: 'demo@example.test', password: 'demo-only-password' };

export function demoPdf(lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 11 Tf 50 780 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((a) => `${String(a).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

export const DEMO_CV = [
  'Ayesha Rahman Demo',
  'BSc in Electrical Engineering, Example University of Technology, 2024, CGPA 3.72 of 4.00.',
  'Research interests: machine learning for medical signals and low power sensors.',
  'Research assistant, Signal Lab, 2024 to 2026: built an ECG dataset of 1200 recordings.',
  'Published a conference paper on arrhythmia detection with small neural networks.',
  'Skills: Python, MATLAB, PyTorch, embedded C.',
  'IELTS 7.5.',
];

/** What staff would type about the demo student */
export const DEMO_ABOUT = DEMO_CV.slice(1).join(' ');

const FIRST = ['Maria', 'James', 'Wei', 'Anna', 'Omar', 'Elena', 'David', 'Priya', 'Lars', 'Chloe'];
const LAST = ['Andersson', 'Bennett', 'Castillo', 'Dubois', 'Eriksen', 'Fischer', 'Gallagher', 'Hoffmann', 'Ivanova', 'Jansen', 'Keller', 'Lindqvist', 'Moretti', 'Novak', 'Oliveira', 'Petrov', 'Quinn', 'Rossi', 'Schneider', 'Takahashi', 'Ueda', 'Vasquez', 'Whitfield', 'Yamada', 'Zimmer'];
const AREAS = ['machine learning for ECG analysis', 'wearable biosensors', 'medical image segmentation', 'low power circuit design', 'speech processing', 'renewable energy systems', 'robotics and control', 'wireless sensor networks'];

export function demoProfessors(n = 250) {
  return Array.from({ length: n }, (_, i) => {
    const last = LAST[i % LAST.length];
    const first = FIRST[Math.floor(i / LAST.length) % FIRST.length];
    return { name: `Prof. ${first} ${last}`, email: `${first}.${last}@uni${i % 40}.example.test`.toLowerCase(), university: `Example University ${String.fromCharCode(65 + (i % 26))}${i % 40}`, department: 'Electrical Engineering', research: i % 10 === 9 ? '' : AREAS[i % AREAS.length], country: ['USA', 'Canada', 'Germany', 'Sweden'][i % 4] };
  });
}

async function main() {
  if (env().APP_ENV === 'production') throw new Error('Not in production.');
  await db.staff.upsert({ where: { email: DEMO.email }, create: { email: DEMO.email, name: 'Demo Staff', passwordHash: await hashPassword(DEMO.password) }, update: {} });
  fs.mkdirSync('samples', { recursive: true });
  fs.writeFileSync('samples/demo-cv.pdf', demoPdf(DEMO_CV));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Professors');
  ws.addRow(['Professor list for demo']);
  ws.addRow(['SL', 'Professor Name', 'Email Address', 'University', 'Department', 'Research Area', 'Country']);
  demoProfessors().forEach((p, i) => ws.addRow([i + 1, p.name, p.email, p.university, p.department, p.research, p.country]));
  // the kinds of mistakes real lists have
  ws.addRow([251, 'Prof. Bad Address', 'not-an-email', 'Example University Z', '', 'optics', 'USA']);
  ws.addRow([252, 'Prof. Maria Andersson', 'maria.andersson@uni0.example.test', 'Example University A0', '', 'optics', 'USA']);
  ws.addRow([253, '', 'nobody@uni1.example.test', '', '', '', '']);
  await wb.xlsx.writeFile('samples/demo-professors.xlsx');
  console.log('Demo staff account ready (see DEMO in scripts/seed.ts). Sample files are in samples/.');
}

if (process.argv[1]?.endsWith('seed.ts')) {
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}

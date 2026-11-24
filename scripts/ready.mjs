// Runs before `npm run dev` and `npm run worker`: brings the database and the database client up to
// date with the code, so no step has to be remembered. A server is updated by its own release steps.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
if (process.env.APP_ENV === 'production' || /^APP_ENV=["']?production/m.test(envFile)) process.exit(0);

const prisma = (...args) => spawnSync(process.execPath, ['node_modules/prisma/build/index.js', ...args], { encoding: 'utf8' });
const stop = (text, detail) => {
  console.error(`\n${text}\n`);
  if (detail) console.error(detail.trim().split('\n').slice(-8).join('\n'));
  process.exit(1);
};
const plain = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\s+/g, ' ').trim() : '');

const m = prisma('migrate', 'deploy');
if (m.status !== 0) {
  const out = `${m.stdout}${m.stderr}`;
  stop(/P1001|P1000|reach database/.test(out) ? 'The database is not running. Start it first: npm run db:start' : 'The database could not be updated.', out);
}
if (/have been successfully applied/.test(m.stdout)) console.log('Database updated.');

if (plain('prisma/schema.prisma') !== plain('node_modules/.prisma/client/schema.prisma')) {
  const g = prisma('generate');
  if (g.status !== 0) {
    const out = `${g.stdout}${g.stderr}`;
    stop(/EPERM|EBUSY/.test(out) ? 'The program was updated, but an old window is still running. Press Ctrl + C in BOTH the website and the worker window, then start them again.' : 'The database client could not be updated.', out);
  }
  console.log('Database client updated.');
}

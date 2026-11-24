import { db, stops } from '../lib/db';
import { env } from '../lib/env';
import { draftNext } from '../lib/pipeline/drafting';
import { completeFinished, scheduleReady } from '../lib/pipeline/campaigns';
import { profileNext } from '../lib/pipeline/profile';
import { startStamp } from '../lib/stamp';
import { cleanUpCancelled, moveLate, pushDrafts, recoverStuck, sendDue } from '../lib/pipeline/sender';
import { syncDue } from '../lib/pipeline/inbox';

/**
 * The background worker. Every job is taken from PostgreSQL with a lock (SKIP LOCKED), so any number
 * of workers can run. `npm run worker` does everything; `npm run worker -- email` or `-- ai` splits them.
 */

const what = process.argv[2] ?? 'all';
let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop(name: string, everyMs: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    let busy: unknown = false;
    try {
      busy = await fn();
    } catch (e: any) {
      console.error(`[${name}]`, e?.message ?? e);
    }
    if (busy !== true) await sleep(everyMs);
  }
}

/** The website shows a warning when this stops coming. */
const beat = (name: string) => db.setting.upsert({ where: { key: `heartbeat:${name}` }, create: { key: `heartbeat:${name}`, value: Date.now() }, update: { value: Date.now() } });

async function main() {
  const e = env();
  console.log(`[worker:${what}] APP_ENV=${e.APP_ENV} mail=${e.EMAIL_TRANSPORT} sandbox=${e.EMAIL_SANDBOX} ai=${e.LLM_PROVIDER} inbox=${e.INBOX_SCOPE}`);
  // the website compares this with the files and says when a restart is needed
  await db.setting.upsert({ where: { key: `stamp:${what}` }, create: { key: `stamp:${what}`, value: { ...startStamp, at: Date.now() } }, update: { value: { ...startStamp, at: Date.now() } } });
  const loops: Promise<void>[] = [];
  if (what === 'all' || what === 'ai') {
    loops.push(loop('beat', 20_000, () => beat('ai').then(() => false)));
    for (let i = 0; i < e.LLM_CONCURRENCY; i++) loops.push(loop('draft', 3000, async () => !(await stops()).writing && draftNext()));
    loops.push(loop('profile', 3000, async () => !(await stops()).writing && profileNext()));
  }
  if (what === 'all' || what === 'email') {
    loops.push(
      loop('beat', 20_000, () => beat('email').then(() => false)),
      loop('send', 15_000, async () => {
        await recoverStuck();
        await moveLate();
        await sendDue();
        await completeFinished();
      }),
    );
    loops.push(loop('gmail-drafts', 10_000, async () => {
      if ((await stops()).sending) return false;
      await scheduleReady();
      return (await pushDrafts()) > 0;
    }));
    loops.push(loop('clean-up', 10_000, async () => (await cleanUpCancelled()) > 0));
    loops.push(loop('inbox', 5000, async () => !(await stops()).inbox && (await syncDue()) > 0));
  }
  if (!loops.length) throw new Error('Use: npm run worker [-- all|ai|email]');
  await Promise.all(loops);
}

const stop = () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('[worker] finishing current work...');
  setTimeout(() => process.exit(0), 45_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main()
  .catch((err) => {
    console.error('[worker]', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

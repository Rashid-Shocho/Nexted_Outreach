/** A private PostgreSQL for development, kept in ./.devdb on port 5544. Not for production. */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('.devdb');
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'outreach',
  password: 'outreach_dev',
  port: 5544,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
});

async function main() {
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  for (const db of ['outreach', 'outreach_test']) {
    try {
      await pg.createDatabase(db);
    } catch (e: any) {
      if (!/already exists/i.test(String(e?.message ?? e))) throw e;
    }
  }
  console.log('PostgreSQL ready on 127.0.0.1:5544 (databases: outreach, outreach_test). Keep this window open.');
}

const stop = async () => {
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
setInterval(() => undefined, 60_000);

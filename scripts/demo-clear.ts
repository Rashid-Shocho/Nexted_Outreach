/** npm run demo:clear   removes demo students (with their campaigns and inbox) and the simulated Gmail. */
import { db } from '../src/lib/db';
import { env } from '../src/lib/env';

async function main() {
  if (env().APP_ENV === 'production') throw new Error('Not in production.');
  const demo = await db.student.findMany({ where: { isDemo: true }, select: { id: true, fullName: true } });
  const ids = demo.map((d) => d.id);
  await db.$transaction([
    db.email.deleteMany({ where: { studentId: { in: ids } } }),
    db.campaign.deleteMany({ where: { studentId: { in: ids } } }),
    db.student.deleteMany({ where: { id: { in: ids } } }),
    db.fakeMail.deleteMany({}),
  ]);
  console.log(`Removed ${demo.length} demo student(s). Real students were not touched.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

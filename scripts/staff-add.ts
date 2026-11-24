/** npm run staff:add -- email@example.com "Full Name"   makes the first staff account. */
import crypto from 'node:crypto';
import { db } from '../src/lib/db';
import { hashPassword } from '../src/lib/crypto';
import { normaliseEmail } from '../src/lib/excel';

async function main() {
  const email = normaliseEmail(process.argv[2] ?? '');
  const name = process.argv[3]?.trim();
  if (!email || !name) throw new Error('Use: npm run staff:add -- email@example.com "Full Name"');
  if (await db.staff.findUnique({ where: { email } })) throw new Error('That email already has an account.');
  const pw = crypto.randomBytes(12).toString('base64url');
  await db.staff.create({ data: { email, name, passwordHash: await hashPassword(pw) } });
  console.log(`Account made for ${email}. First password (shown once): ${pw}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

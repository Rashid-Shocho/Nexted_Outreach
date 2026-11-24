// Runs before anything else: tests use their own database, never the development one.
process.env.APP_ENV = 'development';
process.env.DATABASE_URL = 'postgresql://outreach:outreach_dev@127.0.0.1:5544/outreach_test';
process.env.EMAIL_TRANSPORT = 'fake';
process.env.LLM_PROVIDER = 'mock';
process.env.EMAIL_SANDBOX = 'true';
process.env.EMAIL_SANDBOX_TO = 'sandbox@example.test';
process.env.INBOX_SCOPE = 'all';
process.env.RESEARCH = 'off';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export async function wipe() {
  const { db } = await import('../../src/lib/db');
  const [{ name }] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (name !== 'outreach_test') throw new Error(`Refusing to clear "${name}"`);
  await db.$executeRawUnsafe('TRUNCATE "Student", "FakeMail", "AuditLog", "Setting", "StaffReply", "ConnectLink", "OAuthState" CASCADE');
}

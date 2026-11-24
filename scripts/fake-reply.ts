/** Development only: pretend professors answer. npm run fake:reply */
import { db } from '../src/lib/db';
import { env } from '../src/lib/env';
import { fakeIncoming } from '../src/lib/mail/fake';

async function main() {
  if (env().EMAIL_TRANSPORT !== 'fake') throw new Error('Only with EMAIL_TRANSPORT=fake.');
  const sent = await db.email.findMany({ where: { status: 'SENT', repliedAt: null }, orderBy: { sentAt: 'asc' }, take: 3, include: { professor: true, student: { include: { mailbox: true } } } });
  if (!sent.length) throw new Error('Nothing has been sent yet.');
  const [a, b, c] = sent;
  const to = (e: (typeof sent)[0]) => ({ mailbox: e.student.mailbox!.email, threadId: e.gmailThreadId! });
  await fakeIncoming({ ...to(a), from: `${a.professor.name} <${a.toEmail}>`, subject: `Re: ${a.subject}`, body: `Dear ${a.student.fullName},\n\nThank you for your message. Could you send me your transcript and tell me more about your project?\n\nBest wishes,\n${a.professor.name}` });
  if (b) await fakeIncoming({ ...to(b), from: `${b.professor.name} <${b.toEmail}>`, subject: `Automatic reply: ${b.subject}`, body: 'I am travelling and will answer next week.', headers: { 'auto-submitted': 'auto-replied' } });
  if (c) await fakeIncoming({ ...to(c), from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: 'Delivery Status Notification (Failure)', body: `Address not found: ${c.toEmail}`, headers: { 'x-failed-recipients': c.toEmail } });
  await fakeIncoming({ mailbox: a.student.mailbox!.email, from: 'Example Library <news@library.example.test>', subject: 'Your library card', body: 'Your card is ready to collect.' });
  console.log('Pretend mail added. It appears after the next mailbox check.');
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());

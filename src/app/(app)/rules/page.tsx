import { requireStaff } from '@/lib/auth';
import { writingRules } from '@/lib/prompt';
import * as A from '../../actions';
import { ActionButton, ActionForm } from '@/components/client';
import { Head } from '@/components/ui';

export const metadata = { title: 'Writing rules' };

export default async function Rules() {
  await requireStaff();
  const w = await writingRules();
  return (
    <>
      <Head title="Writing rules" sub="How the AI writes every email. The first three texts are from the NextED Professor Outreach PDF, the fourth adds what testing showed was missing.">
        <ActionButton action={A.restoreRules} label="Restore the originals" confirm="Replace all four texts with the original version?" />
      </Head>
      <section className="card">
        <ActionForm key={JSON.stringify(w).length} action={A.saveRules} submit="Save rules" keep>
          <label>Memory: who we are and how we work. This goes to the AI with every email, so never put client names or private details here.<textarea name="memory" rows={10} defaultValue={w.memory} /></label>
          <label>Assistant rules<textarea name="system" rows={14} defaultValue={w.system} required /></label>
          <label>Email rules<textarea name="email" rows={14} defaultValue={w.email} required /></label>
          <label>Additions to the PDF<textarea name="extra" rows={16} defaultValue={w.extra} /></label>
          <label>Example emails: good emails as models for tone and shape. Take names and private details out first. Two are enough, because they count towards the AI limit of every email; separate them with a line of dashes.<textarea name="examples" rows={10} defaultValue={w.examples} /></label>
        </ActionForm>
      </section>
      <section className="card">
        <h2>Done by the system itself</h2>
        <p className="muted">Before writing, the professor’s papers since 2010 are looked up. After writing, a second AI step compares every claim with the text about the student and the professor’s data; invented claims are repaired, and what cannot be repaired is held for a person.</p>
        <p className="muted">Checked in every email, whatever the AI writes: subject “Prospective PhD Researcher | …” with a hook under 8 words, 150 to 200 words, CV mentioned, 10 to 20 minute call, funding asked, email and phone in the closing, no em dashes, no generic praise, no begging, right professor and university, no invented titles or numbers, official address, not contacted before.</p>
      </section>
    </>
  );
}

import { requireStaff } from '@/lib/auth';
import { db } from '@/lib/db';
import * as A from '../../actions';
import { ActionButton, ActionForm } from '@/components/client';
import { Chip, Head, when } from '@/components/ui';

export const metadata = { title: 'Staff' };

export default async function Staff() {
  const me = await requireStaff();
  const [staff, log] = await Promise.all([
    db.staff.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, email: true, active: true } }),
    db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 40 }),
  ]);
  return (
    <>
      <Head title="Staff" sub="Everybody has the same access" />
      <div className="cols">
        <section className="card">
          <h2>Add staff</h2>
          <ActionForm action={A.addStaff} submit="Add">
            <div className="grid3"><label>Name<input name="name" required /></label><label>Email<input name="email" type="email" required /></label></div>
          </ActionForm>
        </section>
        <section className="card">
          <h2>Your password</h2>
          <ActionForm action={A.changePassword} submit="Change password" tone="quiet">
            <label>New password (12 characters or more)<input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
          </ActionForm>
        </section>
      </div>
      <section className="card scroll" style={{ marginTop: 16 }}>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Access</th><th /></tr></thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.email}</td>
                <td><Chip s={s.active ? 'READY' : '-'} text={s.active ? 'Active' : 'Switched off'} /></td>
                <td>{s.id === me.id ? null : <ActionButton action={A.setStaffActive.bind(null, s.id, !s.active)} label={s.active ? 'Switch off' : 'Switch on'} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card scroll">
        <h2>Recent activity</h2>
        <table><tbody>{log.map((l) => <tr key={l.id}><td className="num muted">{when(l.createdAt)}</td><td>{l.actor}</td><td>{l.action}</td></tr>)}</tbody></table>
      </section>
    </>
  );
}

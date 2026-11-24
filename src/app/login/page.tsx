import { redirect } from 'next/navigation';
import { currentStaff } from '@/lib/auth';
import { login } from '../actions';
import { ActionForm } from '@/components/client';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function Login() {
  if (await currentStaff()) redirect('/students');
  return (
    <main className="login">
      <div className="card">
        <h1 style={{ marginBottom: 18 }}>nextED Outreach</h1>
        <ActionForm action={login} submit="Sign in" keep>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        </ActionForm>
      </div>
    </main>
  );
}

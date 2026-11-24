export const metadata = { title: 'Connect Gmail' };

export default async function Done({ searchParams }: { searchParams: Promise<{ r?: string }> }) {
  const { r } = await searchParams;
  return (
    <main className="login">
      <div className="card">
        <h1 style={{ marginBottom: 14 }}>{r === 'ok' ? 'Connected' : 'Not connected'}</h1>
        <p>{r === 'ok' ? 'Thank you. You can close this page.' : r === 'expired' || !r ? 'This link was used already or is too old. Please ask for a new one.' : r}</p>
      </div>
    </main>
  );
}

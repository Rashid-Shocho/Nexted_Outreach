'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from 'react';

interface Result {
  ok?: string;
  error?: string;
}
type Action = (prev: Result, form: FormData) => Promise<Result>;

export function Note({ r }: { r: Result }) {
  if (r.error) return <p className="note bad" role="alert">{r.error}</p>;
  if (r.ok) return <p className="note good" role="status">{r.ok}</p>;
  return null;
}

/** A form that shows its result and cannot be sent twice. `keep` leaves the typed text in place. */
export function ActionForm({ action, children, submit, tone, confirm, className, keep }: { action: Action; children?: ReactNode; submit: string; tone?: 'quiet' | 'danger'; confirm?: string; className?: string; keep?: boolean }) {
  const [state, run, busy] = useActionState(action, {});
  return (
    <form
      action={keep ? undefined : run}
      className={className ?? 'form'}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) {
          e.preventDefault();
          return;
        }
        if (keep) {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => run(data));
        }
      }}
    >
      {children}
      <div className="row">
        <button className={`btn ${tone ?? ''}`} disabled={busy}>{busy ? 'Working…' : submit}</button>
      </div>
      <Note r={state} />
    </form>
  );
}

/** Just a button. */
export function ActionButton({ action, label, tone, confirm }: { action: Action; label: string; tone?: 'quiet' | 'danger'; confirm?: string }) {
  return <ActionForm action={action} submit={label} tone={tone ?? 'quiet'} confirm={confirm} className="inline" />;
}

/** Reloads the page's data while something is in progress. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

/** The reply box. A reply keeps its key until it is sent, so a double click or a retry cannot send it twice. */
export function ReplyBox({ action, to }: { action: Action; to: string }) {
  const [key, setKey] = useState('');
  const [body, setBody] = useState('');
  const [state, run, busy] = useActionState(action, {});
  const seen = useRef(state);
  useEffect(() => setKey(crypto.randomUUID()), []);
  useEffect(() => {
    if (state === seen.current) return;
    seen.current = state;
    if (!state.ok) return; // keep the key: trying again must not become a second reply
    setBody('');
    setKey(crypto.randomUUID());
  }, [state]);
  return (
    <form action={run} className="form reply">
      <input type="hidden" name="clientKey" value={key} />
      <label>
        Reply to {to}
        <textarea name="body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} required />
      </label>
      <div className="row">
        <button className="btn" disabled={busy || !key || !body.trim()}>{busy ? 'Sending…' : 'Send reply'}</button>
      </div>
      <Note r={state} />
    </form>
  );
}

/** Opening a conversation marks it read, for everybody. */
export function MarkRead({ action }: { action: Action }) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    startTransition(() => void action({}, new FormData()));
  }, [action]);
  return null;
}

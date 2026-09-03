'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Field, Input } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [state, setState] = useState({ loading: false, error: null, done: false });

  async function onSubmit(event) {
    event.preventDefault();
    setState({ loading: true, error: null, done: false });
    try {
      await apiFetch('/v1/auth/reset-password', { method: 'POST', body: { token, password } });
      setState({ loading: false, error: null, done: true });
      setTimeout(() => router.replace('/login'), 1500);
    } catch (error) {
      setState({ loading: false, error: error.message, done: false });
    }
  }

  if (!token) {
    return <Card><p style={{ margin: 0 }}>This reset link is missing its token. Request a new one.</p></Card>;
  }

  return (
    <Card>
      {state.done ? (
        <p style={{ margin: 0 }}>Password updated. Redirecting you to sign in…</p>
      ) : (
        <form onSubmit={onSubmit} className="stack" noValidate>
          <Field label="New password" htmlFor="password" hint="At least 12 characters with upper case, lower case, a digit and a symbol." required>
            <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13, margin: 0 }}>{state.error}</p> : null}
          <Button type="submit" loading={state.loading}>Set new password</Button>
        </form>
      )}
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="auth__card">
      <h1 className="auth__title">Choose a new password</h1>
      <Suspense fallback={<Card><p style={{ margin: 0 }}>Loading…</p></Card>}>
        <ResetForm />
      </Suspense>
    </div>
  );
}

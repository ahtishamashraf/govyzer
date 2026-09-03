'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Card, Field, Input } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ loading: false, sent: false, error: null });

  async function onSubmit(event) {
    event.preventDefault();
    setState({ loading: true, sent: false, error: null });
    try {
      await apiFetch('/v1/auth/forgot-password', { method: 'POST', body: { email } });
      setState({ loading: false, sent: true, error: null });
    } catch (error) {
      setState({ loading: false, sent: false, error: error.message });
    }
  }

  return (
    <div className="auth__card">
      <h1 className="auth__title">Reset your password</h1>
      <p className="auth__subtitle">We will email a reset link if the address belongs to an account.</p>
      <Card>
        {state.sent ? (
          <p style={{ margin: 0, fontSize: 14 }}>
            If that address exists we have sent a reset link. It expires in one hour.
          </p>
        ) : (
          <form onSubmit={onSubmit} className="stack" noValidate>
            <Field label="Work email" htmlFor="email" required>
              <Input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13, margin: 0 }}>{state.error}</p> : null}
            <Button type="submit" loading={state.loading}>Send reset link</Button>
          </form>
        )}
      </Card>
      <Link href="/login" style={{ fontSize: 13 }}>Back to sign in</Link>
    </div>
  );
}

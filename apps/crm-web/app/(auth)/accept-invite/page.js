'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Field, Input } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

function AcceptForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [form, setForm] = useState({ first_name: '', last_name: '', password: '' });
  const [state, setState] = useState({ loading: false, error: null });

  async function onSubmit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      await apiFetch('/v1/auth/accept-invite', { method: 'POST', body: { token, ...form } });
      router.replace('/dashboard');
      router.refresh();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  if (!token) return <Card><p style={{ margin: 0 }}>This invitation link is missing its token.</p></Card>;

  return (
    <Card>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <div className="row">
          <Field label="First name" htmlFor="first_name">
            <Input id="first_name" value={form.first_name} onChange={(event) => setForm({ ...form, first_name: event.target.value })} />
          </Field>
          <Field label="Last name" htmlFor="last_name">
            <Input id="last_name" value={form.last_name} onChange={(event) => setForm({ ...form, last_name: event.target.value })} />
          </Field>
        </div>
        <Field label="Password" htmlFor="password" hint="Leave blank if you already have a Govyzer account.">
          <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </Field>
        {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13, margin: 0 }}>{state.error}</p> : null}
        <Button type="submit" loading={state.loading}>Join the workspace</Button>
      </form>
    </Card>
  );
}

export default function AcceptInvitePage() {
  return (
    <div className="auth__card">
      <h1 className="auth__title">Accept your invitation</h1>
      <p className="auth__subtitle">Set up your account to join the team.</p>
      <Suspense fallback={<Card><p style={{ margin: 0 }}>Loading…</p></Card>}>
        <AcceptForm />
      </Suspense>
    </div>
  );
}

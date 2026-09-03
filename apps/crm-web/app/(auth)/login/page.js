'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Field, Input } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [form, setForm] = useState({ email: '', password: '' });
  const [state, setState] = useState({ loading: false, error: null });

  async function onSubmit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      await apiFetch('/v1/auth/login', { method: 'POST', body: form });
      router.replace(params.get('next') ?? '/dashboard');
      router.refresh();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <>
      <div className="auth__brand">
        <span className="shell__brand-mark" aria-hidden="true">G</span>
        <strong>Govyzer</strong>
      </div>
      <h1 className="auth__title">Sign in</h1>
      <p className="auth__subtitle">Use your work email address to continue.</p>

      <Card>
        <form onSubmit={onSubmit} className="stack" noValidate>
          <Field label="Work email" htmlFor="email" required>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </Field>
          <Field label="Password" htmlFor="password" required>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </Field>
          {state.error ? (
            <p role="alert" style={{ color: '#b42318', fontSize: 13, margin: 0 }}>
              {state.error}
            </p>
          ) : null}
          <Button type="submit" loading={state.loading} size="lg">
            Sign in
          </Button>
        </form>
      </Card>

      <div className="row row--between">
        <Link href="/forgot-password" style={{ fontSize: 13 }}>
          Forgot your password?
        </Link>
        <Link href="/register" style={{ fontSize: 13 }}>
          Create a workspace
        </Link>
      </div>
    </>
  );
}

export default function LoginPage() {
  return (
    <div className="auth__card">
      <Suspense fallback={<Card><p style={{ margin: 0 }}>Loading…</p></Card>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}

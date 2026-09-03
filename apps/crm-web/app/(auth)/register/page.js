'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, Select } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

const MODULES = [
  { value: 'ready', label: 'Ready / secondary property' },
  { value: 'offplan', label: 'Off-plan projects' },
  { value: 'sales_screen', label: 'Sales Screen displays' },
];

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    organization_name: '',
    organization_slug: '',
    first_name: '',
    last_name: '',
    email: '',
    password: '',
    country: 'AE',
    currency: 'AED',
    timezone: 'Asia/Dubai',
    locale: 'en',
    modules: ['ready'],
  });
  const [state, setState] = useState({ loading: false, error: null, details: null });

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  function toggleModule(value) {
    update({
      modules: form.modules.includes(value) ? form.modules.filter((entry) => entry !== value) : [...form.modules, value],
    });
  }

  async function onSubmit(event) {
    event.preventDefault();
    setState({ loading: true, error: null, details: null });
    try {
      await apiFetch('/v1/auth/register', { method: 'POST', body: form });
      router.replace('/dashboard');
      router.refresh();
    } catch (error) {
      setState({ loading: false, error: error.message, details: error.details });
    }
  }

  return (
    <div className="auth__card">
      <h1 className="auth__title">Create your workspace</h1>
      <p className="auth__subtitle">You will be the organization owner. UAE defaults are applied automatically.</p>

      <Card>
        <form onSubmit={onSubmit} className="stack" noValidate>
          <Field label="Company name" htmlFor="organization_name" required>
            <Input
              id="organization_name"
              required
              value={form.organization_name}
              onChange={(event) => {
                const name = event.target.value;
                update({
                  organization_name: name,
                  organization_slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 63),
                });
              }}
            />
          </Field>
          <Field label="Workspace address" htmlFor="organization_slug" hint={`Your team will sign in at ${form.organization_slug || 'your-company'}.govyzer.app`} required>
            <Input id="organization_slug" required value={form.organization_slug} onChange={(event) => update({ organization_slug: event.target.value })} />
          </Field>
          <div className="row">
            <Field label="First name" htmlFor="first_name" required>
              <Input id="first_name" required value={form.first_name} onChange={(event) => update({ first_name: event.target.value })} />
            </Field>
            <Field label="Last name" htmlFor="last_name" required>
              <Input id="last_name" required value={form.last_name} onChange={(event) => update({ last_name: event.target.value })} />
            </Field>
          </div>
          <Field label="Work email" htmlFor="email" required>
            <Input id="email" type="email" autoComplete="username" required value={form.email} onChange={(event) => update({ email: event.target.value })} />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 12 characters with upper case, lower case, a digit and a symbol." required>
            <Input id="password" type="password" autoComplete="new-password" required value={form.password} onChange={(event) => update({ password: event.target.value })} />
          </Field>
          <Field label="Modules to enable">
            <div className="row">
              {MODULES.map((module) => (
                <label key={module.value} className="row" style={{ gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={form.modules.includes(module.value)} onChange={() => toggleModule(module.value)} />
                  {module.label}
                </label>
              ))}
            </div>
          </Field>
          <div className="row">
            <Field label="Default language" htmlFor="locale">
              <Select id="locale" value={form.locale} onChange={(event) => update({ locale: event.target.value })} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} />
            </Field>
            <Field label="Currency" htmlFor="currency">
              <Select id="currency" value={form.currency} onChange={(event) => update({ currency: event.target.value })} options={[{ value: 'AED', label: 'AED' }, { value: 'SAR', label: 'SAR' }, { value: 'USD', label: 'USD' }]} />
            </Field>
          </div>

          {state.error ? (
            <div role="alert" style={{ color: '#b42318', fontSize: 13 }}>
              <p style={{ margin: 0 }}>{state.error}</p>
              {state.details?.length ? (
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {state.details.map((detail) => (
                    <li key={`${detail.path}-${detail.message}`}>{detail.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <Button type="submit" loading={state.loading} size="lg">
            Create workspace
          </Button>
        </form>
      </Card>

      <p className="muted">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}

'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@govyzer/ui';
import { apiFetch } from '@/lib/api-client';

function VerifyInner() {
  const [state, setState] = useState({ loading: true, error: null });

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setState({ loading: false, error: 'This verification link is missing its token.' });
      return;
    }
    apiFetch('/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState({ loading: false, error: null }))
      .catch((error) => setState({ loading: false, error: error.message }));
  }, []);

  if (state.loading) return <Card><p style={{ margin: 0 }}>Verifying your email…</p></Card>;
  if (state.error) return <Card><p style={{ margin: 0, color: '#b42318' }}>{state.error}</p></Card>;
  return (
    <Card>
      <p style={{ margin: 0 }}>
        Your email is verified. <Link href="/dashboard">Open the CRM</Link>
      </p>
    </Card>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="auth__card">
      <h1 className="auth__title">Email verification</h1>
      <Suspense fallback={<Card><p style={{ margin: 0 }}>Loading…</p></Card>}>
        <VerifyInner />
      </Suspense>
    </div>
  );
}

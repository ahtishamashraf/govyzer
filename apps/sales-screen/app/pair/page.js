'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { pairDisplay, readToken, storeToken } from '@/lib/display-client';

const APP_VERSION = '1.0.0';

function PairForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState('');
  const [state, setState] = useState({ loading: false, error: null });

  useEffect(() => {
    if (readToken()) router.replace('/display');
    const provided = params.get('code');
    if (provided) setCode(provided.toUpperCase());
  }, [router, params]);

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      const result = await pairDisplay({ code, appVersion: APP_VERSION });
      storeToken(result.token);
      router.replace('/display');
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="code" style={{ display: 'block', marginBottom: 12, color: 'var(--muted)' }}>
        Pairing code
      </label>
      {/* Focus goes to the input so a keyboard or remote can type immediately. */}
      <input
        id="code"
        autoFocus
        className="pair__input"
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        maxLength={12}
        placeholder="ABCD2345"
        autoComplete="off"
        spellCheck="false"
      />
      <button type="submit" className="pair__button" disabled={state.loading || code.length < 6}>
        {state.loading ? 'Pairing…' : 'Pair this display'}
      </button>
      {state.error ? <p className="pair__error" role="alert">{state.error}</p> : null}
    </form>
  );
}

export default function PairPage() {
  return (
    <main className="pair">
      <div className="pair__card">
        <h1 className="pair__title">Pair this display</h1>
        <p className="pair__sub">In the CRM, open Sales Screen, create a display and generate a pairing code.</p>
        <Suspense fallback={<p className="pair__sub">Loading…</p>}>
          <PairForm />
        </Suspense>
        <p className="pair__hint">
          The code is single use and expires within minutes. Once paired, this screen can only read its own approved
          presentation feed — it can never reach contacts, notes or commissions.
        </p>
      </div>
    </main>
  );
}

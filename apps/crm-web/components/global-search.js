'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@govyzer/ui';
import { apiFetchWithRefresh, buildQuery } from '@/lib/api-client';

/** Permission-aware global search: each source is only queried when allowed. */
export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const search = buildQuery({ q: query, per_page: 5 });
      const [leads, contacts, listings] = await Promise.all([
        apiFetchWithRefresh(`/v1/leads${search}`).catch(() => null),
        apiFetchWithRefresh(`/v1/contacts${search}`).catch(() => null),
        apiFetchWithRefresh(`/v1/listings${search}`).catch(() => null),
      ]);
      setResults([
        ...(leads?.data ?? []).map((row) => ({ id: row.id, label: `${row.reference} · ${row.contact?.display_name ?? 'Lead'}`, href: `/leads/${row.id}`, kind: 'Lead' })),
        ...(contacts?.data ?? []).map((row) => ({ id: row.id, label: `${row.display_name}`, href: `/contacts/${row.id}`, kind: 'Contact' })),
        ...(listings?.data ?? []).map((row) => ({ id: row.id, label: `${row.reference} · ${row.title}`, href: `/ready/listings/${row.id}`, kind: 'Listing' })),
      ]);
      setOpen(true);
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  return (
    <div style={{ position: 'relative' }}>
      <Input
        type="search"
        value={query}
        placeholder="Search leads, contacts and listings…"
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label="Global search"
      />
      {open && results.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            insetInlineEnd: 0,
            top: 'calc(100% + 6px)',
            background: 'var(--surface-raised)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-md)',
            zIndex: 30,
            overflow: 'hidden',
          }}
        >
          {results.map((result) => (
            <button
              key={`${result.kind}-${result.id}`}
              type="button"
              className="palette__item"
              onMouseDown={() => {
                router.push(result.href);
                setQuery('');
                setOpen(false);
              }}
            >
              <span className="gv-badge gv-badge--neutral">{result.kind}</span>
              {result.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

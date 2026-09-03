'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

const COMMANDS = [
  { label: 'Go to executive dashboard', href: '/dashboard', permission: 'reports.read' },
  { label: 'Go to leads', href: '/leads', permission: 'leads.read' },
  { label: 'Create a lead', href: '/leads?new=1', permission: 'leads.create' },
  { label: 'Go to contacts', href: '/contacts', permission: 'contacts.read' },
  { label: 'Go to ready listings', href: '/ready/listings', permission: 'listings.read' },
  { label: 'Create a listing', href: '/ready/listings/new', permission: 'listings.create' },
  { label: 'Portal errors', href: '/ready/portals', permission: 'portals.read' },
  { label: 'Off-plan inventory matrix', href: '/offplan/inventory', permission: 'units.read' },
  { label: 'Off-plan reservations', href: '/offplan/reservations', permission: 'reservations.read' },
  { label: 'Deals', href: '/deals', permission: 'deals.read' },
  { label: 'Reports', href: '/reports', permission: 'reports.read' },
  { label: 'Automations', href: '/automations', permission: 'workflows.read' },
  { label: 'Integrations', href: '/integrations', permission: 'integrations.read' },
  { label: 'Sales Screen displays', href: '/sales-screen', permission: 'sales_screen.read' },
  { label: 'Settings', href: '/settings', permission: 'organization.read' },
];

export default function CommandPalette({ open, onClose, session }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const results = useMemo(() => {
    const available = COMMANDS.filter((command) => !command.permission || session?.can(command.permission));
    if (!query) return available;
    const needle = query.toLowerCase();
    return available.filter((command) => command.label.toLowerCase().includes(needle));
  }, [query, session]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIndex((value) => Math.min(value + 1, results.length - 1));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((value) => Math.max(value - 1, 0));
      }
      if (event.key === 'Enter' && results[index]) {
        router.push(results[index].href);
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, results, index, router, onClose]);

  if (!open) return null;

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="palette__scrim" onClick={onClose} />
      <div className="palette__panel">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          autoFocus
          className="palette__input"
          placeholder="Jump to a screen or action…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          aria-label="Command palette search"
        />
        <div className="palette__list">
          {results.length === 0 ? (
            <p className="muted" style={{ padding: 16 }}>No matching command.</p>
          ) : (
            results.map((command, position) => (
              <button
                key={command.href}
                type="button"
                className={`palette__item${position === index ? ' is-active' : ''}`}
                onMouseEnter={() => setIndex(position)}
                onClick={() => {
                  router.push(command.href);
                  onClose();
                }}
              >
                {command.label}
              </button>
            ))
          )}
        </div>
        <div className="palette__hint">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

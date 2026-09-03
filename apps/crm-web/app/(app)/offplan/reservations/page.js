'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, ErrorState, PermissionDenied } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, formatMoney, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ReservationsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data, loading, error, reload } = useApi('/v1/offplan/reservations?per_page=50');
  const [busy, setBusy] = useState(null);
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('reservations.read')) return <PermissionDenied permission="reservations.read" />;

  async function act(id, path, body) {
    setBusy(id);
    await apiFetchWithRefresh(`/v1/offplan/reservations/${id}/${path}`, { method: 'POST', body }).catch(() => {});
    setBusy(null);
    reload();
  }

  return (
    <>
      <PageHeader title="Reservations" description="Expiring reservations release their unit automatically." />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title="Reservations">
        <DataTable
          loading={loading}
          rows={data ?? []}
          columns={[
            { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
            { key: 'unit_number', header: 'Unit' },
            { key: 'contact_name', header: 'Client' },
            { key: 'unit_price', header: 'Price', render: (row) => formatMoney(row.unit_price, currency, intlLocale, { compact: true }) },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'cancelled' || row.status === 'expired' ? 'danger' : row.status === 'converted' ? 'success' : 'info'}>{titleCase(row.status)}</Badge> },
            { key: 'expires_at', header: 'Expires', render: (row) => (row.expires_at ? `${formatDateTime(row.expires_at, intlLocale)} (${relativeTime(row.expires_at)})` : '—') },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                ['pending', 'confirmed', 'extended'].includes(row.status) ? (
                  <div className="row">
                    {session?.can('reservations.extend') ? (
                      <Button size="sm" variant="secondary" loading={busy === row.id} onClick={() => act(row.id, 'extend', { additional_hours: 48, reason: 'Extended from reservations list' })}>
                        +48h
                      </Button>
                    ) : null}
                    {session?.can('bookings.manage') ? (
                      <Button size="sm" loading={busy === row.id} onClick={() => act(row.id, 'booking', {})}>
                        Convert to booking
                      </Button>
                    ) : null}
                    {session?.can('reservations.cancel') ? (
                      <Button size="sm" variant="danger" loading={busy === row.id} onClick={() => act(row.id, 'cancel', { reason: 'Cancelled from reservations list', release_unit: true })}>
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                ) : null,
            },
          ]}
          empty={<p className="muted">No reservations yet.</p>}
        />
      </Card>
    </>
  );
}

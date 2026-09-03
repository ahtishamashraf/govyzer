'use client';

import Link from 'next/link';
import { Card, DataTable, ErrorState, PermissionDenied, Skeleton, Stat, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { useApi, useSession } from '@/lib/api-client';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function OffplanDashboard() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data, loading, error, reload } = useApi('/v1/reports/dashboards/offplan');
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.hasModule('offplan')) return <PermissionDenied permission="offplan module" />;

  const totals = (data?.stock ?? []).reduce(
    (accumulator, row) => {
      accumulator.units += row.units;
      accumulator.value += row.value;
      accumulator.byStatus[row.status] = (accumulator.byStatus[row.status] ?? 0) + row.units;
      return accumulator;
    },
    { units: 0, value: 0, byStatus: {} }
  );

  return (
    <>
      <PageHeader
        title="Off-plan"
        description="Developer projects, live stock, reservations and expiring holds."
        actions={
          <>
            <Link href="/offplan/projects" className="gv-btn gv-btn--secondary gv-btn--md">Projects</Link>
            <Link href="/offplan/inventory" className="gv-btn gv-btn--primary gv-btn--md">Inventory matrix</Link>
          </>
        }
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={5} /> : null}

      {data ? (
        <>
          <div className="grid grid--stats">
            <Stat label="Projects" value={formatNumber(data.project_count, intlLocale)} />
            <Stat label="Units" value={formatNumber(totals.units, intlLocale)} hint={formatMoney(totals.value, currency, intlLocale, { compact: true })} />
            <Stat label="Available" value={formatNumber(totals.byStatus.available ?? 0, intlLocale)} />
            <Stat label="Off-plan leads" value={formatNumber(data.leads, intlLocale)} />
          </div>

          <div className="grid grid--2">
            <Card title="Stock by project">
              <DataTable
                rows={data.stock}
                rowKey={(row) => `${row.project}-${row.status}`}
                columns={[
                  { key: 'project', header: 'Project' },
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                  { key: 'units', header: 'Units', render: (row) => formatNumber(row.units, intlLocale) },
                  { key: 'value', header: 'Value', render: (row) => formatMoney(row.value, currency, intlLocale, { compact: true }) },
                ]}
                empty={<p className="muted">No stock imported yet.</p>}
              />
            </Card>

            <Card title="Expiring reservations" description="Reservations expiring in the next 72 hours." actions={<Link href="/offplan/reservations" className="gv-btn gv-btn--ghost gv-btn--sm">All reservations</Link>}>
              <DataTable
                rows={data.upcoming_expiries}
                columns={[
                  { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
                  { key: 'expires_at', header: 'Expires', render: (row) => formatDateTime(row.expires_at, intlLocale) },
                ]}
                empty={<p className="muted">Nothing expiring soon.</p>}
              />
            </Card>
          </div>

          <Card title="Reservations and bookings">
            <DataTable
              rows={data.reservations}
              rowKey={(row) => `${row.project}-${row.status}`}
              columns={[
                { key: 'project', header: 'Project' },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                { key: 'reservations', header: 'Count', render: (row) => formatNumber(row.reservations, intlLocale) },
                { key: 'value', header: 'Value', render: (row) => formatMoney(row.value, currency, intlLocale, { compact: true }) },
              ]}
              empty={<p className="muted">No reservations in this period.</p>}
            />
          </Card>
        </>
      ) : null}
    </>
  );
}

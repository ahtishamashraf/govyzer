'use client';

import Link from 'next/link';
import { Card, DataTable, ErrorState, PermissionDenied, ProgressBar, Skeleton, Stat, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { useApi, useSession } from '@/lib/api-client';
import { formatMoney, formatNumber, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ExecutiveDashboard() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data, loading, error, reload } = useApi('/v1/reports/dashboards/executive');
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('reports.read')) return <PermissionDenied permission="reports.read" />;

  return (
    <>
      <PageHeader
        title="Executive overview"
        description="Live performance across every module you are permitted to see."
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={5} /> : null}

      {data ? (
        <>
          <div className="grid grid--stats">
            <Stat
              label="Revenue (commission)"
              value={formatMoney(data.revenue.value, currency, intlLocale, { compact: true })}
              delta={data.revenue.change_percentage}
              hint={`Previous period ${formatMoney(data.revenue.previous, currency, intlLocale, { compact: true })}`}
            />
            <Stat label="Deals won" value={formatNumber(data.deals.value, intlLocale)} hint={`Previous ${formatNumber(data.deals.previous, intlLocale)}`} />
            <Stat label="New leads" value={formatNumber(data.leads.total, intlLocale)} hint={`${formatNumber(data.leads.won, intlLocale)} converted`} />
            <Stat label="Active reservations" value={formatNumber(data.active_reservations, intlLocale)} />
          </div>

          <div className="grid grid--2">
            <Card title="Top agents" description="Ranked by commission earned in the period.">
              <DataTable
                columns={[
                  { key: 'agent', header: 'Agent' },
                  { key: 'deals', header: 'Deals', render: (row) => formatNumber(row.won, intlLocale) },
                  { key: 'revenue', header: 'Commission', render: (row) => formatMoney(row.revenue, currency, intlLocale) },
                ]}
                rows={data.top_agents}
                empty={<p className="muted">No won deals in this period yet.</p>}
              />
            </Card>

            <Card title="Listing pipeline" description="Every ready listing by status.">
              <div className="stack">
                {data.listings.length === 0 ? <p className="muted">No listings yet.</p> : null}
                {data.listings.map((row) => (
                  <div key={row.status} className="row row--between">
                    <StatusBadge status={row.status} />
                    <strong className="mono">{formatNumber(row.total, intlLocale)}</strong>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card title="Off-plan stock" description="Unit inventory by stock status." actions={<Link href="/offplan/inventory" className="gv-btn gv-btn--secondary gv-btn--sm">Open matrix</Link>}>
            <div className="grid grid--3">
              {data.stock.length === 0 ? <p className="muted">No off-plan stock imported yet.</p> : null}
              {data.stock.map((row) => (
                <div key={row.status} className="stack" style={{ gap: 6 }}>
                  <div className="row row--between">
                    <StatusBadge status={row.status} />
                    <strong className="mono">{formatNumber(row.total, intlLocale)}</strong>
                  </div>
                  <ProgressBar value={row.total} max={data.stock.reduce((sum, entry) => sum + entry.total, 0)} label={formatMoney(row.value, currency, intlLocale, { compact: true })} />
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}

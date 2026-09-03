'use client';

import Link from 'next/link';
import { Card, DataTable, ErrorState, PermissionDenied, Skeleton, Stat, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { useApi, useSession } from '@/lib/api-client';
import { formatMoney, formatNumber, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ReadyDashboard() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data, loading, error, reload } = useApi('/v1/reports/dashboards/ready');
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.hasModule('ready')) return <PermissionDenied permission="ready module" />;

  return (
    <>
      <PageHeader
        title="Ready properties"
        description="Secondary and rental stock, portal publication health and conversion."
        actions={
          <>
            <Link href="/ready/listings" className="gv-btn gv-btn--secondary gv-btn--md">All listings</Link>
            {session?.can('listings.create') ? <Link href="/ready/listings/new" className="gv-btn gv-btn--primary gv-btn--md">New listing</Link> : null}
          </>
        }
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={5} /> : null}

      {data ? (
        <>
          <div className="grid grid--stats">
            <Stat label="Commission won" value={formatMoney(data.revenue, currency, intlLocale, { compact: true })} hint={`${formatNumber(data.deals, intlLocale)} deals`} />
            <Stat label="New leads" value={formatNumber(data.leads.total, intlLocale)} />
            <Stat label="Avg. first response" value={data.leads.avg_response_minutes != null ? `${data.leads.avg_response_minutes} min` : '—'} />
            <Stat label="Viewings" value={formatNumber(data.viewings, intlLocale)} />
          </div>

          <div className="grid grid--2">
            <Card title="Listings by status">
              <DataTable
                rows={data.listings_by_status}
                rowKey={(row) => `${row.status}-${row.offering_type}`}
                columns={[
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                  { key: 'offering_type', header: 'Offering', render: (row) => titleCase(row.offering_type) },
                  { key: 'listings', header: 'Listings', render: (row) => formatNumber(row.listings, intlLocale) },
                  { key: 'total_value', header: 'Value', render: (row) => formatMoney(row.total_value, currency, intlLocale, { compact: true }) },
                ]}
              />
            </Card>

            <Card title="Portal errors" description="Actionable failures reported by portals." actions={<Link href="/ready/portals" className="gv-btn gv-btn--ghost gv-btn--sm">Resolve</Link>}>
              <DataTable
                rows={data.portal_errors}
                rowKey={(row) => `${row.provider}-${row.error_code}`}
                columns={[
                  { key: 'provider', header: 'Portal', render: (row) => titleCase(row.provider) },
                  { key: 'error_code', header: 'Error', render: (row) => titleCase(row.error_code) },
                  { key: 'occurrences', header: 'Count' },
                ]}
                empty={<p className="muted">No portal errors. Everything published cleanly.</p>}
              />
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}

'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Card, DataTable, ErrorState, Field, Input, PermissionDenied, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { buildQuery, useApi, useSession } from '@/lib/api-client';
import { formatDate, formatMoney, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function DealsPage() {
  const router = useRouter();
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [filters, setFilters] = useState({ status: '', deal_type: '', q: '', page: 1, per_page: 25 });
  const query = useMemo(() => buildQuery(filters), [filters]);
  const { data, meta, loading, error, reload } = useApi(`/v1/deals${query}`, { deps: [query] });
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('deals.read')) return <PermissionDenied permission="deals.read" />;

  return (
    <>
      <PageHeader title="Deals" description="Ready sales, rentals and off-plan transactions with immutable commission snapshots." />

      <Card>
        <div className="filters">
          <Field label="Search" htmlFor="q">
            <Input id="q" type="search" value={filters.q} placeholder="Deal reference" onChange={(event) => setFilters({ ...filters, q: event.target.value, page: 1 })} />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" value={filters.status} placeholder="Any status" onChange={(event) => setFilters({ ...filters, status: event.target.value, page: 1 })} options={[{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }, { value: 'cancelled', label: 'Cancelled' }]} />
          </Field>
          <Field label="Type" htmlFor="deal_type">
            <Select id="deal_type" value={filters.deal_type} placeholder="Any type" onChange={(event) => setFilters({ ...filters, deal_type: event.target.value, page: 1 })} options={[{ value: 'ready_sale', label: 'Ready sale' }, { value: 'ready_rental', label: 'Ready rental' }, { value: 'offplan_sale', label: 'Off-plan sale' }]} />
          </Field>
        </div>
      </Card>

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title={`Deals${meta?.total != null ? ` (${meta.total})` : ''}`}>
        <DataTable
          loading={loading}
          rows={data ?? []}
          onRowClick={(row) => router.push(`/deals/${row.id}`)}
          columns={[
            { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
            { key: 'deal_type', header: 'Type', render: (row) => <Badge tone="neutral">{titleCase(row.deal_type)}</Badge> },
            { key: 'property_value', header: 'Value', render: (row) => formatMoney(row.property_value, row.currency ?? currency, intlLocale, { compact: true }) },
            { key: 'gross_commission', header: 'Commission', render: (row) => formatMoney(row.gross_commission, row.currency ?? currency, intlLocale, { compact: true }) },
            { key: 'stage', header: 'Stage', render: (row) => <Badge tone={row.status === 'won' ? 'success' : row.status === 'lost' ? 'danger' : 'info'}>{titleCase(row.stage)}</Badge> },
            { key: 'commission_status', header: 'Commission status', render: (row) => titleCase(row.commission_status) },
            { key: 'won_at', header: 'Won', render: (row) => formatDate(row.won_at, intlLocale) },
          ]}
          empty={<p className="muted">No deals yet.</p>}
        />
      </Card>
    </>
  );
}

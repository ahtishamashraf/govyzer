'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Field, Input, PermissionDenied, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { buildQuery, useApi, useSession } from '@/lib/api-client';
import { formatArea, formatMoney, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

const STATUSES = ['draft', 'internal_review', 'approved', 'publishing', 'published', 'partially_published', 'rejected', 'unpublished', 'expired', 'withdrawn', 'archived'];

export default function ListingsPage() {
  const router = useRouter();
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [filters, setFilters] = useState({ q: '', status: '', offering_type: '', page: 1, per_page: 25 });
  const query = useMemo(() => buildQuery(filters), [filters]);
  const { data, meta, loading, error, reload } = useApi(`/v1/listings${query}`, { deps: [query] });
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('listings.read')) return <PermissionDenied permission="listings.read" />;

  return (
    <>
      <PageHeader
        title="Ready listings"
        description="Portal-ready inventory with permits, media and publication status."
        actions={session?.can('listings.create') ? <Link href="/ready/listings/new" className="gv-btn gv-btn--primary gv-btn--md">New listing</Link> : null}
      />

      <Card>
        <div className="filters">
          <Field label="Search" htmlFor="q">
            <Input id="q" type="search" value={filters.q} placeholder="Title, reference or permit" onChange={(event) => setFilters({ ...filters, q: event.target.value, page: 1 })} />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" value={filters.status} placeholder="Any status" onChange={(event) => setFilters({ ...filters, status: event.target.value, page: 1 })} options={STATUSES.map((status) => ({ value: status, label: titleCase(status) }))} />
          </Field>
          <Field label="Offering" htmlFor="offering">
            <Select id="offering" value={filters.offering_type} placeholder="Sale and rent" onChange={(event) => setFilters({ ...filters, offering_type: event.target.value, page: 1 })} options={[{ value: 'sale', label: 'Sale' }, { value: 'rent', label: 'Rent' }]} />
          </Field>
        </div>
      </Card>

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card
        title={`Listings${meta?.total != null ? ` (${meta.total})` : ''}`}
        actions={
          meta?.total_pages > 1 ? (
            <div className="row">
              <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Previous</Button>
              <span className="muted">{filters.page} / {meta.total_pages}</span>
              <Button variant="ghost" size="sm" disabled={filters.page >= meta.total_pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Next</Button>
            </div>
          ) : null
        }
      >
        <DataTable
          loading={loading}
          rows={data ?? []}
          onRowClick={(row) => router.push(`/ready/listings/${row.id}`)}
          columns={[
            { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
            { key: 'title', header: 'Title' },
            { key: 'offering_type', header: 'Offering', render: (row) => <Badge tone="neutral">{titleCase(row.offering_type)}</Badge> },
            { key: 'price', header: 'Price', render: (row) => formatMoney(row.price, row.currency ?? currency, intlLocale, { compact: true }) },
            { key: 'bedrooms', header: 'Beds', render: (row) => row.bedrooms ?? '—' },
            { key: 'built_up_area', header: 'Size', render: (row) => formatArea(row.built_up_area, row.size_unit, intlLocale) },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'published' ? 'success' : row.status === 'rejected' ? 'danger' : 'neutral'}>{titleCase(row.status)}</Badge> },
            { key: 'updated_at', header: 'Updated', render: (row) => relativeTime(row.updated_at) },
          ]}
          empty={<EmptyState title="No listings match" description="Create your first listing to start publishing." />}
        />
      </Card>
    </>
  );
}

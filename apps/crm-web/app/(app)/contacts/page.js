'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Card, DataTable, EmptyState, ErrorState, Field, Input, PermissionDenied, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { buildQuery, useApi, useSession } from '@/lib/api-client';
import { relativeTime, titleCase } from '@/lib/format';

const ROLES = ['buyer', 'seller', 'landlord', 'tenant', 'investor', 'owner', 'external_broker', 'referral_partner'];

export default function ContactsPage() {
  const router = useRouter();
  const { session } = useSession();
  const [filters, setFilters] = useState({ q: '', role: '', page: 1, per_page: 25 });
  const query = useMemo(() => buildQuery(filters), [filters]);
  const { data, meta, loading, error, reload } = useApi(`/v1/contacts${query}`, { deps: [query] });

  if (session && !session.can('contacts.read')) return <PermissionDenied permission="contacts.read" />;

  return (
    <>
      <PageHeader title="Contacts" description="One identity per person, with every role and every enquiry attached." />

      <Card>
        <div className="filters">
          <Field label="Search" htmlFor="q">
            <Input id="q" type="search" value={filters.q} placeholder="Name, company or reference" onChange={(event) => setFilters({ ...filters, q: event.target.value, page: 1 })} />
          </Field>
          <Field label="Role" htmlFor="role">
            <Select id="role" value={filters.role} placeholder="Any role" onChange={(event) => setFilters({ ...filters, role: event.target.value, page: 1 })} options={ROLES.map((role) => ({ value: role, label: titleCase(role) }))} />
          </Field>
        </div>
      </Card>

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title={`Contacts${meta?.total != null ? ` (${meta.total})` : ''}`}>
        <DataTable
          loading={loading}
          rows={data ?? []}
          onRowClick={(row) => router.push(`/contacts/${row.id}`)}
          columns={[
            { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
            { key: 'display_name', header: 'Name' },
            { key: 'contact_type', header: 'Type', render: (row) => <Badge tone="neutral">{titleCase(row.contact_type)}</Badge> },
            { key: 'preferred_language', header: 'Language', render: (row) => (row.preferred_language === 'ar' ? 'Arabic' : 'English') },
            { key: 'created_at', header: 'Added', render: (row) => relativeTime(row.created_at) },
          ]}
          empty={<EmptyState title="No contacts yet" description="Contacts are created automatically whenever a new enquiry arrives." />}
        />
      </Card>
    </>
  );
}

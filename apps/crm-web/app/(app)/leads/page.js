'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, DataTable, Drawer, EmptyState, ErrorState, Field, Input, PermissionDenied, Select, Skeleton, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, buildQuery, useApi, useSession } from '@/lib/api-client';
import { formatMoney, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function LeadsPage() {
  const router = useRouter();
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [view, setView] = useState('table');
  const [filters, setFilters] = useState({ module: '', stage_code: '', status: 'open', q: '', page: 1, per_page: 25 });
  const [createOpen, setCreateOpen] = useState(false);

  const query = useMemo(() => buildQuery(filters), [filters]);
  const { data: leads, meta, loading, error, reload } = useApi(`/v1/leads${query}`, { deps: [query] });
  const { data: pipeline } = useApi(`/v1/leads/pipeline${buildQuery({ module: filters.module || 'ready' })}`, { deps: [filters.module] });
  const { data: pool, reload: reloadPool } = useApi('/v1/leads/pool');
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('leads.read')) return <PermissionDenied permission="leads.read" />;

  async function claim(leadId) {
    await apiFetchWithRefresh(`/v1/leads/${leadId}/claim`, { method: 'POST' });
    reloadPool();
    reload();
  }

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every enquiry, routed by your assignment rules and tracked against SLA."
        actions={
          <>
            <Button variant="secondary" onClick={() => setView(view === 'table' ? 'kanban' : 'table')}>
              {view === 'table' ? 'Pipeline view' : 'Table view'}
            </Button>
            {session?.can('leads.create') ? <Button onClick={() => setCreateOpen(true)}>New lead</Button> : null}
          </>
        }
      />

      <Card>
        <div className="filters">
          <Field label="Search" htmlFor="q">
            <Input id="q" type="search" value={filters.q} placeholder="Reference, client, property" onChange={(event) => setFilters({ ...filters, q: event.target.value, page: 1 })} />
          </Field>
          <Field label="Module" htmlFor="module">
            <Select id="module" value={filters.module} placeholder="All modules" onChange={(event) => setFilters({ ...filters, module: event.target.value, page: 1 })} options={[{ value: 'ready', label: 'Ready' }, { value: 'offplan', label: 'Off-plan' }]} />
          </Field>
          <Field label="Status" htmlFor="status">
            <Select id="status" value={filters.status} placeholder="Any status" onChange={(event) => setFilters({ ...filters, status: event.target.value, page: 1 })} options={[{ value: 'open', label: 'Open' }, { value: 'won', label: 'Won' }, { value: 'lost', label: 'Lost' }, { value: 'junk', label: 'Junk' }]} />
          </Field>
          <Field label="Stage" htmlFor="stage">
            <Select id="stage" value={filters.stage_code} placeholder="Any stage" onChange={(event) => setFilters({ ...filters, stage_code: event.target.value, page: 1 })} options={(pipeline ?? []).map((stage) => ({ value: stage.code, label: stage.name?.en ?? stage.code }))} />
          </Field>
        </div>
      </Card>

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      {view === 'table' ? (
        <Card
          title={`Leads${meta?.total != null ? ` (${meta.total})` : ''}`}
          actions={
            meta?.total_pages > 1 ? (
              <div className="row">
                <Button variant="ghost" size="sm" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>
                  Previous
                </Button>
                <span className="muted">{filters.page} / {meta.total_pages}</span>
                <Button variant="ghost" size="sm" disabled={filters.page >= meta.total_pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>
                  Next
                </Button>
              </div>
            ) : null
          }
        >
          <DataTable
            loading={loading}
            rows={leads ?? []}
            onRowClick={(row) => router.push(`/leads/${row.id}`)}
            columns={[
              { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
              { key: 'contact', header: 'Client', render: (row) => row.contact?.display_name ?? '—' },
              { key: 'module', header: 'Module', render: (row) => <Badge tone="neutral">{titleCase(row.module)}</Badge> },
              { key: 'stage_code', header: 'Stage', render: (row) => <StatusBadge status={row.stage_code} /> },
              { key: 'estimated_value', header: 'Budget', render: (row) => formatMoney(row.estimated_value, currency, intlLocale, { compact: true }) },
              { key: 'sla_status', header: 'SLA', render: (row) => <Badge tone={row.sla_status === 'breached' ? 'danger' : row.sla_status === 'met' ? 'success' : 'warning'}>{row.sla_status}</Badge> },
              { key: 'created_at', header: 'Created', render: (row) => relativeTime(row.created_at) },
            ]}
            empty={<EmptyState title="No leads match these filters" description="Adjust the filters or create the first lead." />}
          />
        </Card>
      ) : (
        <PipelineBoard pipeline={pipeline ?? []} filters={filters} currency={currency} locale={intlLocale} onOpen={(id) => router.push(`/leads/${id}`)} />
      )}

      {session?.can('leads.claim') && (pool ?? []).length > 0 ? (
        <Card title="Lead pool" description="Unassigned leads released by a manager or by an SLA breach. First claim wins.">
          <DataTable
            rows={pool}
            rowKey={(row) => row.pool_entry_id}
            columns={[
              { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
              { key: 'contact_name', header: 'Client' },
              { key: 'release_reason', header: 'Reason', render: (row) => row.release_reason ?? '—' },
              { key: 'released_at', header: 'Released', render: (row) => relativeTime(row.released_at) },
              { key: 'claim', header: '', render: (row) => <Button size="sm" onClick={() => claim(row.id)}>Claim</Button> },
            ]}
          />
        </Card>
      ) : null}

      <CreateLeadDrawer open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(lead) => router.push(`/leads/${lead.id}`)} />
    </>
  );
}

function PipelineBoard({ pipeline, filters, currency, locale, onOpen }) {
  const query = buildQuery({ ...filters, per_page: 100, page: 1 });
  const { data: leads, loading } = useApi(`/v1/leads${query}`, { deps: [query] });
  if (loading) return <Skeleton rows={6} />;

  return (
    <div className="kanban">
      {pipeline.map((stage) => {
        const stageLeads = (leads ?? []).filter((lead) => lead.stage_code === stage.code);
        return (
          <div key={stage.code} className="kanban__column">
            <div className="kanban__head">
              <span className="kanban__title">{stage.name?.en ?? stage.code}</span>
              <span className="gv-badge gv-badge--neutral">{stage.lead_count}</span>
            </div>
            <div className="kanban__body">
              {stageLeads.map((lead) => (
                <button key={lead.id} type="button" className="kanban__card" onClick={() => onOpen(lead.id)}>
                  <h4>{lead.contact?.display_name ?? lead.reference}</h4>
                  <p className="muted" style={{ margin: 0 }}>
                    {formatMoney(lead.estimated_value, currency, locale, { compact: true })} · {titleCase(lead.module)}
                  </p>
                </button>
              ))}
              {stageLeads.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>No leads</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CreateLeadDrawer({ open, onClose, onCreated }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', email: '', module: 'ready', purpose: 'buy', estimated_value: '', notes: '' });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      const identifiers = [];
      if (form.phone) identifiers.push({ identifier_type: 'phone', value: form.phone, is_primary: true });
      if (form.email) identifiers.push({ identifier_type: 'email', value: form.email });
      const payload = {
        module: form.module,
        purpose: form.purpose,
        estimated_value: form.estimated_value ? Number(form.estimated_value) : undefined,
        notes: form.notes || undefined,
        contact: { first_name: form.first_name, last_name: form.last_name, identifiers },
      };
      const result = await apiFetchWithRefresh('/v1/leads', { method: 'POST', body: payload });
      setState({ loading: false, error: null });
      onClose();
      onCreated(result.data.lead);
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <Drawer open={open} title="New lead" onClose={onClose}>
      <form id="new-lead" onSubmit={submit} className="stack">
        <div className="row">
          <Field label="First name" htmlFor="first_name" required>
            <Input id="first_name" required value={form.first_name} onChange={(event) => setForm({ ...form, first_name: event.target.value })} />
          </Field>
          <Field label="Last name" htmlFor="last_name">
            <Input id="last_name" value={form.last_name} onChange={(event) => setForm({ ...form, last_name: event.target.value })} />
          </Field>
        </div>
        <Field label="Mobile" htmlFor="phone" hint="A repeat number attaches this enquiry to the existing contact instead of creating a duplicate.">
          <Input id="phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
        </Field>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </Field>
        <div className="row">
          <Field label="Module" htmlFor="module">
            <Select id="module" value={form.module} onChange={(event) => setForm({ ...form, module: event.target.value })} options={[{ value: 'ready', label: 'Ready' }, { value: 'offplan', label: 'Off-plan' }]} />
          </Field>
          <Field label="Purpose" htmlFor="purpose">
            <Select id="purpose" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} options={[{ value: 'buy', label: 'Buy' }, { value: 'rent', label: 'Rent' }, { value: 'sell', label: 'Sell' }, { value: 'lease_out', label: 'Lease out' }, { value: 'invest', label: 'Invest' }]} />
          </Field>
        </div>
        <Field label="Budget" htmlFor="estimated_value">
          <Input id="estimated_value" type="number" min="0" value={form.estimated_value} onChange={(event) => setForm({ ...form, estimated_value: event.target.value })} />
        </Field>
        <Field label="Notes" htmlFor="notes">
          <textarea id="notes" className="gv-input gv-textarea" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
        </Field>
        {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
        <Button type="submit" loading={state.loading}>Create lead</Button>
      </form>
    </Drawer>
  );
}

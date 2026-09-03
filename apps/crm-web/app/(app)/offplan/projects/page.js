'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select, Textarea } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDate, formatMoney, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ProjectsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: projects, loading, error, reload } = useApi('/v1/offplan/projects?per_page=50');
  const { data: developers, reload: reloadDevelopers } = useApi('/v1/offplan/developers?per_page=100');
  const [drawer, setDrawer] = useState(null);
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('projects.read')) return <PermissionDenied permission="projects.read" />;

  return (
    <>
      <PageHeader
        title="Projects"
        description="Developer inventory with phases, unit types, payment plans and assignment policy."
        actions={
          session?.can('projects.manage') ? (
            <>
              <Button variant="secondary" onClick={() => setDrawer('developer')}>New developer</Button>
              <Button onClick={() => setDrawer('project')}>New project</Button>
            </>
          ) : null
        }
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title="Developers">
        <DataTable
          rows={developers ?? []}
          columns={[
            { key: 'name', header: 'Developer' },
            { key: 'default_commission_percentage', header: 'Default commission', render: (row) => (row.default_commission_percentage ? `${row.default_commission_percentage}%` : '—') },
            { key: 'is_active', header: 'Status', render: (row) => <Badge tone={row.is_active ? 'success' : 'neutral'}>{row.is_active ? 'Active' : 'Inactive'}</Badge> },
          ]}
          empty={<p className="muted">No developers yet.</p>}
        />
      </Card>

      <Card title="Projects">
        <DataTable
          loading={loading}
          rows={projects ?? []}
          columns={[
            { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
            { key: 'name', header: 'Project' },
            { key: 'developer_name', header: 'Developer' },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'selling' ? 'success' : 'neutral'}>{titleCase(row.status)}</Badge> },
            { key: 'handover_date', header: 'Handover', render: (row) => formatDate(row.handover_date, intlLocale) },
            { key: 'starting_price', header: 'From', render: (row) => formatMoney(row.starting_price, currency, intlLocale, { compact: true }) },
          ]}
          empty={<p className="muted">No projects yet.</p>}
        />
      </Card>

      <Drawer open={drawer === 'developer'} title="New developer" onClose={() => setDrawer(null)}>
        <SimpleForm
          fields={[
            { name: 'name', label: 'Developer name', required: true },
            { name: 'website', label: 'Website', type: 'url' },
            { name: 'contact_email', label: 'Contact email', type: 'email' },
            { name: 'default_commission_percentage', label: 'Default commission %', type: 'number' },
            { name: 'description', label: 'Description', type: 'textarea' },
          ]}
          submitLabel="Create developer"
          onSubmit={async (values) => {
            await apiFetchWithRefresh('/v1/offplan/developers', { method: 'POST', body: values });
            setDrawer(null);
            reloadDevelopers();
          }}
        />
      </Drawer>

      <Drawer open={drawer === 'project'} title="New project" onClose={() => setDrawer(null)}>
        <SimpleForm
          fields={[
            { name: 'developer_id', label: 'Developer', type: 'select', required: true, options: (developers ?? []).map((developer) => ({ value: developer.id, label: developer.name })) },
            { name: 'name', label: 'Project name', required: true },
            { name: 'status', label: 'Status', type: 'select', options: ['announced', 'presale', 'selling', 'under_construction', 'completed', 'sold_out'].map((value) => ({ value, label: titleCase(value) })) },
            { name: 'handover_date', label: 'Handover date', type: 'date' },
            { name: 'starting_price', label: 'Starting price', type: 'number' },
            { name: 'total_units', label: 'Total units', type: 'number' },
            { name: 'description', label: 'Description', type: 'textarea' },
          ]}
          submitLabel="Create project"
          onSubmit={async (values) => {
            await apiFetchWithRefresh('/v1/offplan/projects', { method: 'POST', body: values });
            setDrawer(null);
            reload();
          }}
        />
      </Drawer>
    </>
  );
}

function SimpleForm({ fields, onSubmit, submitLabel }) {
  const [values, setValues] = useState({});
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      const payload = Object.fromEntries(
        Object.entries(values)
          .filter(([, value]) => value !== '' && value !== undefined)
          .map(([key, value]) => {
            const field = fields.find((entry) => entry.name === key);
            return [key, field?.type === 'number' ? Number(value) : value];
          })
      );
      await onSubmit(payload);
    } catch (error) {
      setState({ loading: false, error: error.message });
      return;
    }
    setState({ loading: false, error: null });
  }

  return (
    <form onSubmit={submit} className="stack">
      {fields.map((field) => (
        <Field key={field.name} label={field.label} htmlFor={field.name} required={field.required}>
          {field.type === 'select' ? (
            <Select id={field.name} required={field.required} value={values[field.name] ?? ''} placeholder="Choose" options={field.options ?? []} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
          ) : field.type === 'textarea' ? (
            <Textarea id={field.name} value={values[field.name] ?? ''} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
          ) : (
            <Input id={field.name} type={field.type ?? 'text'} required={field.required} value={values[field.name] ?? ''} onChange={(event) => setValues({ ...values, [field.name]: event.target.value })} />
          )}
        </Field>
      ))}
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>{submitLabel}</Button>
    </form>
  );
}

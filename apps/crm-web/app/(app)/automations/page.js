'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function AutomationsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: workflows, loading, error, reload } = useApi('/v1/workflows');
  const { data: catalogue } = useApi('/v1/workflows/catalogue');
  const { data: runs } = useApi('/v1/workflows/runs?per_page=25');
  const [drawer, setDrawer] = useState(false);
  const [busy, setBusy] = useState(null);

  if (session && !session.can('workflows.read')) return <PermissionDenied permission="workflows.read" />;

  async function toggle(workflow) {
    setBusy(workflow.id);
    await apiFetchWithRefresh(`/v1/workflows/${workflow.id}/toggle`, { method: 'POST', body: { enabled: !workflow.is_enabled } }).catch(() => {});
    setBusy(null);
    reload();
  }

  async function publish(workflow) {
    if (!workflow.current_version_id) return;
    setBusy(workflow.id);
    await apiFetchWithRefresh(`/v1/workflows/versions/${workflow.current_version_id}/publish`, { method: 'POST' }).catch(() => {});
    setBusy(null);
    reload();
  }

  return (
    <>
      <PageHeader
        title="Automations"
        description="Versioned, auditable workflows with loop protection and full execution logs."
        actions={session?.can('workflows.manage') ? <Button onClick={() => setDrawer(true)}>New workflow</Button> : null}
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title="Workflows">
        <DataTable
          loading={loading}
          rows={workflows ?? []}
          columns={[
            { key: 'name', header: 'Workflow' },
            { key: 'trigger_type', header: 'Trigger', render: (row) => titleCase(row.trigger_type) },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'published' ? 'success' : 'neutral'}>{titleCase(row.status)}</Badge> },
            { key: 'is_enabled', header: 'Enabled', render: (row) => <Badge tone={row.is_enabled ? 'success' : 'warning'}>{row.is_enabled ? 'On' : 'Off'}</Badge> },
            { key: 'version', header: 'Version', render: (row) => (row.current_version ? `v${row.current_version.version_number}` : '—') },
            {
              key: 'actions',
              header: '',
              render: (row) =>
                session?.can('workflows.manage') ? (
                  <div className="row">
                    {row.status !== 'published' ? (
                      <Button size="sm" variant="secondary" loading={busy === row.id} onClick={() => publish(row)}>Publish</Button>
                    ) : null}
                    <Button size="sm" variant="ghost" loading={busy === row.id} onClick={() => toggle(row)}>
                      {row.is_enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                ) : null,
            },
          ]}
          empty={<p className="muted">No workflows yet.</p>}
        />
      </Card>

      <Card title="Recent runs" description="Every action, its input and its outcome are recorded.">
        <DataTable
          rows={runs ?? []}
          columns={[
            { key: 'trigger_type', header: 'Trigger', render: (row) => titleCase(row.trigger_type) },
            { key: 'entity_type', header: 'Entity', render: (row) => titleCase(row.entity_type ?? '—') },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'}>{titleCase(row.status)}</Badge> },
            { key: 'started_at', header: 'Started', render: (row) => formatDateTime(row.started_at, intlLocale) },
            { key: 'failure_reason', header: 'Failure', render: (row) => row.failure_reason ?? '—' },
          ]}
          empty={<p className="muted">No workflow runs yet.</p>}
        />
      </Card>

      <Drawer open={drawer} title="New workflow" onClose={() => setDrawer(false)}>
        <WorkflowForm
          catalogue={catalogue}
          onCreated={() => {
            setDrawer(false);
            reload();
          }}
        />
      </Drawer>
    </>
  );
}

function WorkflowForm({ catalogue, onCreated }) {
  const [form, setForm] = useState({
    name: '',
    code: '',
    trigger_type: 'record_created',
    entity_type: 'lead',
    condition_field: 'lead.estimated_value',
    condition_operator: 'gte',
    condition_value: '',
    action_type: 'notify_manager',
    action_title: 'Follow up needed',
  });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      await apiFetchWithRefresh('/v1/workflows', {
        method: 'POST',
        body: {
          name: form.name,
          code: form.code || form.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60),
          trigger_type: form.trigger_type,
          entity_type: form.entity_type,
          trigger_config: { entity_type: form.entity_type },
          conditions: form.condition_value
            ? [{ field: form.condition_field, operator: form.condition_operator, value: Number.isNaN(Number(form.condition_value)) ? form.condition_value : Number(form.condition_value) }]
            : [],
          actions: [{ position: 1, action_type: form.action_type, config: { title: form.action_title } }],
        },
      });
      onCreated();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Name" htmlFor="name" required>
        <Input id="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Trigger" htmlFor="trigger_type" required>
        <Select id="trigger_type" value={form.trigger_type} onChange={(event) => setForm({ ...form, trigger_type: event.target.value })} options={(catalogue?.triggers ?? []).map((value) => ({ value, label: titleCase(value) }))} />
      </Field>
      <Field label="Entity" htmlFor="entity_type">
        <Select id="entity_type" value={form.entity_type} onChange={(event) => setForm({ ...form, entity_type: event.target.value })} options={[{ value: 'lead', label: 'Lead' }, { value: 'deal', label: 'Deal' }, { value: 'listing', label: 'Listing' }, { value: 'reservation', label: 'Reservation' }]} />
      </Field>
      <Field label="Condition" htmlFor="condition_field" hint="Leave the value blank to run for every matching record.">
        <div className="row">
          <Input id="condition_field" value={form.condition_field} onChange={(event) => setForm({ ...form, condition_field: event.target.value })} />
          <Select value={form.condition_operator} onChange={(event) => setForm({ ...form, condition_operator: event.target.value })} options={(catalogue?.operators ?? ['eq']).map((value) => ({ value, label: value }))} />
          <Input value={form.condition_value} onChange={(event) => setForm({ ...form, condition_value: event.target.value })} placeholder="Value" />
        </div>
      </Field>
      <Field label="Action" htmlFor="action_type" required>
        <Select id="action_type" value={form.action_type} onChange={(event) => setForm({ ...form, action_type: event.target.value })} options={(catalogue?.actions ?? []).map((value) => ({ value, label: titleCase(value) }))} />
      </Field>
      <Field label="Action title" htmlFor="action_title">
        <Input id="action_title" value={form.action_title} onChange={(event) => setForm({ ...form, action_title: event.target.value })} />
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Create workflow (draft)</Button>
    </form>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select, Tabs } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function SettingsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [tab, setTab] = useState('organization');
  const [inviteOpen, setInviteOpen] = useState(false);
  const { data: organization, error, reload } = useApi('/v1/organization');
  const { data: users, reload: reloadUsers } = useApi('/v1/users?per_page=100');
  const { data: roles } = useApi('/v1/organization/roles');
  const { data: domains, reload: reloadDomains } = useApi('/v1/organization/domains');
  const { data: audit } = useApi('/v1/organization/audit-logs?per_page=25', { enabled: Boolean(session?.can('audit.read')) });
  const [form, setForm] = useState(null);
  const [branding, setBranding] = useState(null);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    if (organization?.organization) setForm(organization.organization);
    if (organization?.branding) setBranding(organization.branding);
  }, [organization]);

  if (session && !session.can('organization.read')) return <PermissionDenied permission="organization.read" />;

  async function saveOrganization(event) {
    event.preventDefault();
    await apiFetchWithRefresh('/v1/organization', {
      method: 'PATCH',
      body: {
        name: form.name,
        legal_name: form.legal_name || undefined,
        timezone: form.timezone,
        default_currency: form.default_currency,
        default_locale: form.default_locale,
        reference_prefix: form.reference_prefix,
        vat_percentage: Number(form.vat_percentage),
        commission_base: form.commission_base,
      },
    }).catch(() => {});
    setSaved('organization');
    reload();
  }

  async function saveBranding(event) {
    event.preventDefault();
    await apiFetchWithRefresh('/v1/organization/branding', {
      method: 'PATCH',
      body: {
        company_display_name: branding.company_display_name,
        primary_color: branding.primary_color,
        accent_color: branding.accent_color,
        font_family: branding.font_family,
        login_headline: branding.login_headline || undefined,
        sales_screen_theme: branding.sales_screen_theme,
      },
    }).catch(() => {});
    setSaved('branding');
    reload();
  }

  return (
    <>
      <PageHeader title="Settings" description="Organization defaults, branding, domains, people and the audit trail." />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'organization', label: 'Organization' },
          { value: 'branding', label: 'Branding' },
          { value: 'people', label: 'People', count: users?.length ?? 0 },
          { value: 'domains', label: 'Domains', count: domains?.length ?? 0 },
          { value: 'audit', label: 'Audit log' },
        ]}
      />

      {saved ? <div className="gv-toast gv-toast--success" role="status"><span>Saved.</span></div> : null}

      {tab === 'organization' && form ? (
        <Card title="Organization defaults">
          <form onSubmit={saveOrganization} className="grid grid--2">
            <Field label="Company name" htmlFor="name"><Input id="name" value={form.name ?? ''} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Legal name" htmlFor="legal_name"><Input id="legal_name" value={form.legal_name ?? ''} onChange={(event) => setForm({ ...form, legal_name: event.target.value })} /></Field>
            <Field label="Timezone" htmlFor="timezone"><Input id="timezone" value={form.timezone ?? ''} onChange={(event) => setForm({ ...form, timezone: event.target.value })} /></Field>
            <Field label="Currency" htmlFor="currency"><Input id="currency" value={form.default_currency ?? ''} onChange={(event) => setForm({ ...form, default_currency: event.target.value })} /></Field>
            <Field label="Default language" htmlFor="locale"><Select id="locale" value={form.default_locale ?? 'en'} onChange={(event) => setForm({ ...form, default_locale: event.target.value })} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} /></Field>
            <Field label="Reference prefix" htmlFor="prefix" hint="Used in every reference number, for example LUX-LD-2601-000042."><Input id="prefix" value={form.reference_prefix ?? ''} onChange={(event) => setForm({ ...form, reference_prefix: event.target.value })} /></Field>
            <Field label="VAT %" htmlFor="vat"><Input id="vat" type="number" step="0.01" value={form.vat_percentage ?? 5} onChange={(event) => setForm({ ...form, vat_percentage: event.target.value })} /></Field>
            <Field label="Commission base" htmlFor="base"><Select id="base" value={form.commission_base ?? 'gross_before_vat'} onChange={(event) => setForm({ ...form, commission_base: event.target.value })} options={[{ value: 'gross_before_vat', label: 'Gross before VAT' }, { value: 'gross_after_vat', label: 'Gross after VAT' }, { value: 'net_after_costs', label: 'Net after costs' }]} /></Field>
            <div><Button type="submit" disabled={!session?.can('organization.update')}>Save organization</Button></div>
          </form>
        </Card>
      ) : null}

      {tab === 'branding' && branding ? (
        <Card title="Branding" description="Applied to the CRM, generated documents, emails and the Sales Screen.">
          <form onSubmit={saveBranding} className="grid grid--2">
            <Field label="Display name" htmlFor="display_name"><Input id="display_name" value={branding.company_display_name ?? ''} onChange={(event) => setBranding({ ...branding, company_display_name: event.target.value })} /></Field>
            <Field label="Primary colour" htmlFor="primary"><Input id="primary" type="color" value={branding.primary_color ?? '#0F5132'} onChange={(event) => setBranding({ ...branding, primary_color: event.target.value })} /></Field>
            <Field label="Accent colour" htmlFor="accent"><Input id="accent" type="color" value={branding.accent_color ?? '#C6A15B'} onChange={(event) => setBranding({ ...branding, accent_color: event.target.value })} /></Field>
            <Field label="Font family" htmlFor="font"><Input id="font" value={branding.font_family ?? 'Inter'} onChange={(event) => setBranding({ ...branding, font_family: event.target.value })} /></Field>
            <Field label="Login headline" htmlFor="headline"><Input id="headline" value={branding.login_headline ?? ''} onChange={(event) => setBranding({ ...branding, login_headline: event.target.value })} /></Field>
            <Field label="Sales Screen theme" htmlFor="screen_theme"><Select id="screen_theme" value={branding.sales_screen_theme ?? 'midnight'} onChange={(event) => setBranding({ ...branding, sales_screen_theme: event.target.value })} options={[{ value: 'midnight', label: 'Midnight' }, { value: 'daylight', label: 'Daylight' }, { value: 'sand', label: 'Sand' }]} /></Field>
            <div><Button type="submit" disabled={!session?.can('organization.branding')}>Save branding</Button></div>
          </form>
        </Card>
      ) : null}

      {tab === 'people' ? (
        <Card
          title="People"
          description="Roles, module access and record scope decide exactly what each person can see."
          actions={session?.can('users.invite') ? <Button size="sm" onClick={() => setInviteOpen(true)}>Invite</Button> : null}
        >
          <DataTable
            rows={users ?? []}
            columns={[
              { key: 'name', header: 'Name', render: (row) => `${row.first_name} ${row.last_name}` },
              { key: 'email', header: 'Email' },
              { key: 'job_title', header: 'Title', render: (row) => row.job_title ?? '—' },
              { key: 'roles', header: 'Roles', render: (row) => (row.roles ?? []).map((role) => role.name).join(', ') },
              { key: 'record_scope', header: 'Scope', render: (row) => titleCase(row.record_scope) },
              { key: 'modules', header: 'Modules', render: (row) => (typeof row.modules === 'string' ? JSON.parse(row.modules) : row.modules ?? []).map(titleCase).join(', ') },
              { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'warning'}>{titleCase(row.status)}</Badge> },
            ]}
          />
        </Card>
      ) : null}

      {tab === 'domains' ? (
        <Card title="Domains" description="Every tenant gets a subdomain. Custom domains verify by DNS TXT record — no redeploy needed.">
          <DataTable
            rows={domains ?? []}
            columns={[
              { key: 'hostname', header: 'Hostname' },
              { key: 'type', header: 'Type', render: (row) => titleCase(row.type) },
              { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'warning'}>{titleCase(row.status)}</Badge> },
              { key: 'verification_token', header: 'DNS TXT record', render: (row) => (row.status === 'active' ? '—' : <span className="mono">{row.verification_token}</span>) },
              {
                key: 'verify',
                header: '',
                render: (row) =>
                  row.status !== 'active' && session?.can('organization.domains') ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        await apiFetchWithRefresh(`/v1/organization/domains/${row.id}/verify`, { method: 'POST' }).catch(() => {});
                        reloadDomains();
                      }}
                    >
                      Verify
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      ) : null}

      {tab === 'audit' ? (
        <Card title="Audit log" description="Append-only. Every actor, action and safe diff.">
          <DataTable
            rows={audit ?? []}
            columns={[
              { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at, intlLocale) },
              { key: 'action', header: 'Action', render: (row) => titleCase(row.action) },
              { key: 'entity_type', header: 'Entity', render: (row) => titleCase(row.entity_type) },
              { key: 'actor_membership_id', header: 'Actor', render: (row) => <span className="mono">{(row.actor_membership_id ?? 'system').slice(-6)}</span> },
              { key: 'request_id', header: 'Request', render: (row) => <span className="mono">{(row.request_id ?? '—').slice(0, 8)}</span> },
            ]}
            empty={<p className="muted">No audit entries visible.</p>}
          />
        </Card>
      ) : null}

      <Drawer open={inviteOpen} title="Invite a colleague" onClose={() => setInviteOpen(false)}>
        <InviteForm
          roles={roles ?? []}
          onDone={() => {
            setInviteOpen(false);
            reloadUsers();
          }}
        />
      </Drawer>
    </>
  );
}

function InviteForm({ roles, onDone }) {
  const [form, setForm] = useState({ email: '', role_codes: ['agent'], modules: ['ready'], record_scope: 'assigned', job_title: '' });
  const [state, setState] = useState({ loading: false, error: null, sent: false });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null, sent: false });
    try {
      await apiFetchWithRefresh('/v1/auth/invitations', { method: 'POST', body: form });
      setState({ loading: false, error: null, sent: true });
      onDone();
    } catch (error) {
      setState({ loading: false, error: error.message, sent: false });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Email" htmlFor="email" required>
        <Input id="email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
      </Field>
      <Field label="Role" htmlFor="role" required>
        <Select id="role" value={form.role_codes[0]} onChange={(event) => setForm({ ...form, role_codes: [event.target.value] })} options={roles.map((role) => ({ value: role.code, label: role.name }))} />
      </Field>
      <Field label="Modules">
        <div className="row">
          {['ready', 'offplan', 'sales_screen', 'finance'].map((module) => (
            <label key={module} className="row" style={{ gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.modules.includes(module)}
                onChange={(event) => setForm({ ...form, modules: event.target.checked ? [...form.modules, module] : form.modules.filter((entry) => entry !== module) })}
              />
              {titleCase(module)}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Record scope" htmlFor="scope" hint="How much data this person can see.">
        <Select id="scope" value={form.record_scope} onChange={(event) => setForm({ ...form, record_scope: event.target.value })} options={[{ value: 'own', label: 'Own records' }, { value: 'assigned', label: 'Assigned records' }, { value: 'team', label: 'Their team' }, { value: 'branch', label: 'Their branch' }, { value: 'organization', label: 'Whole organization' }]} />
      </Field>
      <Field label="Job title" htmlFor="job_title">
        <Input id="job_title" value={form.job_title} onChange={(event) => setForm({ ...form, job_title: event.target.value })} />
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Send invitation</Button>
    </form>
  );
}

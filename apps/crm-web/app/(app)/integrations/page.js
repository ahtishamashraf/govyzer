'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select, Tabs } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function IntegrationsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [tab, setTab] = useState('portals');
  const [drawer, setDrawer] = useState(null);
  const [apiKey, setApiKey] = useState(null);
  const { data: providers } = useApi('/v1/portals/providers');
  const { data: accounts, reload: reloadAccounts } = useApi('/v1/portals/accounts');
  const { data: integrationProviders } = useApi('/v1/integrations/providers');
  const { data: connections, reload: reloadConnections } = useApi('/v1/integrations/connections');
  const { data: health, error, reload } = useApi('/v1/integrations/health');
  const { data: keys, reload: reloadKeys } = useApi('/v1/integrations/api-keys', { enabled: Boolean(session?.can('api_keys.manage')) });

  if (session && !session.can('integrations.read')) return <PermissionDenied permission="integrations.read" />;

  async function testAccount(id) {
    await apiFetchWithRefresh(`/v1/portals/accounts/${id}/test`, { method: 'POST' }).catch(() => {});
    reloadAccounts();
    reload();
  }

  async function testConnection(id) {
    await apiFetchWithRefresh(`/v1/integrations/connections/${id}/test`, { method: 'POST' }).catch(() => {});
    reloadConnections();
    reload();
  }

  async function showFeedUrl(id) {
    const result = await apiFetchWithRefresh(`/v1/portals/accounts/${id}/feed-url`).catch(() => null);
    if (result?.data) setDrawer({ type: 'feed', data: result.data });
  }

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Portals, messaging, email, calendars, e-signature and your own API keys."
        actions={
          session?.can('portals.manage') ? (
            <>
              <Button variant="secondary" onClick={() => setDrawer({ type: 'connection' })}>Connect a channel</Button>
              <Button onClick={() => setDrawer({ type: 'portal' })}>Connect a portal</Button>
            </>
          ) : null
        }
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'portals', label: 'Portals', count: accounts?.length ?? 0 },
          { value: 'channels', label: 'Channels', count: connections?.length ?? 0 },
          { value: 'api', label: 'API & webhooks' },
          { value: 'health', label: 'Health' },
        ]}
      />

      {tab === 'portals' ? (
        <>
          <Card title="Available portals" description="Feed transport works today. Direct API publishing activates once the portal supplies a verified base URL and credentials.">
            <DataTable
              rows={providers ?? []}
              columns={[
                { key: 'name', header: 'Portal' },
                { key: 'transport', header: 'Transport', render: (row) => titleCase(row.transport) },
                { key: 'capabilities', header: 'Capabilities', render: (row) => Object.entries(row.capabilities ?? {}).filter(([, value]) => value === true).map(([key]) => titleCase(key)).join(', ') || '—' },
              ]}
            />
          </Card>

          <Card title="Connected portal accounts">
            <DataTable
              rows={accounts ?? []}
              columns={[
                { key: 'name', header: 'Account' },
                { key: 'provider_code', header: 'Provider', render: (row) => titleCase(row.provider_code) },
                { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'connected' ? 'success' : 'warning'}>{titleCase(row.status)}</Badge> },
                { key: 'health_message', header: 'Health', render: (row) => row.health_message ?? '—' },
                {
                  key: 'actions',
                  header: '',
                  render: (row) => (
                    <div className="row">
                      <Button size="sm" variant="ghost" onClick={() => testAccount(row.id)}>Test</Button>
                      <Button size="sm" variant="ghost" onClick={() => showFeedUrl(row.id)}>Feed URL</Button>
                    </div>
                  ),
                },
              ]}
              empty={<p className="muted">No portal accounts connected yet.</p>}
            />
          </Card>
        </>
      ) : null}

      {tab === 'channels' ? (
        <>
          <Card title="Available channels">
            <DataTable
              rows={integrationProviders ?? []}
              rowKey={(row) => row.code}
              columns={[
                { key: 'name', header: 'Provider' },
                { key: 'category', header: 'Category', render: (row) => titleCase(row.category) },
                { key: 'capabilities', header: 'Capabilities', render: (row) => Object.entries(row.capabilities ?? {}).filter(([, value]) => value === true).map(([key]) => titleCase(key)).join(', ') || '—' },
              ]}
            />
          </Card>
          <Card title="Connections">
            <DataTable
              rows={connections ?? []}
              columns={[
                { key: 'name', header: 'Connection' },
                { key: 'provider', header: 'Provider', render: (row) => titleCase(row.provider) },
                { key: 'health_status', header: 'Health', render: (row) => <Badge tone={row.health_status === 'healthy' ? 'success' : row.health_status === 'error' ? 'danger' : 'warning'}>{row.health_status}</Badge> },
                { key: 'last_success_at', header: 'Last success', render: (row) => (row.last_success_at ? formatDateTime(row.last_success_at, intlLocale) : '—') },
                { key: 'actions', header: '', render: (row) => <Button size="sm" variant="ghost" onClick={() => testConnection(row.id)}>Test</Button> },
              ]}
              empty={<p className="muted">No channels connected yet.</p>}
            />
          </Card>
        </>
      ) : null}

      {tab === 'api' ? (
        <>
          <Card
            title="API keys"
            description="Zapier and your website use a tenant API key with explicit scopes. The plaintext key is shown only once."
            actions={session?.can('api_keys.manage') ? <Button size="sm" onClick={() => setDrawer({ type: 'apikey' })}>Create key</Button> : null}
          >
            <DataTable
              rows={keys ?? []}
              columns={[
                { key: 'name', header: 'Name' },
                { key: 'prefix', header: 'Prefix', render: (row) => <span className="mono">{row.prefix}…</span> },
                { key: 'scopes', header: 'Scopes', render: (row) => (row.scopes ?? []).join(', ') },
                { key: 'last_used_at', header: 'Last used', render: (row) => (row.last_used_at ? formatDateTime(row.last_used_at, intlLocale) : 'Never') },
              ]}
              empty={<p className="muted">No API keys yet.</p>}
            />
          </Card>

          <Card title="Zapier">
            <p className="muted" style={{ marginTop: 0 }}>
              Action: <code>POST /v1/public/leads</code> with the <code>x-api-key</code> header creates a lead and
              deduplicates the contact. Triggers are delivered as signed webhooks: new lead, lead updated, new listing,
              listing published, meeting created, deal won and deal updated.
            </p>
          </Card>
        </>
      ) : null}

      {tab === 'health' ? (
        <Card title="Integration health" description="One place to see every connection, queued webhook and dead letter.">
          <div className="grid grid--stats">
            <div className="gv-stat"><span className="gv-stat__label">Pending webhook deliveries</span><strong className="gv-stat__value">{health?.pending_webhook_deliveries ?? 0}</strong></div>
            <div className="gv-stat"><span className="gv-stat__label">Open dead letters</span><strong className="gv-stat__value">{health?.open_dead_letter_jobs ?? 0}</strong></div>
          </div>
          <DataTable
            rows={[...(health?.connections ?? []), ...(health?.portals ?? [])]}
            rowKey={(row, index) => `${row.provider ?? row.provider_code}-${row.name}-${index}`}
            columns={[
              { key: 'name', header: 'Integration' },
              { key: 'health_status', header: 'Health', render: (row) => <Badge tone={row.health_status === 'healthy' ? 'success' : row.health_status === 'error' ? 'danger' : 'warning'}>{row.health_status}</Badge> },
              { key: 'health_message', header: 'Message', render: (row) => row.health_message ?? '—' },
              { key: 'last_success_at', header: 'Last success', render: (row) => (row.last_success_at ? formatDateTime(row.last_success_at, intlLocale) : '—') },
            ]}
            empty={<p className="muted">Nothing connected yet.</p>}
          />
        </Card>
      ) : null}

      <Drawer open={Boolean(drawer)} title={drawer?.type === 'portal' ? 'Connect a portal' : drawer?.type === 'connection' ? 'Connect a channel' : drawer?.type === 'apikey' ? 'Create an API key' : 'Feed URL'} onClose={() => setDrawer(null)}>
        {drawer?.type === 'portal' ? (
          <PortalForm providers={providers ?? []} onDone={() => { setDrawer(null); reloadAccounts(); }} />
        ) : null}
        {drawer?.type === 'connection' ? (
          <ConnectionForm providers={integrationProviders ?? []} onDone={() => { setDrawer(null); reloadConnections(); }} />
        ) : null}
        {drawer?.type === 'apikey' ? (
          <ApiKeyForm
            onDone={(created) => {
              setApiKey(created);
              reloadKeys();
            }}
            created={apiKey}
          />
        ) : null}
        {drawer?.type === 'feed' ? (
          <div className="stack">
            <p className="muted" style={{ marginTop: 0 }}>{drawer.data.instructions}</p>
            <Field label="XML feed" htmlFor="xml"><Input id="xml" readOnly value={drawer.data.feed_url} /></Field>
            <Field label="JSON feed" htmlFor="json"><Input id="json" readOnly value={drawer.data.json_feed_url} /></Field>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

function PortalForm({ providers, onDone }) {
  const [form, setForm] = useState({ provider_code: providers[0]?.code ?? 'property_finder', name: '', account_reference: '', api_base_url: '', api_key: '' });
  const [state, setState] = useState({ loading: false, error: null, result: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null, result: null });
    try {
      const credentials = { feed_enabled: true, account_reference: form.account_reference || undefined };
      if (form.api_base_url) credentials.api_base_url = form.api_base_url;
      if (form.api_key) credentials.api_key = form.api_key;
      const result = await apiFetchWithRefresh('/v1/portals/accounts', {
        method: 'POST',
        body: { provider_code: form.provider_code, name: form.name, credentials, auto_publish: false, is_enabled: true },
      });
      setState({ loading: false, error: null, result: result.data.health });
      onDone();
    } catch (error) {
      setState({ loading: false, error: error.message, result: null });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Portal" htmlFor="provider_code" required>
        <Select id="provider_code" value={form.provider_code} onChange={(event) => setForm({ ...form, provider_code: event.target.value })} options={providers.map((provider) => ({ value: provider.code, label: provider.name }))} />
      </Field>
      <Field label="Account name" htmlFor="name" required>
        <Input id="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Portal account reference" htmlFor="account_reference" hint="Your agency identifier with the portal, if they issued one.">
        <Input id="account_reference" value={form.account_reference} onChange={(event) => setForm({ ...form, account_reference: event.target.value })} />
      </Field>
      <Field label="API base URL" htmlFor="api_base_url" hint="Optional. Without it the portal pulls your feed URL instead of receiving direct API pushes.">
        <Input id="api_base_url" type="url" value={form.api_base_url} onChange={(event) => setForm({ ...form, api_base_url: event.target.value })} />
      </Field>
      <Field label="API key" htmlFor="api_key" hint="Stored encrypted with AES-256-GCM and never shown again.">
        <Input id="api_key" type="password" value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} />
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Connect portal</Button>
    </form>
  );
}

function ConnectionForm({ providers, onDone }) {
  const [form, setForm] = useState({ provider: 'whatsyncs', category: 'messaging', name: '', base_url: '', api_key: '', instance_id: '', webhook_secret: '' });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      const credentials = {};
      if (form.base_url) credentials.base_url = form.base_url;
      if (form.api_key) credentials.api_key = form.api_key;
      if (form.instance_id) credentials.instance_id = form.instance_id;
      if (form.webhook_secret) credentials.webhook_secret = form.webhook_secret;
      await apiFetchWithRefresh('/v1/integrations/connections', {
        method: 'POST',
        body: { provider: form.provider, category: form.category, name: form.name, credentials, settings: {}, is_enabled: true },
      });
      onDone();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Provider" htmlFor="provider" required>
        <Select
          id="provider"
          value={form.provider}
          onChange={(event) => {
            const provider = providers.find((entry) => entry.code === event.target.value);
            setForm({ ...form, provider: event.target.value, category: provider?.category ?? 'messaging' });
          }}
          options={providers.map((provider) => ({ value: provider.code, label: provider.name }))}
        />
      </Field>
      <Field label="Connection name" htmlFor="name" required>
        <Input id="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Base URL" htmlFor="base_url" hint="Whatsyncs and self-hosted providers need their own base URL.">
        <Input id="base_url" type="url" value={form.base_url} onChange={(event) => setForm({ ...form, base_url: event.target.value })} />
      </Field>
      <Field label="API key / access token" htmlFor="api_key">
        <Input id="api_key" type="password" value={form.api_key} onChange={(event) => setForm({ ...form, api_key: event.target.value })} />
      </Field>
      <Field label="Instance id" htmlFor="instance_id">
        <Input id="instance_id" value={form.instance_id} onChange={(event) => setForm({ ...form, instance_id: event.target.value })} />
      </Field>
      <Field label="Webhook signing secret" htmlFor="webhook_secret">
        <Input id="webhook_secret" type="password" value={form.webhook_secret} onChange={(event) => setForm({ ...form, webhook_secret: event.target.value })} />
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Connect and verify</Button>
    </form>
  );
}

function ApiKeyForm({ onDone, created }) {
  const [form, setForm] = useState({ name: '', scopes: ['leads.create'] });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      const result = await apiFetchWithRefresh('/v1/integrations/api-keys', { method: 'POST', body: form });
      onDone(result.data);
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  if (created) {
    return (
      <div className="stack">
        <p style={{ marginTop: 0 }}>Copy this key now. It is never shown again.</p>
        <Input readOnly value={created.api_key} aria-label="API key" />
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Key name" htmlFor="name" required>
        <Input id="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Scopes" htmlFor="scopes">
        <div className="row">
          {['leads.create', 'leads.read', 'listings.read', 'contacts.read'].map((scope) => (
            <label key={scope} className="row" style={{ gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.scopes.includes(scope)}
                onChange={(event) => setForm({ ...form, scopes: event.target.checked ? [...form.scopes, scope] : form.scopes.filter((entry) => entry !== scope) })}
              />
              {scope}
            </label>
          ))}
        </div>
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Create key</Button>
    </form>
  );
}

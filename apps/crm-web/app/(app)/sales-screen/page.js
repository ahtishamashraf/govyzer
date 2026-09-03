'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select, Tabs } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, formatMoney, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function SalesScreenPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [tab, setTab] = useState('displays');
  const [drawer, setDrawer] = useState(null);
  const { data: displays, loading, error, reload } = useApi('/v1/sales-screen/displays');
  const { data: playlists } = useApi('/v1/sales-screen/playlists');
  const { data: events, reload: reloadEvents } = useApi('/v1/sales-screen/events?per_page=25');
  const { data: rules } = useApi('/v1/sales-screen/points/rules');
  const { data: leaderboard } = useApi('/v1/sales-screen/points/leaderboard?limit=10');
  const { data: targets } = useApi('/v1/sales-screen/targets');
  const currency = session?.organization?.currency ?? 'AED';

  if (session && !session.can('sales_screen.read')) return <PermissionDenied permission="sales_screen.read" />;

  async function pair(displayId) {
    const result = await apiFetchWithRefresh(`/v1/sales-screen/displays/${displayId}/pairing-code`, { method: 'POST' }).catch(() => null);
    if (result?.data) setDrawer({ type: 'pairing', data: result.data });
    reload();
  }

  async function revoke(displayId) {
    await apiFetchWithRefresh(`/v1/sales-screen/displays/${displayId}/revoke`, { method: 'POST', body: { reason: 'Revoked from CRM' } }).catch(() => {});
    reload();
  }

  async function approveEvent(eventId, decision) {
    await apiFetchWithRefresh(`/v1/sales-screen/events/${eventId}/approval`, { method: 'POST', body: { decision } }).catch(() => {});
    reloadEvents();
  }

  return (
    <>
      <PageHeader
        title="Sales Screen"
        description="Pair office displays, choose what they show and keep client details off the wall."
        actions={session?.can('sales_screen.manage') ? <Button onClick={() => setDrawer({ type: 'display' })}>New display</Button> : null}
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'displays', label: 'Displays', count: displays?.length ?? 0 },
          { value: 'events', label: 'Events', count: events?.length ?? 0 },
          { value: 'points', label: 'Points & targets' },
        ]}
      />

      {tab === 'displays' ? (
        <>
          <Card title="Displays">
            <DataTable
              loading={loading}
              rows={displays ?? []}
              columns={[
                { key: 'name', header: 'Display' },
                { key: 'location', header: 'Location', render: (row) => row.location ?? '—' },
                { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'paired' ? 'success' : row.status === 'revoked' ? 'danger' : 'warning'}>{titleCase(row.status)}</Badge> },
                { key: 'is_online', header: 'Online', render: (row) => <Badge tone={row.is_online ? 'success' : 'neutral'}>{row.is_online ? 'Online' : 'Offline'}</Badge> },
                { key: 'last_seen_at', header: 'Last seen', render: (row) => (row.last_seen_at ? relativeTime(row.last_seen_at) : 'Never') },
                { key: 'app_version', header: 'Version', render: (row) => row.app_version ?? '—' },
                {
                  key: 'actions',
                  header: '',
                  render: (row) =>
                    session?.can('sales_screen.manage') ? (
                      <div className="row">
                        <Button size="sm" variant="secondary" onClick={() => pair(row.id)}>Pair</Button>
                        <Button size="sm" variant="ghost" onClick={() => setDrawer({ type: 'preview', id: row.id })}>Preview</Button>
                        <Button size="sm" variant="danger" onClick={() => revoke(row.id)}>Revoke</Button>
                      </div>
                    ) : null,
                },
              ]}
              empty={<p className="muted">No displays yet. Create one and pair it with the Sales Screen app.</p>}
            />
          </Card>

          <Card title="Playlists" description="Slides are shown in order on every display using this playlist.">
            <DataTable
              rows={playlists ?? []}
              columns={[
                { key: 'name', header: 'Playlist' },
                { key: 'is_default', header: 'Default', render: (row) => (row.is_default ? 'Yes' : '—') },
                { key: 'slides', header: 'Slides', render: (row) => (row.slides ?? []).map((slide) => titleCase(slide.slide_type)).join(', ') },
              ]}
            />
          </Card>
        </>
      ) : null}

      {tab === 'events' ? (
        <Card title="Sales events" description="Events are generated from real, approved CRM activity and never carry client PII.">
          <DataTable
            rows={events ?? []}
            columns={[
              { key: 'event_type', header: 'Event', render: (row) => titleCase(row.event_type) },
              { key: 'display_payload', header: 'Headline', render: (row) => row.display_payload?.headline ?? '—' },
              { key: 'amount', header: 'Amount', render: (row) => formatMoney(row.amount, row.currency ?? currency, intlLocale, { compact: true }) },
              { key: 'points_awarded', header: 'Points' },
              { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'approved' ? 'success' : row.status === 'rejected' || row.status === 'reversed' ? 'danger' : 'warning'}>{titleCase(row.status)}</Badge> },
              { key: 'occurred_at', header: 'Occurred', render: (row) => formatDateTime(row.occurred_at, intlLocale) },
              {
                key: 'actions',
                header: '',
                render: (row) =>
                  row.status === 'pending' && session?.can('sales_screen.approve_events') ? (
                    <div className="row">
                      <Button size="sm" onClick={() => approveEvent(row.id, 'approved')}>Approve</Button>
                      <Button size="sm" variant="ghost" onClick={() => approveEvent(row.id, 'rejected')}>Reject</Button>
                    </div>
                  ) : null,
              },
            ]}
            empty={<p className="muted">No events yet. Win a deal or publish a listing to see one here.</p>}
          />
        </Card>
      ) : null}

      {tab === 'points' ? (
        <div className="grid grid--2">
          <Card title="Points rules" description="Every award is written to an append-only ledger with its rule version.">
            <DataTable
              rows={rules ?? []}
              columns={[
                { key: 'name', header: 'Rule' },
                { key: 'event_type', header: 'Event', render: (row) => titleCase(row.event_type) },
                { key: 'points', header: 'Points' },
                { key: 'is_active', header: 'Active', render: (row) => (row.is_active ? 'Yes' : 'No') },
              ]}
            />
          </Card>
          <Card title="Leaderboard" description="Recomputed from the ledger, never from a mutable total.">
            <DataTable
              rows={leaderboard ?? []}
              rowKey={(row) => row.key}
              columns={[
                { key: 'rank', header: '#' },
                { key: 'key', header: 'Membership', render: (row) => <span className="mono">{row.key.slice(-6)}</span> },
                { key: 'points', header: 'Points' },
              ]}
              empty={<p className="muted">No points awarded yet.</p>}
            />
          </Card>
          <Card title="Targets">
            <DataTable
              rows={targets ?? []}
              columns={[
                { key: 'target_type', header: 'Target', render: (row) => titleCase(row.target_type) },
                { key: 'scope_type', header: 'Scope', render: (row) => titleCase(row.scope_type) },
                { key: 'target_value', header: 'Value', render: (row) => formatMoney(row.target_value, row.currency ?? currency, intlLocale, { compact: true }) },
                { key: 'period_start', header: 'Period', render: (row) => `${formatDateTime(row.period_start, intlLocale)}` },
              ]}
              empty={<p className="muted">No targets set.</p>}
            />
          </Card>
        </div>
      ) : null}

      <Drawer
        open={Boolean(drawer)}
        title={drawer?.type === 'display' ? 'New display' : drawer?.type === 'pairing' ? 'Pair this display' : 'Display preview'}
        onClose={() => setDrawer(null)}
      >
        {drawer?.type === 'display' ? (
          <DisplayForm
            playlists={playlists ?? []}
            onDone={() => {
              setDrawer(null);
              reload();
            }}
          />
        ) : null}
        {drawer?.type === 'pairing' ? (
          <div className="stack">
            <p style={{ marginTop: 0 }}>Open the Sales Screen app and enter this one-time code. It expires in {Math.round(drawer.data.ttl_seconds / 60)} minutes.</p>
            <div style={{ fontSize: 40, letterSpacing: '0.25em', fontWeight: 700, textAlign: 'center', padding: '18px 0' }}>{drawer.data.code}</div>
            <Field label="Or open this URL on the display" htmlFor="pair_url">
              <Input id="pair_url" readOnly value={drawer.data.pairing_url} />
            </Field>
            <p className="muted">The code is single use and stored only as a hash. Pairing grants a display-scoped session that can read the approved feed and nothing else.</p>
          </div>
        ) : null}
        {drawer?.type === 'preview' ? <DisplayPreview displayId={drawer.id} /> : null}
      </Drawer>
    </>
  );
}

function DisplayForm({ playlists, onDone }) {
  const [form, setForm] = useState({ name: '', location: '', playlist_id: playlists.find((playlist) => playlist.is_default)?.id ?? '', theme: 'midnight', slide_duration_seconds: 15, mask_agent_names: false, mask_amounts: false });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      await apiFetchWithRefresh('/v1/sales-screen/displays', {
        method: 'POST',
        body: {
          name: form.name,
          location: form.location || undefined,
          playlist_id: form.playlist_id || undefined,
          theme: form.theme,
          slide_duration_seconds: Number(form.slide_duration_seconds),
          privacy_settings: { mask_agent_names: form.mask_agent_names, mask_amounts: form.mask_amounts, hide_exact_address: true, show_client_initials_only: true },
        },
      });
      onDone();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Display name" htmlFor="name" required>
        <Input id="name" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </Field>
      <Field label="Location" htmlFor="location">
        <Input id="location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
      </Field>
      <Field label="Playlist" htmlFor="playlist">
        <Select id="playlist" value={form.playlist_id} placeholder="Default playlist" onChange={(event) => setForm({ ...form, playlist_id: event.target.value })} options={playlists.map((playlist) => ({ value: playlist.id, label: playlist.name }))} />
      </Field>
      <Field label="Theme" htmlFor="theme">
        <Select id="theme" value={form.theme} onChange={(event) => setForm({ ...form, theme: event.target.value })} options={[{ value: 'midnight', label: 'Midnight' }, { value: 'daylight', label: 'Daylight' }, { value: 'sand', label: 'Sand' }]} />
      </Field>
      <Field label="Seconds per slide" htmlFor="duration">
        <Input id="duration" type="number" min="5" max="120" value={form.slide_duration_seconds} onChange={(event) => setForm({ ...form, slide_duration_seconds: event.target.value })} />
      </Field>
      <Field label="Privacy">
        <div className="stack" style={{ gap: 6 }}>
          <label className="row" style={{ gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.mask_agent_names} onChange={(event) => setForm({ ...form, mask_agent_names: event.target.checked })} />
            Mask agent names (show initials only)
          </label>
          <label className="row" style={{ gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={form.mask_amounts} onChange={(event) => setForm({ ...form, mask_amounts: event.target.checked })} />
            Hide amounts
          </label>
          <p className="muted" style={{ margin: 0 }}>Client names, phone numbers, emails and exact addresses are never sent to a display.</p>
        </div>
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Create display</Button>
    </form>
  );
}

function DisplayPreview({ displayId }) {
  const { data, loading, error } = useApi(`/v1/sales-screen/displays/${displayId}/preview`);
  if (loading) return <p className="muted">Loading preview…</p>;
  if (error) return <p style={{ color: '#b42318' }}>{error.message}</p>;
  if (!data) return null;

  return (
    <div className="stack">
      <p className="muted" style={{ marginTop: 0 }}>Exactly what this display will render right now.</p>
      <dl className="kv">
        <dt>Revenue</dt><dd>{data.metrics.revenue ?? 'Hidden'}</dd>
        <dt>Deals</dt><dd>{data.metrics.deal_count}</dd>
        <dt>Listings live</dt><dd>{data.metrics.listing_count}</dd>
        <dt>Events queued</dt><dd>{data.events.length}</dd>
        <dt>Slides</dt><dd>{data.slides.map((slide) => slide.type).join(', ')}</dd>
      </dl>
    </div>
  );
}

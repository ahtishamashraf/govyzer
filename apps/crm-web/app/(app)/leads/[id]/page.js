'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, DataTable, ErrorState, Field, Select, Skeleton, StatusBadge, Tabs, Textarea } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, formatMoney, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function LeadDetailPage({ params }) {
  const { id } = use(params);
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: lead, loading, error, reload } = useApi(`/v1/leads/${id}`);
  const { data: pipeline } = useApi(`/v1/leads/pipeline${lead ? `?module=${lead.module}` : ''}`, { enabled: Boolean(lead), deps: [lead?.module] });
  const { data: users } = useApi('/v1/users?per_page=100&assignable=true', { enabled: Boolean(session?.can('leads.assign')) });
  const [tab, setTab] = useState('overview');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const currency = session?.organization?.currency ?? 'AED';

  if (loading) return <Skeleton rows={8} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!lead) return null;

  async function changeStage(stageCode) {
    setBusy(true);
    await apiFetchWithRefresh(`/v1/leads/${id}/stage`, { method: 'POST', body: { stage_code: stageCode } }).catch(() => {});
    setBusy(false);
    reload();
  }

  async function assign(membershipId) {
    setBusy(true);
    await apiFetchWithRefresh(`/v1/leads/${id}/assign`, { method: 'POST', body: membershipId ? { membership_id: membershipId } : { auto: true } }).catch(() => {});
    setBusy(false);
    reload();
  }

  async function acknowledge() {
    setBusy(true);
    await apiFetchWithRefresh(`/v1/leads/${id}/acknowledge`, { method: 'POST' }).catch(() => {});
    setBusy(false);
    reload();
  }

  async function addNote(event) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    await apiFetchWithRefresh('/v1/activities/notes', { method: 'POST', body: { entity_type: 'lead', entity_id: id, body: note } }).catch(() => {});
    setNote('');
    setBusy(false);
    reload();
  }

  async function releaseToPool() {
    setBusy(true);
    await apiFetchWithRefresh(`/v1/leads/${id}/release-to-pool`, { method: 'POST', body: { reason: 'Released from lead detail' } }).catch(() => {});
    setBusy(false);
    reload();
  }

  return (
    <>
      <PageHeader
        title={lead.contact?.display_name ?? lead.reference}
        description={`${lead.reference} · ${titleCase(lead.module)} · ${titleCase(lead.purpose)}`}
        actions={
          <>
            {!lead.acknowledged_at ? <Button variant="secondary" onClick={acknowledge} loading={busy}>Acknowledge</Button> : null}
            {session?.can('leads.pool_manage') && !lead.is_in_pool ? <Button variant="ghost" onClick={releaseToPool}>Release to pool</Button> : null}
            <Link href={`/contacts/${lead.contact_id}`} className="gv-btn gv-btn--secondary gv-btn--md">Open contact</Link>
          </>
        }
      />

      <div className="row">
        <StatusBadge status={lead.stage_code} />
        <Badge tone={lead.sla_status === 'breached' ? 'danger' : lead.sla_status === 'met' ? 'success' : 'warning'}>SLA {lead.sla_status}</Badge>
        {lead.is_in_pool ? <Badge tone="warning">In pool</Badge> : null}
        {lead.score != null ? <Badge tone="info">Score {lead.score}</Badge> : null}
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'requirements', label: 'Requirements', count: lead.requirements?.length ?? 0 },
          { value: 'activity', label: 'Activity', count: (lead.notes?.length ?? 0) + (lead.meetings?.length ?? 0) },
          { value: 'assignment', label: 'Assignment trail', count: lead.assignment_history?.length ?? 0 },
        ]}
      />

      {tab === 'overview' ? (
        <div className="detail-grid">
          <div className="stack">
            <Card title="Lead">
              <dl className="kv">
                <dt>Reference</dt><dd className="mono">{lead.reference}</dd>
                <dt>Budget</dt><dd>{formatMoney(lead.estimated_value, currency, intlLocale)}</dd>
                <dt>Timeframe</dt><dd>{titleCase(lead.timeframe ?? 'not captured')}</dd>
                <dt>Financing</dt><dd>{titleCase(lead.financing ?? 'not captured')}</dd>
                <dt>Language</dt><dd>{lead.language === 'ar' ? 'Arabic' : 'English'}</dd>
                <dt>Created</dt><dd>{formatDateTime(lead.created_at, intlLocale)}</dd>
                <dt>First response</dt><dd>{lead.first_response_at ? formatDateTime(lead.first_response_at, intlLocale) : 'Awaiting first response'}</dd>
                <dt>Next action</dt><dd>{lead.next_action ?? '—'}</dd>
              </dl>
            </Card>

            {lead.notes?.length ? (
              <Card title="Notes">
                <div className="timeline">
                  {lead.notes.map((entry) => (
                    <div key={entry.id} className="timeline__item">
                      <span className="timeline__dot" aria-hidden="true">✎</span>
                      <div>
                        <p className="timeline__body" style={{ margin: 0 }}>{entry.body}</p>
                        <span className="timeline__meta">{formatDateTime(entry.created_at, intlLocale)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}

            <Card title="Add a note">
              <form onSubmit={addNote} className="stack">
                <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What happened on this lead?" aria-label="Note" />
                <Button type="submit" loading={busy} disabled={!note.trim()}>Save note</Button>
              </form>
            </Card>
          </div>

          <div className="stack">
            <Card title="Stage">
              <Field label="Move to stage" htmlFor="stage">
                <Select
                  id="stage"
                  value={lead.stage_code}
                  disabled={busy || !session?.can('leads.update')}
                  onChange={(event) => changeStage(event.target.value)}
                  options={(pipeline ?? []).map((stage) => ({ value: stage.code, label: stage.name?.en ?? stage.code }))}
                />
              </Field>
            </Card>

            <Card title="Assignment">
              <dl className="kv">
                <dt>Owner</dt><dd>{lead.assigned_membership_id ?? 'Unassigned'}</dd>
                <dt>Manager</dt><dd>{lead.manager_membership_id ?? '—'}</dd>
                <dt>Assigned</dt><dd>{lead.assigned_at ? relativeTime(lead.assigned_at) : '—'}</dd>
              </dl>
              {session?.can('leads.assign') ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  <Field label="Reassign to" htmlFor="assignee">
                    <Select
                      id="assignee"
                      value=""
                      placeholder="Choose an agent"
                      onChange={(event) => event.target.value && assign(event.target.value)}
                      options={(users ?? []).map((user) => ({ value: user.id, label: `${user.first_name} ${user.last_name}` }))}
                    />
                  </Field>
                  <Button variant="secondary" onClick={() => assign(null)} loading={busy}>Run assignment rules</Button>
                </div>
              ) : null}
            </Card>

            <Card title="SLA timeline">
              <div className="timeline">
                {(lead.sla_events ?? []).map((event) => (
                  <div key={event.id} className="timeline__item">
                    <span className="timeline__dot" aria-hidden="true">{event.status === 'resolved' ? '✓' : event.status === 'triggered' ? '!' : '·'}</span>
                    <div>
                      <p className="timeline__body" style={{ margin: 0 }}>{titleCase(event.event_type)}</p>
                      <span className="timeline__meta">Due {formatDateTime(event.due_at, intlLocale)} · {event.status}</span>
                    </div>
                  </div>
                ))}
                {(lead.sla_events ?? []).length === 0 ? <p className="muted">No SLA timers scheduled.</p> : null}
              </div>
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'requirements' ? (
        <Card title="Requirements" description="A lead can carry several simultaneous requirements.">
          <DataTable
            rows={lead.requirements ?? []}
            columns={[
              { key: 'purpose', header: 'Purpose', render: (row) => titleCase(row.purpose) },
              { key: 'property_types', header: 'Property types', render: (row) => (row.property_types ?? []).map(titleCase).join(', ') || '—' },
              { key: 'bedrooms', header: 'Bedrooms', render: (row) => [row.bedrooms_min, row.bedrooms_max].filter((value) => value != null).join(' – ') || '—' },
              { key: 'budget', header: 'Budget', render: (row) => `${formatMoney(row.budget_min, currency, intlLocale, { compact: true })} – ${formatMoney(row.budget_max, currency, intlLocale, { compact: true })}` },
              { key: 'handover', header: 'Handover', render: (row) => (row.handover_from ? `${formatDateTime(row.handover_from, intlLocale)}` : '—') },
            ]}
          />
        </Card>
      ) : null}

      {tab === 'activity' ? (
        <div className="grid grid--2">
          <Card title="Meetings">
            <DataTable
              rows={lead.meetings ?? []}
              columns={[
                { key: 'title', header: 'Title' },
                { key: 'starts_at', header: 'Starts', render: (row) => formatDateTime(row.starts_at, intlLocale) },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              ]}
            />
          </Card>
          <Card title="Viewings">
            <DataTable
              rows={lead.viewings ?? []}
              columns={[
                { key: 'scheduled_at', header: 'Scheduled', render: (row) => formatDateTime(row.scheduled_at, intlLocale) },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                { key: 'feedback', header: 'Feedback', render: (row) => row.feedback ?? '—' },
              ]}
            />
          </Card>
          <Card title="Tasks">
            <DataTable
              rows={lead.tasks ?? []}
              columns={[
                { key: 'title', header: 'Task' },
                { key: 'due_at', header: 'Due', render: (row) => (row.due_at ? formatDateTime(row.due_at, intlLocale) : '—') },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              ]}
            />
          </Card>
          <Card title="Stage history">
            <div className="timeline">
              {(lead.stage_history ?? []).map((entry) => (
                <div key={entry.id} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true">→</span>
                  <div>
                    <p className="timeline__body" style={{ margin: 0 }}>
                      {entry.from_stage_code ? `${titleCase(entry.from_stage_code)} → ` : ''}
                      {titleCase(entry.to_stage_code)}
                    </p>
                    <span className="timeline__meta">{formatDateTime(entry.created_at, intlLocale)} {entry.reason ? `· ${entry.reason}` : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'assignment' ? (
        <Card title="Assignment decisions" description="Every rule evaluated, every candidate considered and why this owner was chosen.">
          <div className="timeline">
            {(lead.assignment_history ?? []).map((entry) => (
              <div key={entry.id} className="timeline__item">
                <span className="timeline__dot" aria-hidden="true">◎</span>
                <div>
                  <p className="timeline__body" style={{ margin: 0 }}>
                    {entry.reason} {entry.is_manual_override ? '(manual override)' : ''}
                  </p>
                  <span className="timeline__meta">
                    {formatDateTime(entry.created_at, intlLocale)} · strategy {entry.strategy ?? 'n/a'} · {entry.candidates?.length ?? 0} candidates evaluated
                  </span>
                </div>
              </div>
            ))}
            {(lead.assignment_history ?? []).length === 0 ? <p className="muted">No assignment decisions recorded.</p> : null}
          </div>
        </Card>
      ) : null}
    </>
  );
}

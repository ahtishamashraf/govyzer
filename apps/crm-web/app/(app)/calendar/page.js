'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, Card, DataTable, Drawer, ErrorState, Field, Input, PermissionDenied, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, buildQuery, useApi, useSession } from '@/lib/api-client';
import { formatDate, formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

function weekRange(offset = 0) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() + offset * 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { from: start, to: end };
}

export default function CalendarPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const { from, to } = useMemo(() => weekRange(offset), [offset]);
  const query = buildQuery({ from: from.toISOString(), to: to.toISOString(), per_page: 200 });
  const { data: meetings, loading, error, reload } = useApi(`/v1/activities/meetings${query}`, { deps: [query] });

  if (session && !session.can('activities.read')) return <PermissionDenied permission="activities.read" />;

  const days = Array.from({ length: 7 }).map((_, index) => {
    const day = new Date(from);
    day.setUTCDate(day.getUTCDate() + index);
    return day;
  });

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Meetings, viewings and site visits for the week."
        actions={
          <>
            <Button variant="ghost" onClick={() => setOffset(offset - 1)}>Previous</Button>
            <Button variant="ghost" onClick={() => setOffset(0)}>This week</Button>
            <Button variant="ghost" onClick={() => setOffset(offset + 1)}>Next</Button>
            {session?.can('activities.manage') ? <Button onClick={() => setCreateOpen(true)}>New meeting</Button> : null}
          </>
        }
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {days.map((day) => {
          const dayMeetings = (meetings ?? []).filter((meeting) => new Date(meeting.starts_at).toDateString() === day.toDateString());
          return (
            <Card key={day.toISOString()} title={formatDate(day, intlLocale, { weekday: 'short', day: 'numeric', month: 'short' })}>
              <div className="stack" style={{ gap: 8 }}>
                {dayMeetings.length === 0 ? <p className="muted" style={{ fontSize: 12 }}>Nothing scheduled</p> : null}
                {dayMeetings.map((meeting) => (
                  <div key={meeting.id} className="kanban__card">
                    <h4>{meeting.title}</h4>
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      {formatDateTime(meeting.starts_at, intlLocale)} · {titleCase(meeting.meeting_type)}
                    </p>
                    <Badge tone={meeting.status === 'completed' ? 'success' : meeting.status === 'cancelled' ? 'danger' : 'info'}>{titleCase(meeting.status)}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="All meetings this week">
        <DataTable
          loading={loading}
          rows={meetings ?? []}
          columns={[
            { key: 'title', header: 'Title' },
            { key: 'meeting_type', header: 'Type', render: (row) => titleCase(row.meeting_type) },
            { key: 'starts_at', header: 'Starts', render: (row) => formatDateTime(row.starts_at, intlLocale) },
            { key: 'location', header: 'Location', render: (row) => row.location ?? titleCase(row.location_type) },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'completed' ? 'success' : 'info'}>{titleCase(row.status)}</Badge> },
          ]}
          empty={<p className="muted">No meetings this week.</p>}
        />
      </Card>

      <Drawer open={createOpen} title="New meeting" onClose={() => setCreateOpen(false)}>
        <MeetingForm
          onCreated={() => {
            setCreateOpen(false);
            reload();
          }}
        />
      </Drawer>
    </>
  );
}

function MeetingForm({ onCreated }) {
  const [form, setForm] = useState({ title: '', meeting_type: 'client_meeting', module: 'ready', starts_at: '', ends_at: '', location: '', location_type: 'office' });
  const [state, setState] = useState({ loading: false, error: null });

  async function submit(event) {
    event.preventDefault();
    setState({ loading: true, error: null });
    try {
      await apiFetchWithRefresh('/v1/activities/meetings', {
        method: 'POST',
        body: { ...form, starts_at: new Date(form.starts_at).toISOString(), ends_at: new Date(form.ends_at).toISOString() },
      });
      onCreated();
    } catch (error) {
      setState({ loading: false, error: error.message });
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <Field label="Title" htmlFor="title" required>
        <Input id="title" required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </Field>
      <Field label="Type" htmlFor="meeting_type">
        <Select id="meeting_type" value={form.meeting_type} onChange={(event) => setForm({ ...form, meeting_type: event.target.value })} options={[{ value: 'client_meeting', label: 'Client meeting' }, { value: 'viewing', label: 'Viewing' }, { value: 'site_visit', label: 'Site visit' }, { value: 'call', label: 'Call' }, { value: 'internal', label: 'Internal' }]} />
      </Field>
      <Field label="Starts" htmlFor="starts_at" required>
        <Input id="starts_at" type="datetime-local" required value={form.starts_at} onChange={(event) => setForm({ ...form, starts_at: event.target.value })} />
      </Field>
      <Field label="Ends" htmlFor="ends_at" required>
        <Input id="ends_at" type="datetime-local" required value={form.ends_at} onChange={(event) => setForm({ ...form, ends_at: event.target.value })} />
      </Field>
      <Field label="Location" htmlFor="location">
        <Input id="location" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
      </Field>
      {state.error ? <p role="alert" style={{ color: '#b42318', fontSize: 13 }}>{state.error}</p> : null}
      <Button type="submit" loading={state.loading}>Create meeting</Button>
    </form>
  );
}

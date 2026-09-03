'use client';

import { useEffect, useState } from 'react';
import { Button, Card, DataTable, Field, Input, Select } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ProfilePage() {
  const { session, reload } = useSession();
  const { intlLocale } = useI18n();
  const { data: sessions, reload: reloadSessions } = useApi('/v1/auth/sessions');
  const [form, setForm] = useState({ first_name: '', last_name: '', phone: '', locale: 'en', timezone: 'Asia/Dubai' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (session?.user) {
      setForm({
        first_name: session.user.first_name ?? '',
        last_name: session.user.last_name ?? '',
        phone: session.user.phone ?? '',
        locale: session.user.locale ?? 'en',
        timezone: 'Asia/Dubai',
      });
    }
  }, [session]);

  async function save(event) {
    event.preventDefault();
    await apiFetchWithRefresh('/v1/users/me', { method: 'PATCH', body: form }).catch(() => {});
    setSaved(true);
    reload();
  }

  async function revoke(sessionId) {
    await apiFetchWithRefresh(`/v1/auth/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    reloadSessions();
  }

  return (
    <>
      <PageHeader title="Your profile" description="Personal details, language and active sessions." />
      {saved ? <div className="gv-toast gv-toast--success" role="status"><span>Profile saved.</span></div> : null}

      <Card title="Profile">
        <form onSubmit={save} className="grid grid--2">
          <Field label="First name" htmlFor="first_name"><Input id="first_name" value={form.first_name} onChange={(event) => setForm({ ...form, first_name: event.target.value })} /></Field>
          <Field label="Last name" htmlFor="last_name"><Input id="last_name" value={form.last_name} onChange={(event) => setForm({ ...form, last_name: event.target.value })} /></Field>
          <Field label="Phone" htmlFor="phone"><Input id="phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
          <Field label="Language" htmlFor="locale"><Select id="locale" value={form.locale} onChange={(event) => setForm({ ...form, locale: event.target.value })} options={[{ value: 'en', label: 'English' }, { value: 'ar', label: 'العربية' }]} /></Field>
          <div><Button type="submit">Save profile</Button></div>
        </form>
      </Card>

      <Card title="Active sessions" description="Revoke any session you do not recognise.">
        <DataTable
          rows={sessions ?? []}
          columns={[
            { key: 'created_at', header: 'Signed in', render: (row) => formatDateTime(row.created_at, intlLocale) },
            { key: 'ip_address', header: 'IP', render: (row) => row.ip_address ?? '—' },
            { key: 'user_agent', header: 'Device', render: (row) => (row.user_agent ?? '—').slice(0, 60) },
            { key: 'revoked_at', header: 'Status', render: (row) => (row.revoked_at ? 'Revoked' : 'Active') },
            { key: 'actions', header: '', render: (row) => (!row.revoked_at ? <Button size="sm" variant="ghost" onClick={() => revoke(row.id)}>Revoke</Button> : null) },
          ]}
        />
      </Card>
    </>
  );
}

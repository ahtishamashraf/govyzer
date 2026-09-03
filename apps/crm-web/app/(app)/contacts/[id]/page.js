'use client';

import { use } from 'react';
import Link from 'next/link';
import { Badge, Card, DataTable, ErrorState, Skeleton, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { useApi } from '@/lib/api-client';
import { formatDateTime, relativeTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ContactDetailPage({ params }) {
  const { id } = use(params);
  const { intlLocale } = useI18n();
  const { data: contact, loading, error, reload } = useApi(`/v1/contacts/${id}`);
  const { data: timeline } = useApi(`/v1/contacts/${id}/timeline?limit=40`);

  if (loading) return <Skeleton rows={8} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!contact) return null;

  return (
    <>
      <PageHeader title={contact.display_name} description={`${contact.reference} · ${titleCase(contact.contact_type)}`} />

      <div className="row">
        {(contact.roles ?? []).map((role) => (
          <Badge key={role} tone="info">{titleCase(role)}</Badge>
        ))}
        {contact.do_not_contact ? <Badge tone="danger">Do not contact</Badge> : null}
      </div>

      <div className="detail-grid">
        <div className="stack">
          <Card title="Leads" description="A contact can hold several open enquiries at once.">
            <DataTable
              rows={contact.leads ?? []}
              columns={[
                { key: 'reference', header: 'Reference', render: (row) => <Link href={`/leads/${row.id}`} className="mono">{row.reference}</Link> },
                { key: 'module', header: 'Module', render: (row) => titleCase(row.module) },
                { key: 'purpose', header: 'Purpose', render: (row) => titleCase(row.purpose) },
                { key: 'stage_code', header: 'Stage', render: (row) => <StatusBadge status={row.stage_code} /> },
                { key: 'created_at', header: 'Created', render: (row) => relativeTime(row.created_at) },
              ]}
            />
          </Card>

          <Card title="Timeline" description="Messages, calls, meetings and notes in one thread.">
            <div className="timeline">
              {(timeline ?? []).map((entry, index) => (
                <div key={`${entry.type}-${entry.data.id ?? index}`} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true">
                    {entry.type === 'message' ? '✉' : entry.type === 'call' ? '☎' : entry.type === 'meeting' ? '▤' : entry.type === 'viewing' ? '⌂' : '✎'}
                  </span>
                  <div>
                    <p className="timeline__body" style={{ margin: 0 }}>
                      {entry.type === 'message' ? entry.data.body : entry.type === 'note' ? entry.data.body : entry.data.title ?? titleCase(entry.type)}
                    </p>
                    <span className="timeline__meta">{titleCase(entry.type)} · {formatDateTime(entry.at, intlLocale)}</span>
                  </div>
                </div>
              ))}
              {(timeline ?? []).length === 0 ? <p className="muted">No activity recorded yet.</p> : null}
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Identifiers" description="Sensitive values are masked unless you hold contacts.view_sensitive.">
            <DataTable
              rows={contact.identifiers ?? []}
              columns={[
                { key: 'identifier_type', header: 'Type', render: (row) => titleCase(row.identifier_type) },
                { key: 'value_raw', header: 'Value', render: (row) => <span className="mono">{row.value_raw ?? '••••'}</span> },
                { key: 'is_primary', header: 'Primary', render: (row) => (row.is_primary ? 'Yes' : '—') },
              ]}
            />
          </Card>

          <Card title="Consent">
            <DataTable
              rows={contact.consents ?? []}
              columns={[
                { key: 'channel', header: 'Channel', render: (row) => titleCase(row.channel) },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              ]}
              empty={<p className="muted">No consent records captured.</p>}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

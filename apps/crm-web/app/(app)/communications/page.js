'use client';

import { Badge, Card, DataTable, EmptyState, ErrorState, PermissionDenied } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { useApi, useSession } from '@/lib/api-client';
import { titleCase } from '@/lib/format';

export default function CommunicationsPage() {
  const { session } = useSession();
  const { data: connections, loading, error, reload } = useApi('/v1/integrations/connections');

  if (session && !session.can('communications.read')) return <PermissionDenied permission="communications.read" />;

  const messaging = (connections ?? []).filter((connection) => ['messaging', 'email', 'telephony', 'calendar'].includes(connection.category));

  return (
    <>
      <PageHeader
        title="Communications"
        description="WhatsApp, email, calendar and call logs feed one normalized timeline per contact and lead."
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      <Card title="Connected channels" description="Whatsyncs and WhatsApp Business share the same normalized message contract.">
        <DataTable
          loading={loading}
          rows={messaging}
          rowKey={(row) => row.id}
          columns={[
            { key: 'name', header: 'Connection' },
            { key: 'provider', header: 'Provider', render: (row) => titleCase(row.provider) },
            { key: 'category', header: 'Channel', render: (row) => titleCase(row.category) },
            { key: 'health_status', header: 'Health', render: (row) => <Badge tone={row.health_status === 'healthy' ? 'success' : row.health_status === 'error' ? 'danger' : 'warning'}>{row.health_status}</Badge> },
            { key: 'health_message', header: 'Message', render: (row) => row.health_message ?? '—' },
          ]}
          empty={
            <EmptyState
              title="No messaging channel connected yet"
              description="Connect Whatsyncs, WhatsApp Business, Gmail or Outlook from Integrations to start capturing conversations against contacts."
            />
          }
        />
      </Card>

      <Card title="Where conversations appear">
        <p className="muted" style={{ marginTop: 0 }}>
          Inbound and outbound messages are matched to a contact by phone number or email and attached to that
          contact&apos;s open lead. Open any contact to see the full timeline, or a lead to see only its own thread.
        </p>
      </Card>
    </>
  );
}

'use client';

import Link from 'next/link';
import { Badge, Button, Card, DataTable, ErrorState, PermissionDenied, Skeleton } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function PortalErrorsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: errors, loading, error, reload } = useApi('/v1/portals/errors?per_page=50');
  const { data: accounts } = useApi('/v1/portals/accounts');

  if (session && !session.can('portals.read')) return <PermissionDenied permission="portals.read" />;

  async function retry(publicationId) {
    await apiFetchWithRefresh(`/v1/portals/publications/${publicationId}/retry`, { method: 'POST' }).catch(() => {});
    reload();
  }

  return (
    <>
      <PageHeader title="Portal health" description="Every failed publication with the exact field the portal rejected." />

      <Card title="Connected portal accounts">
        <DataTable
          rows={accounts ?? []}
          columns={[
            { key: 'name', header: 'Account' },
            { key: 'provider_code', header: 'Provider', render: (row) => titleCase(row.provider_code) },
            { key: 'health_status', header: 'Health', render: (row) => <Badge tone={row.health_status === 'healthy' ? 'success' : row.health_status === 'error' ? 'danger' : 'warning'}>{row.health_status}</Badge> },
            { key: 'health_message', header: 'Message', render: (row) => row.health_message ?? '—' },
            { key: 'last_success_at', header: 'Last success', render: (row) => (row.last_success_at ? formatDateTime(row.last_success_at, intlLocale) : '—') },
          ]}
          empty={<p className="muted">No portal accounts yet. <Link href="/integrations">Connect one</Link>.</p>}
        />
      </Card>

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={4} /> : null}

      <Card title="Publication errors">
        <DataTable
          rows={errors ?? []}
          columns={[
            { key: 'reference', header: 'Listing', render: (row) => <Link href={`/ready/listings/${row.listing_id}`} className="mono">{row.reference}</Link> },
            { key: 'account_name', header: 'Portal' },
            { key: 'last_error_message', header: 'Error', render: (row) => (
              <div>
                <strong style={{ display: 'block', fontSize: 13 }}>{row.last_error_code ?? 'error'}</strong>
                <span className="muted">{row.last_error_message}</span>
                {(row.validation_errors ?? []).length > 0 ? (
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 12 }}>
                    {row.validation_errors.slice(0, 4).map((issue) => (
                      <li key={`${issue.code}-${issue.field}`}>{issue.field ?? 'listing'}: {issue.message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) },
            { key: 'attempts', header: 'Attempts' },
            { key: 'retry', header: '', render: (row) => <Button size="sm" variant="secondary" onClick={() => retry(row.id)}>Retry</Button> },
          ]}
          empty={<p className="muted">No portal errors. Everything published cleanly.</p>}
        />
      </Card>
    </>
  );
}

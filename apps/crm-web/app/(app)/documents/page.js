'use client';

import { useState } from 'react';
import { Badge, Button, Card, DataTable, ErrorState, PermissionDenied, Tabs } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDateTime, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function DocumentsPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const [tab, setTab] = useState('templates');
  const { data: templates, loading, error, reload } = useApi('/v1/documents/templates');
  const { data: documents } = useApi('/v1/documents?per_page=50');
  const [busy, setBusy] = useState(null);

  if (session && !session.can('documents.read')) return <PermissionDenied permission="documents.read" />;

  async function approve(versionId) {
    setBusy(versionId);
    await apiFetchWithRefresh(`/v1/documents/templates/versions/${versionId}/approve`, { method: 'POST' }).catch(() => {});
    setBusy(null);
    reload();
  }

  async function download(documentId) {
    const result = await apiFetchWithRefresh(`/v1/documents/${documentId}/download`).catch(() => null);
    if (result?.data?.download_url) window.open(result.data.download_url, '_blank', 'noopener');
  }

  return (
    <>
      <PageHeader
        title="Documents"
        description="Tenant-controlled templates with versions and approvals. Seeded samples are clearly labelled and must be approved before client use."
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'templates', label: 'Templates', count: templates?.length ?? 0 },
          { value: 'generated', label: 'Generated', count: documents?.length ?? 0 },
        ]}
      />

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      {tab === 'templates' ? (
        <Card title="Templates">
          <DataTable
            loading={loading}
            rows={templates ?? []}
            columns={[
              { key: 'name', header: 'Template' },
              { key: 'document_type', header: 'Type', render: (row) => titleCase(row.document_type) },
              { key: 'category', header: 'Category', render: (row) => titleCase(row.category) },
              { key: 'is_sample', header: 'Source', render: (row) => (row.is_sample ? <Badge tone="warning">Sample — not legally reviewed</Badge> : <Badge tone="success">Tenant approved</Badge>) },
              { key: 'version', header: 'Version', render: (row) => (row.current_version ? `v${row.current_version.version_number} · ${row.current_version.status}` : '—') },
              {
                key: 'approve',
                header: '',
                render: (row) =>
                  row.current_version && row.current_version.status !== 'approved' && session?.can('documents.templates') ? (
                    <Button size="sm" variant="secondary" loading={busy === row.current_version.id} onClick={() => approve(row.current_version.id)}>
                      Approve version
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      ) : (
        <Card title="Generated documents">
          <DataTable
            rows={documents ?? []}
            columns={[
              { key: 'reference', header: 'Reference', render: (row) => <span className="mono">{row.reference}</span> },
              { key: 'title', header: 'Title' },
              { key: 'document_type', header: 'Type', render: (row) => titleCase(row.document_type) },
              { key: 'created_at', header: 'Generated', render: (row) => formatDateTime(row.created_at, intlLocale) },
              { key: 'signature_status', header: 'Signature', render: (row) => titleCase(row.signature_status) },
              { key: 'download', header: '', render: (row) => <Button size="sm" variant="ghost" onClick={() => download(row.id)}>Download</Button> },
            ]}
            empty={<p className="muted">No documents generated yet.</p>}
          />
        </Card>
      )}
    </>
  );
}

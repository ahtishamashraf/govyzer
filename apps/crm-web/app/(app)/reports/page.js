'use client';

import { useState } from 'react';
import { Button, Card, DataTable, ErrorState, Field, Input, PermissionDenied, Select, Skeleton } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, buildQuery, useApi, useSession } from '@/lib/api-client';
import { titleCase } from '@/lib/format';

export default function ReportsPage() {
  const { session } = useSession();
  const { data: reports, loading } = useApi('/v1/reports');
  const [code, setCode] = useState('');
  const [filters, setFilters] = useState({ from: '', to: '' });
  const query = buildQuery(filters);
  const { data: report, loading: running, error, reload } = useApi(code ? `/v1/reports/${code}${query}` : null, { enabled: Boolean(code), deps: [code, query] });
  const [exportState, setExportState] = useState(null);

  if (session && !session.can('reports.read')) return <PermissionDenied permission="reports.read" />;

  const activeCode = code || reports?.[0]?.code;
  const columns = report?.rows?.length ? Object.keys(report.rows[0]).map((key) => ({ key, header: titleCase(key) })) : [];

  async function runExport(entityType) {
    setExportState('running');
    const result = await apiFetchWithRefresh('/v1/reports/exports', { method: 'POST', body: { entity_type: entityType } }).catch(() => null);
    setExportState(result ? 'queued' : 'failed');
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every report runs against real queries and respects your record scope."
        actions={
          session?.can('data.export') ? (
            <>
              <Button variant="secondary" onClick={() => runExport('leads')} loading={exportState === 'running'}>Export leads</Button>
              <Button variant="secondary" onClick={() => runExport('deals')} loading={exportState === 'running'}>Export deals</Button>
            </>
          ) : null
        }
      />

      {exportState === 'queued' ? <div className="gv-toast gv-toast--success" role="status"><span>Export queued. It appears in Settings once the job finishes.</span></div> : null}

      <Card>
        <div className="filters">
          <Field label="Report" htmlFor="report">
            <Select id="report" value={activeCode ?? ''} onChange={(event) => setCode(event.target.value)} options={(reports ?? []).map((entry) => ({ value: entry.code, label: entry.name }))} />
          </Field>
          <Field label="From" htmlFor="from">
            <Input id="from" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} />
          </Field>
          <Field label="To" htmlFor="to">
            <Input id="to" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} />
          </Field>
        </div>
      </Card>

      {loading ? <Skeleton rows={4} /> : null}
      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}

      {report ? (
        <Card title={report.name} description={`${report.rows.length} rows · generated ${new Date(report.generated_at).toLocaleString()}`}>
          <DataTable loading={running} rows={report.rows} rowKey={(row, index) => JSON.stringify(row).slice(0, 40) + index} columns={columns} empty={<p className="muted">No data for this period.</p>} />
        </Card>
      ) : null}
    </>
  );
}

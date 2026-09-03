'use client';

import { use, useState } from 'react';
import { Badge, Button, Card, DataTable, ErrorState, Skeleton, StatusBadge } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

const NEXT_STAGE = { draft: 'documentation', documentation: 'approval', approval: 'signed', signed: 'won' };

export default function DealDetailPage({ params }) {
  const { id } = use(params);
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: deal, loading, error, reload } = useApi(`/v1/deals/${id}`);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const currency = deal?.currency ?? session?.organization?.currency ?? 'AED';

  if (loading) return <Skeleton rows={8} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!deal) return null;

  async function previewCommission() {
    setBusy(true);
    const result = await apiFetchWithRefresh(`/v1/deals/${id}/commission/preview`, { method: 'POST', body: {} }).catch(() => null);
    setPreview(result?.data ?? null);
    setBusy(false);
  }

  async function advance(stage) {
    setBusy(true);
    await apiFetchWithRefresh(`/v1/deals/${id}/stage`, { method: 'POST', body: { stage } }).catch(() => {});
    setBusy(false);
    reload();
  }

  const snapshot = deal.commission_snapshot;

  return (
    <>
      <PageHeader
        title={`Deal ${deal.reference}`}
        description={`${titleCase(deal.deal_type)} · ${titleCase(deal.module)}`}
        actions={
          <>
            <Button variant="secondary" loading={busy} onClick={previewCommission}>Preview commission</Button>
            {NEXT_STAGE[deal.stage] && session?.can(NEXT_STAGE[deal.stage] === 'won' ? 'deals.win' : 'deals.update') ? (
              <Button loading={busy} onClick={() => advance(NEXT_STAGE[deal.stage])}>
                Move to {titleCase(NEXT_STAGE[deal.stage])}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="row">
        <StatusBadge status={deal.stage} />
        <Badge tone={deal.commission_status === 'approved' || deal.commission_status === 'calculated' ? 'success' : deal.commission_status === 'reversed' ? 'danger' : 'warning'}>
          Commission {titleCase(deal.commission_status)}
        </Badge>
      </div>

      <div className="detail-grid">
        <div className="stack">
          <Card title="Economics">
            <dl className="kv">
              <dt>Property value</dt><dd>{formatMoney(deal.property_value, currency, intlLocale)}</dd>
              <dt>Gross commission</dt><dd>{formatMoney(deal.gross_commission, currency, intlLocale)}</dd>
              <dt>Commission %</dt><dd>{deal.commission_percentage ? `${deal.commission_percentage}%` : '—'}</dd>
              <dt>VAT</dt><dd>{formatMoney(deal.commission_vat, currency, intlLocale)}</dd>
              <dt>Contract date</dt><dd>{formatDate(deal.contract_date, intlLocale)}</dd>
              <dt>Won at</dt><dd>{deal.won_at ? formatDateTime(deal.won_at, intlLocale) : '—'}</dd>
            </dl>
          </Card>

          {snapshot ? (
            <Card title="Commission snapshot" description={`Plan ${snapshot.plan_code ?? 'default'} · base ${titleCase(snapshot.commission_base)} — frozen when the deal was won.`}>
              <DataTable
                rows={snapshot.lines ?? []}
                columns={[
                  { key: 'label', header: 'Line' },
                  { key: 'recipient_type', header: 'Recipient', render: (row) => titleCase(row.recipient_type) },
                  { key: 'percentage', header: '%', render: (row) => (row.percentage != null ? `${row.percentage}%` : '—') },
                  { key: 'amount', header: 'Amount', render: (row) => formatMoney(row.amount, currency, intlLocale) },
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                ]}
              />
            </Card>
          ) : null}

          {preview ? (
            <Card title="Commission preview" description="Calculated live from the current plan — nothing is stored until the deal is won.">
              <DataTable
                rows={preview.lines ?? []}
                rowKey={(row) => `${row.recipient_type}-${row.label}`}
                columns={[
                  { key: 'label', header: 'Line' },
                  { key: 'percentage', header: '%', render: (row) => (row.percentage != null ? `${row.percentage}%` : '—') },
                  { key: 'amount', header: 'Amount', render: (row) => formatMoney(row.amount, currency, intlLocale) },
                ]}
              />
              {preview.warnings?.length ? (
                <ul style={{ marginTop: 10, color: '#b45309', fontSize: 13 }}>
                  {preview.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="stack">
          <Card title="Parties">
            <DataTable
              rows={deal.parties ?? []}
              columns={[
                { key: 'party_role', header: 'Role', render: (row) => titleCase(row.party_role) },
                { key: 'party_type', header: 'Type', render: (row) => titleCase(row.party_type) },
                { key: 'share_percentage', header: 'Share', render: (row) => (row.share_percentage ? `${row.share_percentage}%` : '—') },
              ]}
            />
          </Card>

          <Card title="Documents">
            <DataTable
              rows={deal.documents ?? []}
              columns={[
                { key: 'title', header: 'Document' },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                { key: 'signature_status', header: 'Signature', render: (row) => titleCase(row.signature_status) },
              ]}
              empty={<p className="muted">No documents generated yet.</p>}
            />
          </Card>

          <Card title="Stage history">
            <div className="timeline">
              {(deal.stage_history ?? []).map((entry) => (
                <div key={entry.id} className="timeline__item">
                  <span className="timeline__dot" aria-hidden="true">→</span>
                  <div>
                    <p className="timeline__body" style={{ margin: 0 }}>{titleCase(entry.from_stage ?? 'created')} → {titleCase(entry.to_stage)}</p>
                    <span className="timeline__meta">{formatDateTime(entry.created_at, intlLocale)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

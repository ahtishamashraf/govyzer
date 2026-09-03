'use client';

import { use, useState } from 'react';
import { Badge, Button, Card, DataTable, ErrorState, Field, Select, Skeleton, StatusBadge, Tabs } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';
import { formatArea, formatDateTime, formatMoney, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function ListingDetailPage({ params }) {
  const { id } = use(params);
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: listing, loading, error, reload } = useApi(`/v1/listings/${id}`);
  const { data: accounts } = useApi('/v1/portals/accounts', { enabled: Boolean(session?.can('portals.read')) });
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(null);
  const [selectedAccounts, setSelectedAccounts] = useState([]);
  const currency = session?.organization?.currency ?? 'AED';

  if (loading) return <Skeleton rows={8} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!listing) return null;

  const enabledAccounts = (accounts ?? []).filter((account) => account.is_enabled);

  async function act(path, body) {
    setBusy(true);
    try {
      const result = await apiFetchWithRefresh(path, { method: 'POST', body });
      reload();
      return result;
    } finally {
      setBusy(false);
    }
  }

  async function validateForPortals() {
    const accountIds = selectedAccounts.length > 0 ? selectedAccounts : enabledAccounts.map((account) => account.id);
    if (accountIds.length === 0) return;
    const result = await act(`/v1/listings/${id}/validate`, { portal_account_ids: accountIds });
    setValidation(result.data);
  }

  async function publish() {
    const accountIds = selectedAccounts.length > 0 ? selectedAccounts : enabledAccounts.map((account) => account.id);
    if (accountIds.length === 0) return;
    const result = await act(`/v1/listings/${id}/publish`, { portal_account_ids: accountIds });
    setValidation(result.data.validation);
  }

  return (
    <>
      <PageHeader
        title={listing.title}
        description={`${listing.reference} · ${titleCase(listing.offering_type)} · ${titleCase(listing.property_type)}`}
        actions={
          <>
            {listing.status === 'draft' && session?.can('listings.update') ? (
              <Button variant="secondary" loading={busy} onClick={() => act(`/v1/listings/${id}/submit`, {})}>Submit for approval</Button>
            ) : null}
            {listing.status === 'internal_review' && session?.can('listings.approve') ? (
              <>
                <Button loading={busy} onClick={() => act(`/v1/listings/${id}/approval`, { decision: 'approved', reason: 'Approved from listing detail' })}>Approve</Button>
                <Button variant="danger" loading={busy} onClick={() => act(`/v1/listings/${id}/approval`, { decision: 'rejected', reason: 'Rejected from listing detail' })}>Reject</Button>
              </>
            ) : null}
            {session?.can('listings.publish') ? (
              <>
                <Button variant="secondary" loading={busy} onClick={validateForPortals}>Validate for portals</Button>
                <Button loading={busy} onClick={publish} disabled={!['approved', 'published', 'partially_published', 'unpublished'].includes(listing.status)}>Publish</Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="row">
        <StatusBadge status={listing.status} />
        {listing.is_exclusive ? <Badge tone="info">Exclusive</Badge> : null}
        {listing.permit_number ? <Badge tone="neutral">Permit {listing.permit_number}</Badge> : <Badge tone="danger">No permit</Badge>}
        <Badge tone="neutral">{listing.lead_count} leads</Badge>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'portals', label: 'Portals', count: listing.publications?.length ?? 0 },
          { value: 'history', label: 'History' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="detail-grid">
          <Card title="Property details">
            <dl className="kv">
              <dt>Price</dt><dd>{formatMoney(listing.price, listing.currency ?? currency, intlLocale)}{listing.rent_frequency ? ` / ${listing.rent_frequency}` : ''}</dd>
              <dt>Bedrooms</dt><dd>{listing.bedrooms ?? '—'}</dd>
              <dt>Bathrooms</dt><dd>{listing.bathrooms ?? '—'}</dd>
              <dt>Built up area</dt><dd>{formatArea(listing.built_up_area, listing.size_unit, intlLocale)}</dd>
              <dt>Parking</dt><dd>{listing.parking_spaces ?? '—'}</dd>
              <dt>Furnishing</dt><dd>{titleCase(listing.furnishing ?? 'not set')}</dd>
              <dt>Occupancy</dt><dd>{titleCase(listing.occupancy_status)}</dd>
              <dt>Amenities</dt><dd>{(listing.amenity_codes ?? []).map(titleCase).join(', ') || '—'}</dd>
              <dt>Description</dt><dd>{listing.description ?? '—'}</dd>
            </dl>
          </Card>

          <div className="stack">
            <Card title="Media" description="Uploads go straight to S3 through short-lived presigned URLs.">
              {(listing.media ?? []).length === 0 ? (
                <p className="muted">No media uploaded yet. Portals require at least one image.</p>
              ) : (
                <DataTable
                  rows={listing.media}
                  columns={[
                    { key: 'file_name', header: 'File' },
                    { key: 'asset_type', header: 'Type', render: (row) => titleCase(row.asset_type) },
                    { key: 'is_primary', header: 'Primary', render: (row) => (row.is_primary ? 'Yes' : '—') },
                  ]}
                />
              )}
            </Card>

            <Card title="Approvals">
              <DataTable
                rows={listing.approvals ?? []}
                columns={[
                  { key: 'step', header: 'Step', render: (row) => titleCase(row.step) },
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                  { key: 'decided_at', header: 'Decided', render: (row) => (row.decided_at ? formatDateTime(row.decided_at, intlLocale) : '—') },
                ]}
                empty={<p className="muted">Not submitted for approval yet.</p>}
              />
            </Card>
          </div>
        </div>
      ) : null}

      {tab === 'portals' ? (
        <div className="stack">
          <Card title="Select portals" description="Only enabled, healthy portal accounts can be published to.">
            <div className="row">
              {enabledAccounts.length === 0 ? <p className="muted">No portal accounts connected yet.</p> : null}
              {enabledAccounts.map((account) => (
                <label key={account.id} className="row" style={{ gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={(event) =>
                      setSelectedAccounts((current) => (event.target.checked ? [...current, account.id] : current.filter((entry) => entry !== account.id)))
                    }
                  />
                  {account.name}
                  <Badge tone={account.health_status === 'healthy' ? 'success' : account.health_status === 'error' ? 'danger' : 'warning'}>{account.health_status}</Badge>
                </label>
              ))}
            </div>
          </Card>

          {validation ? (
            <Card title="Validation results" description="Fix these exact fields before the portal will accept the listing.">
              {validation.results.map((result) => (
                <div key={result.portal_account_id} className="stack" style={{ marginBottom: 14 }}>
                  <div className="row row--between">
                    <strong>{result.name ?? result.provider_code}</strong>
                    <Badge tone={result.valid ? 'success' : 'danger'}>{result.valid ? 'Ready to publish' : 'Blocked'}</Badge>
                  </div>
                  {result.errors.length === 0 ? (
                    <p className="muted">No issues found.</p>
                  ) : (
                    <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                      {result.errors.map((issue) => (
                        <li key={`${issue.code}-${issue.field}`} style={{ fontSize: 13, color: issue.severity === 'error' ? '#b42318' : '#b45309' }}>
                          <strong>{issue.field ?? 'listing'}</strong>: {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </Card>
          ) : null}

          <Card title="Publication status">
            <DataTable
              rows={listing.publications ?? []}
              columns={[
                { key: 'provider_code', header: 'Portal', render: (row) => titleCase(row.provider_code) },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
                { key: 'attempts', header: 'Attempts' },
                { key: 'last_error_message', header: 'Last error', render: (row) => row.last_error_message ?? '—' },
                { key: 'published_at', header: 'Published', render: (row) => (row.published_at ? formatDateTime(row.published_at, intlLocale) : '—') },
              ]}
              empty={<p className="muted">Not published to any portal yet.</p>}
            />
          </Card>
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="grid grid--2">
          <Card title="Price history">
            <DataTable
              rows={listing.price_history ?? []}
              columns={[
                { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at, intlLocale) },
                { key: 'old_price', header: 'From', render: (row) => formatMoney(row.old_price, currency, intlLocale, { compact: true }) },
                { key: 'new_price', header: 'To', render: (row) => formatMoney(row.new_price, currency, intlLocale, { compact: true }) },
              ]}
              empty={<p className="muted">No price changes yet.</p>}
            />
          </Card>
          <Card title="Availability history">
            <DataTable
              rows={listing.availability_history ?? []}
              columns={[
                { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at, intlLocale) },
                { key: 'from_status', header: 'From', render: (row) => titleCase(row.from_status ?? '—') },
                { key: 'to_status', header: 'To', render: (row) => titleCase(row.to_status) },
                { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
              ]}
            />
          </Card>
        </div>
      ) : null}
    </>
  );
}

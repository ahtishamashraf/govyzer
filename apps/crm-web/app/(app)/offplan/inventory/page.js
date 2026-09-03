'use client';

import { useMemo, useState } from 'react';
import { Badge, Button, Card, Drawer, ErrorState, Field, Input, PermissionDenied, Select, Skeleton } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, buildQuery, useApi, useSession } from '@/lib/api-client';
import { formatArea, formatDate, formatMoney, titleCase } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function InventoryMatrixPage() {
  const { session } = useSession();
  const { intlLocale } = useI18n();
  const { data: projects } = useApi('/v1/offplan/projects?per_page=100');
  const [projectId, setProjectId] = useState('');
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [message, setMessage] = useState(null);
  const currency = session?.organization?.currency ?? 'AED';

  const activeProject = projectId || projects?.[0]?.id || '';
  const { data: matrix, loading, error, reload } = useApi(activeProject ? `/v1/offplan/units/matrix${buildQuery({ project_id: activeProject })}` : null, { enabled: Boolean(activeProject), deps: [activeProject] });

  if (session && !session.can('units.read')) return <PermissionDenied permission="units.read" />;

  async function hold(unit) {
    setMessage(null);
    try {
      await apiFetchWithRefresh('/v1/offplan/holds', { method: 'POST', body: { unit_id: unit.id, duration_minutes: 60 } });
      setMessage({ tone: 'success', text: `Unit ${unit.unit_number} held for 60 minutes.` });
      setSelectedUnit(null);
      reload();
    } catch (apiError) {
      setMessage({ tone: 'danger', text: apiError.message });
    }
  }

  return (
    <>
      <PageHeader
        title="Inventory matrix"
        description="Every unit by floor with live stock status. Holds and reservations are atomic — two agents can never take the same unit."
      />

      <Card>
        <div className="filters">
          <Field label="Project" htmlFor="project">
            <Select id="project" value={activeProject} onChange={(event) => setProjectId(event.target.value)} options={(projects ?? []).map((project) => ({ value: project.id, label: project.name }))} />
          </Field>
        </div>
      </Card>

      {message ? (
        <div className={`gv-toast gv-toast--${message.tone}`} role="status">
          <span>{message.text}</span>
        </div>
      ) : null}

      {error ? <ErrorState message={error.message} onRetry={reload} /> : null}
      {loading ? <Skeleton rows={6} /> : null}

      {matrix ? (
        <>
          <div className="grid grid--stats">
            {Object.entries(matrix.summary).map(([status, count]) => (
              <div key={status} className="gv-stat">
                <span className="gv-stat__label">{titleCase(status)}</span>
                <strong className="gv-stat__value">{count}</strong>
              </div>
            ))}
            <div className="gv-stat">
              <span className="gv-stat__label">Total stock value</span>
              <strong className="gv-stat__value">{formatMoney(matrix.total_value, currency, intlLocale, { compact: true })}</strong>
            </div>
          </div>

          <Card title={`${matrix.total_units} units`}>
            <div className="matrix">
              {matrix.floors.map((floor) => (
                <div key={floor.floor} className="matrix__floor">
                  <span className="matrix__floor-label">Floor {floor.floor}</span>
                  <div className="matrix__units">
                    {floor.units.map((unit) => (
                      <button key={unit.id} type="button" className="matrix__unit" data-status={unit.stock_status} onClick={() => setSelectedUnit(unit)}>
                        <strong>{unit.unit_number}</strong>
                        <small>{unit.bedrooms ?? '—'} BR · {formatMoney(unit.current_price, currency, intlLocale, { compact: true })}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      ) : null}

      <Drawer open={Boolean(selectedUnit)} title={selectedUnit ? `Unit ${selectedUnit.unit_number}` : ''} onClose={() => setSelectedUnit(null)}>
        {selectedUnit ? (
          <div className="stack">
            <div className="row">
              <Badge tone={selectedUnit.stock_status === 'available' ? 'success' : 'neutral'}>{titleCase(selectedUnit.stock_status)}</Badge>
            </div>
            <dl className="kv">
              <dt>Bedrooms</dt><dd>{selectedUnit.bedrooms ?? '—'}</dd>
              <dt>Area</dt><dd>{formatArea(selectedUnit.size ?? selectedUnit.built_up_area, 'sqft', intlLocale)}</dd>
              <dt>Price</dt><dd>{formatMoney(selectedUnit.current_price, currency, intlLocale)}</dd>
              <dt>View</dt><dd>{selectedUnit.view ?? '—'}</dd>
              <dt>Handover</dt><dd>{formatDate(selectedUnit.handover_date, intlLocale)}</dd>
            </dl>
            {selectedUnit.stock_status === 'available' && session?.can('holds.create') ? (
              <Button onClick={() => hold(selectedUnit)}>Hold for 60 minutes</Button>
            ) : (
              <p className="muted">This unit is {titleCase(selectedUnit.stock_status)} and cannot be held right now.</p>
            )}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

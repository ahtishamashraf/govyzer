'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, PermissionDenied, Select, Textarea } from '@govyzer/ui';
import PageHeader from '@/components/page-header';
import { apiFetchWithRefresh, useApi, useSession } from '@/lib/api-client';

const STEPS = ['Property', 'Pricing', 'Marketing', 'Compliance'];
const DRAFT_KEY = 'gvz.listing.draft';

export default function NewListingPage() {
  const router = useRouter();
  const { session } = useSession();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    offering_type: 'sale',
    property_category: 'residential',
    property_type: 'apartment',
    title: '',
    description: '',
    price: '',
    rent_frequency: 'yearly',
    bedrooms: '',
    bathrooms: '',
    built_up_area: '',
    size_unit: 'sqft',
    parking_spaces: '',
    furnishing: 'unfurnished',
    occupancy_status: 'vacant',
    community_id: '',
    permit_number: '',
    permit_expires_on: '',
    primary_agent_membership_id: '',
    is_exclusive: false,
  });
  const [state, setState] = useState({ loading: false, error: null, details: null, savedAt: null });
  const { data: users } = useApi('/v1/users?per_page=100');

  // Autosave keeps a long wizard safe across refreshes.
  useEffect(() => {
    const stored = window.localStorage.getItem(DRAFT_KEY);
    if (stored) {
      try {
        setForm((current) => ({ ...current, ...JSON.parse(stored) }));
      } catch {
        window.localStorage.removeItem(DRAFT_KEY);
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
      setState((current) => ({ ...current, savedAt: new Date() }));
    }, 800);
    return () => clearTimeout(timer);
  }, [form]);

  if (session && !session.can('listings.create')) return <PermissionDenied permission="listings.create" />;

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));

  async function submit(event) {
    event.preventDefault();
    setState({ ...state, loading: true, error: null, details: null });
    try {
      const payload = {
        ...form,
        price: form.price ? Number(form.price) : undefined,
        bedrooms: form.bedrooms === '' ? undefined : Number(form.bedrooms),
        bathrooms: form.bathrooms === '' ? undefined : Number(form.bathrooms),
        built_up_area: form.built_up_area === '' ? undefined : Number(form.built_up_area),
        parking_spaces: form.parking_spaces === '' ? undefined : Number(form.parking_spaces),
        community_id: form.community_id || undefined,
        permit_expires_on: form.permit_expires_on || undefined,
        primary_agent_membership_id: form.primary_agent_membership_id || undefined,
        rent_frequency: form.offering_type === 'rent' ? form.rent_frequency : undefined,
      };
      const result = await apiFetchWithRefresh('/v1/listings', { method: 'POST', body: payload });
      window.localStorage.removeItem(DRAFT_KEY);
      router.push(`/ready/listings/${result.data.listing.id}`);
    } catch (error) {
      setState({ ...state, loading: false, error: error.message, details: error.details });
    }
  }

  return (
    <>
      <PageHeader
        title="New listing"
        description="Portal validation runs before publication, so fix anything flagged here first."
        actions={<span className="muted">{state.savedAt ? `Draft saved ${state.savedAt.toLocaleTimeString()}` : 'Autosaving…'}</span>}
      />

      <Card>
        <div className="row" role="tablist" aria-label="Listing wizard steps">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={step === index}
              className={`gv-tab${step === index ? ' is-active' : ''}`}
              onClick={() => setStep(index)}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>
      </Card>

      <form onSubmit={submit} className="stack">
        {step === 0 ? (
          <Card title="Property">
            <div className="grid grid--2">
              <Field label="Offering" htmlFor="offering_type" required>
                <Select id="offering_type" value={form.offering_type} onChange={(event) => update({ offering_type: event.target.value })} options={[{ value: 'sale', label: 'For sale' }, { value: 'rent', label: 'For rent' }]} />
              </Field>
              <Field label="Category" htmlFor="property_category">
                <Select id="property_category" value={form.property_category} onChange={(event) => update({ property_category: event.target.value })} options={[{ value: 'residential', label: 'Residential' }, { value: 'commercial', label: 'Commercial' }]} />
              </Field>
              <Field label="Property type" htmlFor="property_type">
                <Select id="property_type" value={form.property_type} onChange={(event) => update({ property_type: event.target.value })} options={['apartment', 'villa', 'townhouse', 'penthouse', 'duplex', 'office', 'retail', 'warehouse', 'land'].map((value) => ({ value, label: value.replace(/\b\w/g, (c) => c.toUpperCase()) }))} />
              </Field>
              <Field label="Bedrooms" htmlFor="bedrooms">
                <Input id="bedrooms" type="number" min="0" value={form.bedrooms} onChange={(event) => update({ bedrooms: event.target.value })} />
              </Field>
              <Field label="Bathrooms" htmlFor="bathrooms">
                <Input id="bathrooms" type="number" min="0" step="0.5" value={form.bathrooms} onChange={(event) => update({ bathrooms: event.target.value })} />
              </Field>
              <Field label="Built up area" htmlFor="built_up_area" required>
                <Input id="built_up_area" type="number" min="0" value={form.built_up_area} onChange={(event) => update({ built_up_area: event.target.value })} />
              </Field>
              <Field label="Parking spaces" htmlFor="parking">
                <Input id="parking" type="number" min="0" value={form.parking_spaces} onChange={(event) => update({ parking_spaces: event.target.value })} />
              </Field>
              <Field label="Furnishing" htmlFor="furnishing">
                <Select id="furnishing" value={form.furnishing} onChange={(event) => update({ furnishing: event.target.value })} options={[{ value: 'unfurnished', label: 'Unfurnished' }, { value: 'furnished', label: 'Furnished' }, { value: 'partly_furnished', label: 'Partly furnished' }]} />
              </Field>
            </div>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card title="Pricing and availability">
            <div className="grid grid--2">
              <Field label="Price" htmlFor="price" required hint="Portals reject listings without a price.">
                <Input id="price" type="number" min="0" value={form.price} onChange={(event) => update({ price: event.target.value })} />
              </Field>
              {form.offering_type === 'rent' ? (
                <Field label="Rent frequency" htmlFor="rent_frequency" required>
                  <Select id="rent_frequency" value={form.rent_frequency} onChange={(event) => update({ rent_frequency: event.target.value })} options={[{ value: 'yearly', label: 'Yearly' }, { value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'daily', label: 'Daily' }]} />
                </Field>
              ) : null}
              <Field label="Occupancy" htmlFor="occupancy_status">
                <Select id="occupancy_status" value={form.occupancy_status} onChange={(event) => update({ occupancy_status: event.target.value })} options={[{ value: 'vacant', label: 'Vacant' }, { value: 'occupied', label: 'Occupied' }, { value: 'vacant_on_transfer', label: 'Vacant on transfer' }]} />
              </Field>
              <Field label="Exclusive listing">
                <label className="row" style={{ gap: 8, fontSize: 14 }}>
                  <input type="checkbox" checked={form.is_exclusive} onChange={(event) => update({ is_exclusive: event.target.checked })} />
                  This listing is exclusive to us
                </label>
              </Field>
            </div>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card title="Marketing copy" description="Portals reject short titles and descriptions.">
            <div className="stack">
              <Field label="Title" htmlFor="title" required hint="At least 10 characters.">
                <Input id="title" required value={form.title} onChange={(event) => update({ title: event.target.value })} />
              </Field>
              <Field label="Description" htmlFor="description" required hint="At least 50 characters.">
                <Textarea id="description" required value={form.description} onChange={(event) => update({ description: event.target.value })} />
              </Field>
              <Field label="Primary agent" htmlFor="agent" required hint="Incoming portal leads are routed to this agent first.">
                <Select
                  id="agent"
                  value={form.primary_agent_membership_id}
                  placeholder="Choose an agent"
                  onChange={(event) => update({ primary_agent_membership_id: event.target.value })}
                  options={(users ?? []).map((user) => ({ value: user.id, label: `${user.first_name} ${user.last_name}` }))}
                />
              </Field>
            </div>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card title="Compliance" description="UAE portals require a valid DLD/Trakheesi permit.">
            <div className="grid grid--2">
              <Field label="Permit number" htmlFor="permit_number" required>
                <Input id="permit_number" value={form.permit_number} onChange={(event) => update({ permit_number: event.target.value })} />
              </Field>
              <Field label="Permit expires on" htmlFor="permit_expires_on">
                <Input id="permit_expires_on" type="date" value={form.permit_expires_on} onChange={(event) => update({ permit_expires_on: event.target.value })} />
              </Field>
            </div>
          </Card>
        ) : null}

        {state.error ? (
          <div role="alert" style={{ color: '#b42318', fontSize: 13 }}>
            <p style={{ margin: 0 }}>{state.error}</p>
            {state.details?.length ? (
              <ul style={{ margin: '6px 0 0 18px' }}>
                {state.details.map((detail) => (
                  <li key={`${detail.path}-${detail.message}`}>{detail.path}: {detail.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="row row--between">
          <Button type="button" variant="secondary" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>
              Continue
            </Button>
          ) : (
            <Button type="submit" loading={state.loading}>Create listing</Button>
          )}
        </div>
      </form>
    </>
  );
}

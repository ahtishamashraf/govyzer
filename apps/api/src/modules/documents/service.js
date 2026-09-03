import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ValidationError } from '@govyzer/domain';
import { nextReference } from '../../core/references.js';
import { renderTemplate, renderPdf } from './renderer.js';
import { putObject, buildStorageKey, isStorageConfigured, createDownloadUrl } from '../../core/storage.js';
import { emitEvent, EVENT_TYPES } from '../../core/outbox.js';
import { recordAudit } from '../../core/audit.js';
import { sha256 } from '../../core/crypto.js';

/** Collects the variable bag for a document from the entity it is generated against. */
export async function buildVariables({ organizationId, entityType, entityId, extra = {} }) {
  const db = getDb();
  const organization = await db('organizations').where('id', organizationId).first();
  const branding = await db('organization_branding').where('organization_id', organizationId).first();

  const variables = {
    organization: {
      name: branding?.company_display_name ?? organization.name,
      legal_name: organization.legal_name ?? organization.name,
      currency: organization.default_currency,
      country: organization.country,
    },
    date: new Date().toISOString().slice(0, 10),
    ...extra,
  };

  if (entityType === 'deal') {
    const deal = await db('deals').where({ id: entityId, organization_id: organizationId }).first();
    if (!deal) throw new NotFoundError('Deal');
    const contact = deal.contact_id ? await db('contacts').where('id', deal.contact_id).first() : null;
    const unit = deal.unit_id ? await db('units').where('id', deal.unit_id).first() : null;
    const listing = deal.listing_id ? await db('listings').where('id', deal.listing_id).first() : null;
    variables.deal = {
      reference: deal.reference,
      type: deal.deal_type,
      property_value: deal.property_value,
      gross_commission: deal.gross_commission,
      currency: deal.currency,
      contract_date: deal.contract_date,
    };
    variables.contact = contact ? { display_name: contact.display_name, reference: contact.reference } : null;
    variables.property = {
      reference: unit?.reference ?? listing?.reference ?? null,
      unit_number: unit?.unit_number ?? null,
      title: listing?.title ?? null,
    };
    variables.amount = deal.property_value;
  }

  if (entityType === 'reservation') {
    const reservation = await db('reservations').where({ id: entityId, organization_id: organizationId }).first();
    if (!reservation) throw new NotFoundError('Reservation');
    const contact = await db('contacts').where('id', reservation.contact_id).first();
    const unit = await db('units').where('id', reservation.unit_id).first();
    const project = reservation.project_id ? await db('projects').where('id', reservation.project_id).first() : null;
    variables.reservation = {
      reference: reservation.reference,
      unit_price: reservation.unit_price,
      reservation_amount: reservation.reservation_amount,
      currency: reservation.currency,
      expires_at: reservation.expires_at,
    };
    variables.contact = contact ? { display_name: contact.display_name, reference: contact.reference } : null;
    variables.property = { reference: unit?.reference, unit_number: unit?.unit_number, project: project?.name ?? null };
    variables.amount = reservation.unit_price;
  }

  if (entityType === 'invoice') {
    const invoice = await db('invoices').where({ id: entityId, organization_id: organizationId }).first();
    if (!invoice) throw new NotFoundError('Invoice');
    const items = await db('invoice_items').where({ organization_id: organizationId, invoice_id: invoice.id }).orderBy('position');
    variables.invoice = { ...invoice, items };
    variables.amount = invoice.total;
  }

  if (entityType === 'listing') {
    const listing = await db('listings').where({ id: entityId, organization_id: organizationId }).first();
    if (!listing) throw new NotFoundError('Listing');
    variables.property = { reference: listing.reference, title: listing.title, price: listing.price };
    variables.amount = listing.price;
  }

  return variables;
}

export async function generateDocument({ organizationId, actor, payload }) {
  const db = getDb();
  const template = await db('document_templates').where({ id: payload.template_id, organization_id: organizationId }).whereNull('deleted_at').first();
  if (!template) throw new NotFoundError('Document template');

  const version = await db('document_template_versions').where('id', template.current_version_id).first();
  if (!version) throw new ValidationError('This template has no published version yet');
  if (template.requires_approval && version.status !== 'approved') {
    throw new ValidationError(
      'This template still needs approval. Review the wording and approve the version before generating client documents.',
      [{ path: 'template_id', message: 'Template version is not approved' }]
    );
  }

  const branding = await db('organization_branding').where('organization_id', organizationId).first();
  const variables = await buildVariables({ organizationId, entityType: payload.entity_type, entityId: payload.entity_id, extra: payload.variables ?? {} });
  const rendered = renderTemplate(version.body_html, variables);

  const title = `${template.name} — ${variables.deal?.reference ?? variables.reservation?.reference ?? variables.invoice?.reference ?? payload.entity_id}`;
  const pdf = await renderPdf({
    title,
    html: rendered.html,
    header: branding?.document_header_html ?? null,
    footer: branding?.document_footer_html ?? null,
    branding: branding ?? {},
  });

  const id = newId();
  const reference = await nextReference({ organizationId, entity: 'document', prefix: actor?.referencePrefix ?? 'GVZ' });
  let storageKey = null;
  if (isStorageConfigured()) {
    storageKey = buildStorageKey({ organizationId, entityType: 'document', entityId: id, fileName: `${reference}.pdf` });
    await putObject(storageKey, pdf, 'application/pdf');
  }

  await db('generated_documents').insert({
    id,
    organization_id: organizationId,
    reference,
    template_id: template.id,
    template_version_id: version.id,
    template_version_number: version.version_number,
    document_type: template.document_type,
    entity_type: payload.entity_type,
    entity_id: payload.entity_id,
    title,
    language: payload.language,
    storage_key: storageKey,
    mime_type: 'application/pdf',
    size_bytes: pdf.length,
    checksum: sha256(pdf.toString('base64')),
    input_snapshot: JSON.stringify({ variables, missing_variables: rendered.missing_variables }),
    status: storageKey ? 'generated' : 'generated_not_stored',
    signature_status: 'not_required',
    created_by: actor.membershipId,
    updated_by: actor.membershipId,
  });

  await emitEvent(db, {
    organizationId,
    eventType: EVENT_TYPES.DOCUMENT_GENERATED,
    aggregateType: 'generated_document',
    aggregateId: id,
    payload: { document_id: id, entity_type: payload.entity_type, entity_id: payload.entity_id, document_type: template.document_type },
  });
  await recordAudit({ organizationId, actor, action: 'document.generated', entityType: 'generated_document', entityId: id, after: { reference, template: template.code } });

  const document = await db('generated_documents').where('id', id).first();
  return {
    ...document,
    download_url: storageKey ? await createDownloadUrl(storageKey, { fileName: `${reference}.pdf` }) : null,
    missing_variables: rendered.missing_variables,
    storage_warning: storageKey ? null : 'S3 is not configured for this deployment, so the PDF was generated but not stored.',
    pdf_base64: storageKey ? undefined : pdf.toString('base64'),
  };
}

import { Router } from 'express';
import { z } from 'zod';
import { getDb, withTransaction } from '@govyzer/database';
import { newId, NotFoundError, ValidationError, toMinor, fromMinor } from '@govyzer/domain';
import { invoiceSchema, paymentSchema, idSchema, paginationSchema } from '@govyzer/validation';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireAuth, requireOrganization, requirePermission } from '../../middleware/auth.js';
import { handler } from '../../core/async-handler.js';
import { sendData, sendList } from '../../core/responses.js';
import { idempotency } from '../../core/idempotency.js';
import { nextReference } from '../../core/references.js';
import { recordAudit, auditFromRequest } from '../../core/audit.js';

export function financeRoutes() {
  const router = Router();
  router.use(authenticate(), requireAuth(), requireOrganization());

  router.get(
    '/invoices',
    requirePermission('invoices.read'),
    validate({ query: paginationSchema.extend({ status: z.string().max(24).optional(), deal_id: idSchema.optional(), overdue: z.coerce.boolean().optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('invoices').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      if (req.validatedQuery.deal_id) query = query.where('deal_id', req.validatedQuery.deal_id);
      if (req.validatedQuery.overdue) query = query.where('due_date', '<', new Date()).where('balance', '>', 0);
      const rows = await query.orderBy('issue_date', 'desc').limit(req.validatedQuery.per_page).offset((req.validatedQuery.page - 1) * req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/invoices',
    requirePermission('invoices.manage'),
    idempotency('finance.invoice'),
    validate({ body: invoiceSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { items, ...invoice } = req.validatedBody;
      const id = newId();

      await withTransaction(db, async (trx) => {
        const reference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'invoice', prefix: req.actor.referencePrefix });

        let subtotalMinor = 0;
        let vatMinor = 0;
        const rows = items.map((item, index) => {
          const lineMinor = Math.round(toMinor(item.unit_price) * Number(item.quantity));
          const lineVatMinor = Math.round((lineMinor * Number(item.vat_percentage)) / 100);
          subtotalMinor += lineMinor;
          vatMinor += lineVatMinor;
          return {
            id: newId(),
            organization_id: req.actor.organizationId,
            invoice_id: id,
            position: index,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            vat_percentage: item.vat_percentage,
            vat_amount: fromMinor(lineVatMinor),
            line_total: fromMinor(lineMinor + lineVatMinor),
          };
        });

        await trx('invoices').insert({
          id,
          organization_id: req.actor.organizationId,
          reference,
          ...invoice,
          subtotal: fromMinor(subtotalMinor),
          vat_amount: fromMinor(vatMinor),
          total: fromMinor(subtotalMinor + vatMinor),
          paid_amount: 0,
          balance: fromMinor(subtotalMinor + vatMinor),
          status: 'issued',
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
        });
        await trx('invoice_items').insert(rows);
      });

      await recordAudit({ ...auditFromRequest(req), action: 'invoice.created', entityType: 'invoice', entityId: id });
      const created = await db('invoices').where('id', id).first();
      const lines = await db('invoice_items').where('invoice_id', id).orderBy('position');
      sendData(res, { ...created, items: lines }, { status: 201 });
    })
  );

  router.get(
    '/payments',
    requirePermission('invoices.read'),
    validate({ query: paginationSchema.extend({ deal_id: idSchema.optional(), status: z.string().max(24).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('payments').where('organization_id', req.actor.organizationId).whereNull('deleted_at');
      if (req.validatedQuery.deal_id) query = query.where('deal_id', req.validatedQuery.deal_id);
      if (req.validatedQuery.status) query = query.where('status', req.validatedQuery.status);
      const rows = await query.orderBy('paid_on', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  /** Records a payment and allocates it to an invoice, keeping the balance consistent. */
  router.post(
    '/payments',
    requirePermission('invoices.manage'),
    idempotency('finance.payment'),
    validate({ body: paymentSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const { invoice_id: invoiceId, ...payment } = req.validatedBody;
      const id = newId();

      await withTransaction(db, async (trx) => {
        const reference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'payment', prefix: req.actor.referencePrefix });
        await trx('payments').insert({
          id,
          organization_id: req.actor.organizationId,
          reference,
          ...payment,
          idempotency_key: req.get('idempotency-key') ?? null,
          created_by: req.actor.membershipId,
          updated_by: req.actor.membershipId,
        });

        if (invoiceId) {
          const invoice = await trx('invoices').where({ id: invoiceId, organization_id: req.actor.organizationId }).forUpdate().first();
          if (!invoice) throw new NotFoundError('Invoice');
          const allocationMinor = Math.min(toMinor(payment.amount), toMinor(invoice.balance));
          if (allocationMinor <= 0) throw new ValidationError('This invoice is already settled');

          await trx('payment_allocations').insert({
            id: newId(),
            organization_id: req.actor.organizationId,
            payment_id: id,
            invoice_id: invoice.id,
            amount: fromMinor(allocationMinor),
          });
          const paidMinor = toMinor(invoice.paid_amount) + allocationMinor;
          const balanceMinor = toMinor(invoice.total) - paidMinor;
          await trx('invoices').where('id', invoice.id).update({
            paid_amount: fromMinor(paidMinor),
            balance: fromMinor(balanceMinor),
            status: balanceMinor <= 0 ? 'paid' : 'partially_paid',
            updated_at: trx.fn.now(),
          });
        }

        const receiptReference = await nextReference({ trx, organizationId: req.actor.organizationId, entity: 'receipt', prefix: req.actor.referencePrefix });
        await trx('receipts').insert({
          id: newId(),
          organization_id: req.actor.organizationId,
          reference: receiptReference,
          payment_id: id,
          issued_on: payment.paid_on,
          amount: payment.amount,
          currency: payment.currency,
          issued_by_membership_id: req.actor.membershipId,
        });
      });

      await recordAudit({ ...auditFromRequest(req), action: 'payment.recorded', entityType: 'payment', entityId: id });
      sendData(res, await db('payments').where('id', id).first(), { status: 201 });
    })
  );

  router.get(
    '/receipts',
    requirePermission('invoices.read'),
    validate({ query: paginationSchema }),
    handler(async (req, res) => {
      const db = getDb();
      const rows = await db('receipts').where('organization_id', req.actor.organizationId).orderBy('issued_on', 'desc').limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.get(
    '/commission-lines',
    requirePermission('commissions.read'),
    validate({ query: paginationSchema.extend({ membership_id: idSchema.optional(), status: z.string().max(24).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      let query = db('commission_lines as cl')
        .join('deals as d', 'd.id', 'cl.deal_id')
        .where('cl.organization_id', req.actor.organizationId);
      if (req.validatedQuery.membership_id) query = query.where('cl.membership_id', req.validatedQuery.membership_id);
      if (req.validatedQuery.status) query = query.where('cl.status', req.validatedQuery.status);
      if (req.validatedQuery.from) query = query.where('cl.created_at', '>=', req.validatedQuery.from);
      if (req.validatedQuery.to) query = query.where('cl.created_at', '<=', req.validatedQuery.to);
      const rows = await query
        .select('cl.*', 'd.reference as deal_reference', 'd.won_at', 'd.deal_type')
        .orderBy('cl.created_at', 'desc')
        .limit(req.validatedQuery.per_page);
      sendList(res, rows, { page: req.validatedQuery.page, perPage: req.validatedQuery.per_page, total: rows.length });
    })
  );

  router.post(
    '/commission-lines/:id/disburse',
    requirePermission('commissions.approve'),
    validate({ params: z.object({ id: idSchema }), body: z.object({ amount: z.coerce.number().min(0).optional(), scheduled_on: z.coerce.date().optional(), notes: z.string().max(500).optional() }) }),
    handler(async (req, res) => {
      const db = getDb();
      const line = await db('commission_lines').where({ id: req.validatedParams.id, organization_id: req.actor.organizationId }).first();
      if (!line) throw new NotFoundError('Commission line');
      if (!['approved', 'calculated'].includes(line.status)) throw new ValidationError('Only an approved commission line can be disbursed');

      const id = newId();
      await db('commission_disbursements').insert({
        id,
        organization_id: req.actor.organizationId,
        commission_line_id: line.id,
        amount: req.validatedBody.amount ?? line.amount,
        status: 'scheduled',
        scheduled_on: req.validatedBody.scheduled_on ?? null,
        approved_by_membership_id: req.actor.membershipId,
        notes: req.validatedBody.notes ?? null,
      });
      sendData(res, await db('commission_disbursements').where('id', id).first(), { status: 201 });
    })
  );

  return router;
}

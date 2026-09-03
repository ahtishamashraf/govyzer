import { z } from 'zod';
import { getDb } from '@govyzer/database';
import { newId, NotFoundError, ValidationError, matchCandidates } from '@govyzer/domain';
import { structuredCompletion, isAiEnabled } from './provider.js';
import { runReport, REPORTS } from '../reports/service.js';
import { logger } from '../../core/logger.js';

const MODEL_COST_PER_1K = { 'gpt-4o-mini': 0.00075, 'gpt-4o': 0.0075 };

/** Records usage without storing prompts, so PII is never retained in the ledger. */
async function recordUsage({ db, organizationId, feature, membershipId, entityType, entityId, status, usage = {}, inputSummary = null, error = null, requestId = null }) {
  const id = newId();
  await db('ai_requests').insert({
    id,
    organization_id: organizationId,
    feature,
    provider: 'openai',
    model: usage.model ?? 'n/a',
    membership_id: membershipId ?? null,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    status,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    duration_ms: usage.duration_ms ?? null,
    error_message: error ? String(error).slice(0, 1000) : null,
    input_summary: inputSummary ? JSON.stringify(inputSummary) : null,
    request_id: requestId,
  });

  if (usage.model) {
    const period = new Date().toISOString().slice(0, 7);
    const cost = ((usage.total_tokens ?? 0) / 1000) * (MODEL_COST_PER_1K[usage.model] ?? 0.001);
    await db('ai_usage_ledger')
      .insert({
        id: newId(),
        organization_id: organizationId,
        period,
        feature,
        membership_id: membershipId ?? null,
        model: usage.model,
        request_count: 1,
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        estimated_cost: cost,
        currency: 'USD',
      })
      .onConflict(['organization_id', 'period', 'feature', 'membership_id', 'model'])
      .merge({
        request_count: db.raw('request_count + 1'),
        prompt_tokens: db.raw(`prompt_tokens + ${Number(usage.prompt_tokens ?? 0)}`),
        completion_tokens: db.raw(`completion_tokens + ${Number(usage.completion_tokens ?? 0)}`),
        estimated_cost: db.raw(`estimated_cost + ${cost}`),
        updated_at: db.fn.now(),
      });
  }
  return id;
}

async function storeArtifact({ db, organizationId, requestId, feature, entityType, entityId, artifactType, content }) {
  const id = newId();
  await db('ai_artifacts').insert({
    id,
    organization_id: organizationId,
    request_id: requestId,
    feature,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    artifact_type: artifactType,
    content: JSON.stringify(content),
    status: 'suggested',
  });
  return id;
}

// -------------------------------------------------------------- schemas ----

const leadScoreSchema = z.object({
  score: z.number(),
  band: z.enum(['hot', 'warm', 'cold']),
  explanation: z.string(),
  factors: z.array(z.object({ factor: z.string(), impact: z.enum(['positive', 'negative', 'neutral']), weight: z.number() })),
  recommended_next_action: z.string(),
});

const summarySchema = z.object({
  summary: z.string(),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  key_points: z.array(z.string()),
  next_actions: z.array(z.string()),
});

const replySchema = z.object({
  suggestions: z.array(z.object({ tone: z.enum(['professional', 'friendly', 'concise']), text: z.string() })),
  requires_human_review: z.boolean(),
});

const listingCopySchema = z.object({
  title_en: z.string(),
  description_en: z.string(),
  title_ar: z.string(),
  description_ar: z.string(),
  highlights: z.array(z.string()),
});

const duplicateSchema = z.object({
  duplicates: z.array(z.object({ id: z.string(), confidence: z.number(), reason: z.string() })),
});

const reportIntentSchema = z.object({
  report_code: z.string(),
  filters: z.object({ from: z.string().nullable(), to: z.string().nullable(), module: z.string().nullable() }),
  explanation: z.string(),
});

const dataQualitySchema = z.object({
  issues: z.array(z.object({ field: z.string(), severity: z.enum(['low', 'medium', 'high']), message: z.string(), suggested_value: z.string().nullable() })),
});

// ------------------------------------------------------------- features ----

/** Deterministic scoring used when AI is disabled or unavailable. */
function heuristicLeadScore(lead, requirement) {
  let score = 30;
  const factors = [];
  if (lead.estimated_value || requirement?.budget_max) {
    score += 15;
    factors.push({ factor: 'budget_provided', impact: 'positive', weight: 15 });
  }
  if (lead.first_response_at) {
    score += 10;
    factors.push({ factor: 'contacted', impact: 'positive', weight: 10 });
  }
  if (['qualified', 'meeting_scheduled', 'meeting_completed', 'negotiation', 'reservation'].includes(lead.stage_code)) {
    score += 25;
    factors.push({ factor: 'advanced_stage', impact: 'positive', weight: 25 });
  }
  if (lead.timeframe === 'immediate') {
    score += 15;
    factors.push({ factor: 'immediate_timeframe', impact: 'positive', weight: 15 });
  }
  if (lead.financing === 'cash') {
    score += 10;
    factors.push({ factor: 'cash_buyer', impact: 'positive', weight: 10 });
  }
  if (!lead.first_response_at && lead.sla_status === 'breached') {
    score -= 15;
    factors.push({ factor: 'sla_breached', impact: 'negative', weight: -15 });
  }
  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    band: bounded >= 70 ? 'hot' : bounded >= 40 ? 'warm' : 'cold',
    explanation: 'Scored from CRM signals (stage, budget, timeframe, financing and response history).',
    factors,
    recommended_next_action: lead.first_response_at ? 'Book a viewing or meeting' : 'Call the client now',
    source: 'rules',
  };
}

export async function runAiFeature({ organizationId, actor, feature, entityType = null, entityId = null, input = {}, language = 'en', requestId = null }) {
  const db = getDb();
  const aiAvailable = isAiEnabled();

  switch (feature) {
    case 'lead_scoring': {
      const lead = await db('leads').where({ id: entityId, organization_id: organizationId }).whereNull('deleted_at').first();
      if (!lead) throw new NotFoundError('Lead');
      const requirement = await db('lead_requirements').where({ organization_id: organizationId, lead_id: lead.id }).first();
      const fallback = heuristicLeadScore(lead, requirement);

      if (!aiAvailable) {
        await db('leads').where('id', lead.id).update({ score: fallback.score, score_explanation: fallback.explanation });
        return { feature, ai_used: false, result: fallback };
      }

      const outcome = await structuredCompletion({
        system:
          'You score UAE real-estate sales leads from CRM signals only. Never invent client details. Return a score from 0-100 with a short human readable explanation.',
        user: {
          stage: lead.stage_code,
          module: lead.module,
          purpose: lead.purpose,
          timeframe: lead.timeframe,
          financing: lead.financing,
          estimated_value: lead.estimated_value,
          days_open: Math.round((Date.now() - new Date(lead.created_at).getTime()) / 86_400_000),
          responded: Boolean(lead.first_response_at),
          sla_status: lead.sla_status,
          requirement: requirement
            ? { budget_min: requirement.budget_min, budget_max: requirement.budget_max, bedrooms_min: requirement.bedrooms_min }
            : null,
        },
        schema: leadScoreSchema,
        schemaName: 'lead_score',
      });

      const aiRequestId = await recordUsage({
        db,
        organizationId,
        feature,
        membershipId: actor?.membershipId,
        entityType: 'lead',
        entityId: lead.id,
        status: outcome.ok ? 'completed' : 'failed',
        usage: outcome.usage ?? {},
        inputSummary: { stage: lead.stage_code, module: lead.module },
        error: outcome.ok ? null : outcome.message,
        requestId,
      });

      const result = outcome.ok ? { ...outcome.data, source: 'ai' } : fallback;
      await db('leads').where('id', lead.id).update({ score: Math.round(result.score), score_explanation: result.explanation });
      if (outcome.ok) await storeArtifact({ db, organizationId, requestId: aiRequestId, feature, entityType: 'lead', entityId: lead.id, artifactType: 'score', content: result });
      return { feature, ai_used: outcome.ok, result };
    }

    case 'lead_matching': {
      const lead = await db('leads').where({ id: entityId, organization_id: organizationId }).whereNull('deleted_at').first();
      if (!lead) throw new NotFoundError('Lead');
      const requirement = await db('lead_requirements')
        .where({ organization_id: organizationId, lead_id: lead.id, is_active: true })
        .orderBy('created_at', 'desc')
        .first();
      if (!requirement) return { feature, ai_used: false, result: { matches: [], reason: 'no_active_requirement' } };

      const parsed = {
        ...requirement,
        property_types: typeof requirement.property_types === 'string' ? JSON.parse(requirement.property_types ?? '[]') : requirement.property_types,
        community_ids: typeof requirement.community_ids === 'string' ? JSON.parse(requirement.community_ids ?? '[]') : requirement.community_ids,
        amenities: typeof requirement.amenities === 'string' ? JSON.parse(requirement.amenities ?? '[]') : requirement.amenities,
      };

      const candidates =
        lead.module === 'offplan'
          ? await db('units')
              .where('organization_id', organizationId)
              .whereNull('deleted_at')
              .whereIn('stock_status', ['available', 'on_hold'])
              .limit(500)
              .select('id', 'reference', 'unit_number', 'property_type', 'bedrooms', 'built_up_area as size', 'current_price as price', 'community_id', 'view', 'handover_date', 'stock_status')
          : await db('listings')
              .where('organization_id', organizationId)
              .whereNull('deleted_at')
              .whereIn('status', ['published', 'partially_published', 'approved'])
              .limit(500)
              .select('id', 'reference', 'title', 'property_type', 'bedrooms', 'built_up_area as size', 'price', 'community_id', 'view', 'status');

      // Structured filters decide eligibility; AI only re-ranks what already qualifies.
      const matches = matchCandidates(parsed, candidates, { limit: 20 });
      return { feature, ai_used: false, result: { matches, ranking: 'structured' } };
    }

    case 'conversation_summary':
    case 'meeting_summary': {
      const messages =
        feature === 'conversation_summary'
          ? await db('messages').where({ organization_id: organizationId, lead_id: entityId }).orderBy('created_at', 'desc').limit(40)
          : [];
      const meeting = feature === 'meeting_summary' ? await db('meetings').where({ id: entityId, organization_id: organizationId }).first() : null;

      if (!aiAvailable) {
        return {
          feature,
          ai_used: false,
          result: {
            summary: meeting?.notes ?? messages.map((message) => message.body).filter(Boolean).slice(0, 5).join(' • ') ?? '',
            sentiment: 'neutral',
            key_points: [],
            next_actions: [],
          },
        };
      }

      const outcome = await structuredCompletion({
        system: 'You summarize real-estate client conversations for an agent. Be factual and never invent commitments.',
        user: {
          notes: meeting?.notes ?? null,
          // Only message bodies are sent; identifiers stay in the CRM.
          messages: messages.map((message) => ({ direction: message.direction, body: message.body })).slice(0, 30),
        },
        schema: summarySchema,
        schemaName: 'conversation_summary',
      });
      const aiRequestId = await recordUsage({ db, organizationId, feature, membershipId: actor?.membershipId, entityType, entityId, status: outcome.ok ? 'completed' : 'failed', usage: outcome.usage ?? {}, error: outcome.ok ? null : outcome.message });
      if (!outcome.ok) return { feature, ai_used: false, result: { summary: '', sentiment: 'neutral', key_points: [], next_actions: [] }, error: outcome.message };
      if (meeting) await db('meetings').where('id', meeting.id).update({ ai_summary: outcome.data.summary });
      await storeArtifact({ db, organizationId, requestId: aiRequestId, feature, entityType, entityId, artifactType: 'summary', content: outcome.data });
      return { feature, ai_used: true, result: outcome.data };
    }

    case 'reply_suggestion': {
      if (!aiAvailable) return { feature, ai_used: false, result: { suggestions: [], requires_human_review: true, reason: 'ai_disabled' } };
      const outcome = await structuredCompletion({
        system:
          'You draft short WhatsApp/email replies for a UAE real-estate agent. Never promise prices, availability or legal terms. Every draft requires human approval before sending.',
        user: { conversation: input.conversation ?? [], intent: input.intent ?? 'follow up', language },
        schema: replySchema,
        schemaName: 'reply_suggestions',
        temperature: 0.5,
      });
      const aiRequestId = await recordUsage({ db, organizationId, feature, membershipId: actor?.membershipId, entityType, entityId, status: outcome.ok ? 'completed' : 'failed', usage: outcome.usage ?? {}, error: outcome.ok ? null : outcome.message });
      if (!outcome.ok) return { feature, ai_used: false, result: { suggestions: [], requires_human_review: true }, error: outcome.message };
      await storeArtifact({ db, organizationId, requestId: aiRequestId, feature, entityType, entityId, artifactType: 'reply_suggestions', content: outcome.data });
      return { feature, ai_used: true, result: { ...outcome.data, requires_human_review: true } };
    }

    case 'listing_copy': {
      const listing = entityId ? await db('listings').where({ id: entityId, organization_id: organizationId }).first() : null;
      if (!aiAvailable) return { feature, ai_used: false, result: null, reason: 'ai_disabled' };
      const outcome = await structuredCompletion({
        system:
          'You write portal-compliant UAE property listing copy in English and Arabic. Use only supplied facts, never invent amenities, permits or prices.',
        user: {
          property_type: listing?.property_type ?? input.property_type,
          offering_type: listing?.offering_type ?? input.offering_type,
          bedrooms: listing?.bedrooms ?? input.bedrooms,
          size: listing?.built_up_area ?? input.size,
          price: listing?.price ?? input.price,
          currency: listing?.currency ?? 'AED',
          community: input.community ?? null,
          amenities: input.amenities ?? [],
          notes: input.notes ?? null,
        },
        schema: listingCopySchema,
        schemaName: 'listing_copy',
        temperature: 0.6,
      });
      const aiRequestId = await recordUsage({ db, organizationId, feature, membershipId: actor?.membershipId, entityType: 'listing', entityId, status: outcome.ok ? 'completed' : 'failed', usage: outcome.usage ?? {}, error: outcome.ok ? null : outcome.message });
      if (!outcome.ok) return { feature, ai_used: false, result: null, error: outcome.message };
      const artifactId = await storeArtifact({ db, organizationId, requestId: aiRequestId, feature, entityType: 'listing', entityId, artifactType: 'listing_copy', content: outcome.data });
      // Never written to the listing automatically: the agent applies it explicitly.
      return { feature, ai_used: true, artifact_id: artifactId, result: outcome.data, requires_confirmation: true };
    }

    case 'price_intelligence': {
      const listing = entityId ? await db('listings').where({ id: entityId, organization_id: organizationId }).first() : null;
      const comparables = listing
        ? await db('listings')
            .where('organization_id', organizationId)
            .whereNull('deleted_at')
            .where('community_id', listing.community_id)
            .where('property_type', listing.property_type)
            .whereNot('id', listing.id)
            .whereNotNull('price')
            .limit(100)
            .select('price', 'built_up_area', 'bedrooms', 'status')
        : [];
      const prices = comparables.map((row) => Number(row.price)).filter(Boolean).sort((a, b) => a - b);
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
      const perArea = comparables
        .filter((row) => row.built_up_area > 0)
        .map((row) => Number(row.price) / Number(row.built_up_area));
      return {
        feature,
        ai_used: false,
        result: {
          comparable_count: comparables.length,
          median_price: median,
          average_price_per_area: perArea.length ? Math.round(perArea.reduce((sum, value) => sum + value, 0) / perArea.length) : null,
          subject_price: listing?.price ? Number(listing.price) : null,
          position: listing?.price && median ? (Number(listing.price) > median ? 'above_market' : 'at_or_below_market') : null,
          limitations:
            'Based only on this organization’s own listings. External transaction data (DLD) is not connected, so this is not a market valuation.',
        },
      };
    }

    case 'duplicate_detection': {
      const { findDuplicateCandidates } = await import('../contacts/service.js');
      const candidates = entityType === 'contact' ? await findDuplicateCandidates({ organizationId, contactId: entityId }) : [];
      return { feature, ai_used: false, result: { duplicates: candidates, requires_confirmation: true } };
    }

    case 'natural_language_report': {
      const available = Object.entries(REPORTS).map(([code, definition]) => ({ code, name: definition.name, category: definition.category }));
      if (!aiAvailable) {
        return { feature, ai_used: false, result: { available_reports: available, reason: 'ai_disabled' } };
      }
      const outcome = await structuredCompletion({
        system:
          'You map a natural language reporting question to exactly one allowlisted report code and its date filters. You never write SQL. If nothing matches, choose the closest report and say so.',
        user: { question: input.question ?? '', available_reports: available },
        schema: reportIntentSchema,
        schemaName: 'report_intent',
      });
      await recordUsage({ db, organizationId, feature, membershipId: actor?.membershipId, status: outcome.ok ? 'completed' : 'failed', usage: outcome.usage ?? {}, error: outcome.ok ? null : outcome.message });
      if (!outcome.ok) return { feature, ai_used: false, result: { available_reports: available }, error: outcome.message };
      if (!REPORTS[outcome.data.report_code]) {
        return { feature, ai_used: true, result: { available_reports: available, error: 'The model chose an unknown report' } };
      }
      const report = await runReport({
        organizationId,
        code: outcome.data.report_code,
        filters: {
          from: outcome.data.filters.from ?? undefined,
          to: outcome.data.filters.to ?? undefined,
          module: outcome.data.filters.module ?? undefined,
        },
        actor,
      });
      return { feature, ai_used: true, result: { intent: outcome.data, report } };
    }

    case 'data_quality': {
      const table = { lead: 'leads', contact: 'contacts', listing: 'listings' }[entityType];
      if (!table) throw new ValidationError('Unsupported entity for data quality checks');
      const record = await db(table).where({ id: entityId, organization_id: organizationId }).first();
      if (!record) throw new NotFoundError(entityType);

      const issues = [];
      if (table === 'listings') {
        if (!record.permit_number) issues.push({ field: 'permit_number', severity: 'high', message: 'Portals require a DLD/Trakheesi permit number', suggested_value: null });
        if (!record.description || record.description.length < 50) issues.push({ field: 'description', severity: 'medium', message: 'Description is too short for portal publication', suggested_value: null });
        if (!record.primary_agent_membership_id) issues.push({ field: 'primary_agent_membership_id', severity: 'high', message: 'A primary agent is required', suggested_value: null });
      }
      if (table === 'leads') {
        if (!record.source_id) issues.push({ field: 'source_id', severity: 'medium', message: 'Lead source is missing, so attribution reporting will be incomplete', suggested_value: null });
        if (!record.estimated_value) issues.push({ field: 'estimated_value', severity: 'low', message: 'No budget captured yet', suggested_value: null });
      }
      if (table === 'contacts') {
        const identifiers = await db('contact_identifiers').where({ organization_id: organizationId, contact_id: entityId }).count({ total: 'id' }).first();
        if (Number(identifiers?.total ?? 0) === 0) issues.push({ field: 'identifiers', severity: 'high', message: 'Contact has no phone or email', suggested_value: null });
      }
      return { feature, ai_used: false, result: dataQualitySchema.parse({ issues }) };
    }

    default:
      throw new ValidationError(`Unknown AI feature ${feature}`);
  }
}

export async function recordFeedback({ organizationId, actor, payload }) {
  const db = getDb();
  const id = newId();
  await db('ai_feedback').insert({
    id,
    organization_id: organizationId,
    artifact_id: payload.artifact_id ?? null,
    request_id: payload.request_id ?? null,
    membership_id: actor.membershipId,
    rating: payload.rating,
    comment: payload.comment ?? null,
  });
  return db('ai_feedback').where('id', id).first();
}

export async function applyArtifact({ organizationId, actor, artifactId }) {
  const db = getDb();
  const artifact = await db('ai_artifacts').where({ id: artifactId, organization_id: organizationId }).first();
  if (!artifact) throw new NotFoundError('AI artifact');
  const content = typeof artifact.content === 'string' ? JSON.parse(artifact.content) : artifact.content;

  if (artifact.artifact_type === 'listing_copy' && artifact.entity_id) {
    await db('listings').where({ id: artifact.entity_id, organization_id: organizationId }).update({
      title: content.title_en,
      description: content.description_en,
      title_ar: content.title_ar,
      description_ar: content.description_ar,
      updated_by: actor.membershipId,
      updated_at: db.fn.now(),
    });
  } else {
    logger.info('ai_artifact_not_applicable', { artifact_type: artifact.artifact_type });
  }

  await db('ai_artifacts').where('id', artifact.id).update({ status: 'applied', applied_by_membership_id: actor.membershipId, applied_at: db.fn.now() });
  return db('ai_artifacts').where('id', artifact.id).first();
}

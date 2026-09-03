import { getDb } from '@govyzer/database';
import {
  newId,
  DEFAULT_ROLES,
  PERMISSIONS,
  DEFAULT_LEAD_STAGES,
  DEFAULT_COMMISSION_PLAN,
  DEFAULT_POINTS_RULES,
  DEFAULT_SLA,
} from '@govyzer/domain';

/** Ensures the platform permission catalogue and system roles exist. Idempotent. */
export async function ensurePlatformCatalogue(trx = getDb()) {
  const existing = new Set(await trx('permissions').pluck('code'));
  const missing = PERMISSIONS.filter(([code]) => !existing.has(code)).map(([code, module, description]) => ({
    id: newId(),
    code,
    module,
    description,
  }));
  if (missing.length > 0) await trx('permissions').insert(missing);

  const permissionIds = new Map(await trx('permissions').select('code', 'id').then((rows) => rows.map((row) => [row.code, row.id])));

  for (const role of DEFAULT_ROLES) {
    let existingRole = await trx('roles').where({ organization_id: '', code: role.code }).first();
    if (!existingRole) {
      const id = newId();
      await trx('roles').insert({
        id,
        organization_id: '',
        code: role.code,
        name: role.name,
        description: `${role.name} (system role)`,
        is_system: true,
        priority: role.priority,
      });
      existingRole = { id };
    }
    const current = new Set(await trx('role_permissions').where('role_id', existingRole.id).pluck('permission_id'));
    const rows = role.permissions
      .map((code) => permissionIds.get(code))
      .filter((permissionId) => permissionId && !current.has(permissionId))
      .map((permissionId) => ({ role_id: existingRole.id, permission_id: permissionId }));
    if (rows.length > 0) await trx('role_permissions').insert(rows);
  }

  const plans = [
    { code: 'starter', name: 'Starter', price: 0, modules: ['ready'], limits: { users: 5, listings: 100, displays: 1 } },
    { code: 'growth', name: 'Growth', price: 1499, modules: ['ready', 'offplan', 'sales_screen'], limits: { users: 25, listings: 1000, displays: 5 } },
    { code: 'enterprise', name: 'Enterprise', price: 4999, modules: ['ready', 'offplan', 'sales_screen', 'finance', 'admin'], limits: { users: 500, listings: 50000, displays: 50 } },
  ];
  for (const plan of plans) {
    const exists = await trx('subscription_plans').where('code', plan.code).first('id');
    if (exists) continue;
    await trx('subscription_plans').insert({
      id: newId(),
      code: plan.code,
      name: plan.name,
      description: `${plan.name} plan`,
      price_monthly: plan.price,
      currency: 'AED',
      modules: JSON.stringify(plan.modules),
      limits: JSON.stringify(plan.limits),
      is_public: true,
    });
  }
}

/**
 * Creates every default a new tenant needs to be immediately usable: branding, a plan,
 * lead pipeline stages, sources, SLA, commission plan, points rules and a Sales Screen
 * playlist.
 */
export async function provisionOrganizationDefaults(trx, organization, { modules = ['ready'] } = {}) {
  await ensurePlatformCatalogue(trx);

  await trx('organization_branding').insert({
    id: newId(),
    organization_id: organization.id,
    company_display_name: organization.name,
  });

  const planCode = modules.includes('offplan') || modules.includes('sales_screen') ? 'growth' : 'starter';
  const plan = await trx('subscription_plans').where('code', planCode).first();
  await trx('organization_subscriptions').insert({
    id: newId(),
    organization_id: organization.id,
    plan_id: plan.id,
    status: 'trialing',
    seats: 5,
    started_at: trx.fn.now(),
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    modules_override: JSON.stringify([...new Set([...modules, 'finance', 'admin'])]),
  });

  await trx('organization_domains').insert({
    id: newId(),
    organization_id: organization.id,
    hostname: `${organization.slug}.govyzer.app`,
    type: 'subdomain',
    is_primary: true,
    status: 'active',
    verified_at: trx.fn.now(),
  });

  const branch = { id: newId(), organization_id: organization.id, name: 'Head Office', code: 'HQ', is_active: true };
  await trx('branches').insert(branch);

  const stageRows = [];
  for (const pipeline of ['ready', 'offplan']) {
    DEFAULT_LEAD_STAGES.forEach((stage, index) => {
      stageRows.push({
        id: newId(),
        organization_id: organization.id,
        pipeline,
        code: stage.code,
        name: JSON.stringify({ en: stage.en, ar: stage.ar }),
        position: index,
        category: stage.category,
        is_default_entry: Boolean(stage.entry),
        is_active: true,
      });
    });
  }
  await trx('lead_stage_definitions').insert(stageRows);

  const sources = [
    ['website', 'Website', 'owned'],
    ['property_finder', 'Property Finder', 'portal'],
    ['bayut', 'Bayut', 'portal'],
    ['dubizzle', 'Dubizzle', 'portal'],
    ['facebook', 'Facebook', 'social'],
    ['instagram', 'Instagram', 'social'],
    ['google_ads', 'Google Ads', 'paid'],
    ['whatsapp', 'WhatsApp', 'messaging'],
    ['walk_in', 'Walk-in', 'direct'],
    ['call', 'Phone call', 'direct'],
    ['referral', 'Referral', 'direct'],
    ['zapier', 'Zapier', 'automation'],
  ];
  await trx('lead_sources').insert(
    sources.map(([code, name, category]) => ({
      id: newId(),
      organization_id: organization.id,
      code,
      name,
      category,
      is_system: true,
      is_active: true,
    }))
  );

  for (const module of ['ready', 'offplan']) {
    await trx('lead_sla_rules').insert({
      id: newId(),
      organization_id: organization.id,
      name: `${module === 'ready' ? 'Ready' : 'Off-plan'} response SLA`,
      module,
      acknowledge_minutes: DEFAULT_SLA.acknowledge_minutes,
      manager_alert_minutes: DEFAULT_SLA.manager_alert_minutes,
      pool_release_minutes: DEFAULT_SLA.pool_release_minutes,
      working_hours_only: false,
      actions: JSON.stringify({ acknowledge: 'notify_agent', manager_alert: 'notify_manager', pool_release: 'release_to_pool' }),
      is_active: true,
    });
  }

  const commissionPlanId = newId();
  await trx('commission_plans').insert({
    id: commissionPlanId,
    organization_id: organization.id,
    name: DEFAULT_COMMISSION_PLAN.name,
    code: DEFAULT_COMMISSION_PLAN.code,
    description: 'Half of the commission to the closing agent, half to the company.',
    commission_base: organization.commission_base ?? 'gross_before_vat',
    is_default: true,
    is_active: true,
  });
  await trx('commission_rules').insert(
    DEFAULT_COMMISSION_PLAN.rules.map((rule) => ({
      id: newId(),
      organization_id: organization.id,
      plan_id: commissionPlanId,
      position: rule.position,
      recipient_type: rule.recipient_type,
      calculation_type: rule.calculation_type,
      percentage: rule.percentage,
      applies_to: rule.applies_to,
      is_active: true,
    }))
  );
  await trx('commission_plan_assignments').insert({
    id: newId(),
    organization_id: organization.id,
    plan_id: commissionPlanId,
    scope_type: 'organization',
    priority: 1000,
    is_active: true,
  });

  await trx('points_rules').insert(
    DEFAULT_POINTS_RULES.filter((rule) => rule.code !== 'revenue_points').map((rule) => ({
      id: newId(),
      organization_id: organization.id,
      code: rule.code,
      name: rule.name,
      event_type: rule.event_type,
      points: rule.points,
      calculation: rule.calculation,
      points_per_amount: rule.points_per_amount ?? null,
      conditions: rule.conditions ? JSON.stringify(rule.conditions) : null,
      version_number: 1,
      is_active: true,
    }))
  );

  const playlistId = newId();
  await trx('display_playlists').insert({
    id: playlistId,
    organization_id: organization.id,
    name: 'Default playlist',
    description: 'Deals, listings, leaderboards and targets',
    is_default: true,
    is_active: true,
  });
  const slides = [
    ['new_deal_celebration', 'New deal', 18],
    ['top_agents', 'Top agents', 15],
    ['total_revenue', 'Revenue', 12],
    ['target_progress', 'Targets', 12],
    ['points_leaderboard', 'Points leaderboard', 15],
    ['new_listing', 'New listings', 12],
    ['stock_summary', 'Off-plan stock', 12],
    ['announcements', 'Announcements', 10],
  ];
  await trx('display_slides').insert(
    slides.map(([slideType, title, duration], index) => ({
      id: newId(),
      organization_id: organization.id,
      playlist_id: playlistId,
      slide_type: slideType,
      title,
      position: index,
      duration_seconds: duration,
      is_enabled: true,
      config: JSON.stringify({}),
    }))
  );

  const templates = [
    ['form_a', 'Form A (Seller listing agreement) — sample', 'agency', 'form_a'],
    ['form_b', 'Form B (Buyer agreement) — sample', 'agency', 'form_b'],
    ['form_f', 'Form F (MOU) — sample', 'transaction', 'form_f'],
    ['form_i', 'Form I (Broker to broker) — sample', 'transaction', 'form_i'],
    ['tenancy_contract', 'Tenancy contract — sample', 'tenancy', 'tenancy_contract'],
    ['reservation_form', 'Off-plan reservation form — sample', 'offplan', 'reservation_form'],
    ['booking_form', 'Off-plan booking form — sample', 'offplan', 'booking_form'],
    ['invoice', 'Commission invoice', 'finance', 'invoice'],
    ['receipt', 'Payment receipt', 'finance', 'receipt'],
  ];
  for (const [code, name, category, documentType] of templates) {
    const templateId = newId();
    const versionId = newId();
    await trx('document_templates').insert({
      id: templateId,
      organization_id: organization.id,
      code,
      name,
      category,
      document_type: documentType,
      language: 'en',
      current_version_id: versionId,
      requires_approval: true,
      is_sample: true,
      is_active: true,
    });
    await trx('document_template_versions').insert({
      id: versionId,
      organization_id: organization.id,
      template_id: templateId,
      version_number: 1,
      body_html: sampleTemplateHtml(name),
      variables: JSON.stringify([
        { key: 'organization.name', label: 'Company name', required: true },
        { key: 'contact.display_name', label: 'Client name', required: true },
        { key: 'deal.reference', label: 'Deal reference', required: false },
        { key: 'property.reference', label: 'Property reference', required: false },
        { key: 'amount', label: 'Amount', required: false },
        { key: 'date', label: 'Date', required: true },
      ]),
      status: 'draft',
      change_note: 'Seeded sample template. Upload or approve your official form before production use.',
    });
  }

  return { branchId: branch.id, commissionPlanId, playlistId };
}

function sampleTemplateHtml(name) {
  return `<section class="document">
  <h1>${name}</h1>
  <p class="notice"><strong>Sample template.</strong> This wording is not legally reviewed. Replace it with your
  organization's approved form before using it with clients.</p>
  <p>Company: {{organization.name}}</p>
  <p>Client: {{contact.display_name}}</p>
  <p>Reference: {{deal.reference}}</p>
  <p>Property: {{property.reference}}</p>
  <p>Amount: {{amount}}</p>
  <p>Date: {{date}}</p>
  <div class="signatures"><div>Client signature</div><div>Company signature</div></div>
</section>`;
}

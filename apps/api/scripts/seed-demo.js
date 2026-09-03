#!/usr/bin/env node
/**
 * Development-only demo data. Creates a platform administrator and two unrelated demo
 * organizations so tenant isolation can be exercised end to end.
 *
 * Refuses to run when APP_ENV=production.
 */
import process from 'node:process';
import bcrypt from 'bcryptjs';
import { getDb, destroyDb, withTransaction } from '@govyzer/database';
import { loadServerConfig } from '@govyzer/config';
import { newId } from '@govyzer/domain';
import { provisionOrganizationDefaults, ensurePlatformCatalogue } from '../src/modules/organizations/provisioning.js';
import { createLead } from '../src/modules/leads/service.js';
import { createListing, decideApproval, submitForApproval } from '../src/modules/listings/service.js';
import { createReservation, createBooking } from '../src/modules/offplan/inventory.js';
import { createDeal, changeStage } from '../src/modules/deals/service.js';
import { processOutboxBatch } from '../src/jobs/outbox-processor.js';
import { runJobBatch } from '../src/core/jobs.js';
import { nextReference } from '../src/core/references.js';

const PASSWORD = 'GovyzerDemo!2026';

async function hash() {
  return bcrypt.hash(PASSWORD, 10);
}

async function createUser(trx, { email, firstName, lastName, passwordHash, isPlatformAdmin = false }) {
  const existing = await trx('users').where('email', email).first();
  if (existing) return existing;
  const id = newId();
  await trx('users').insert({
    id,
    email,
    password_hash: passwordHash,
    first_name: firstName,
    last_name: lastName,
    status: 'active',
    email_verified_at: trx.fn.now(),
    is_platform_admin: isPlatformAdmin,
    locale: 'en',
    timezone: 'Asia/Dubai',
  });
  return trx('users').where('id', id).first();
}

async function addMembership(trx, { organizationId, userId, roleCode, branchId, teamId = null, managerMembershipId = null, modules, recordScope, jobTitle }) {
  const membershipId = newId();
  await trx('organization_memberships').insert({
    id: membershipId,
    organization_id: organizationId,
    user_id: userId,
    branch_id: branchId,
    team_id: teamId,
    manager_membership_id: managerMembershipId,
    job_title: jobTitle,
    status: 'active',
    record_scope: recordScope,
    modules: JSON.stringify(modules),
    capacity_limit: 60,
    languages: JSON.stringify(['en', 'ar']),
    accepted_at: trx.fn.now(),
  });
  const role = await trx('roles').where({ organization_id: '', code: roleCode }).first('id');
  await trx('membership_roles').insert({ membership_id: membershipId, role_id: role.id });
  return membershipId;
}

async function seedOrganization(db, { name, slug, prefix, modules, passwordHash, emailDomain }) {
  const existing = await db('organizations').where('slug', slug).first('id');
  if (existing) {
    console.log(`Skipping ${name}: workspace "${slug}" already exists. Run "npm run db:reset" for a clean demo.`);
    return null;
  }

  const organization = {
    id: newId(),
    name,
    slug,
    status: 'active',
    country: 'AE',
    default_locale: 'en',
    default_currency: 'AED',
    timezone: 'Asia/Dubai',
    reference_prefix: prefix,
    commission_base: 'gross_before_vat',
    vat_percentage: 5,
  };

  const people = await withTransaction(db, async (trx) => {
    await ensurePlatformCatalogue(trx);
    await trx('organizations').insert(organization);
    const defaults = await provisionOrganizationDefaults(trx, organization, { modules });

    const owner = await createUser(trx, { email: `owner@${emailDomain}`, firstName: 'Amira', lastName: 'Haddad', passwordHash });
    const manager = await createUser(trx, { email: `manager@${emailDomain}`, firstName: 'Yousef', lastName: 'Rahman', passwordHash });
    const agentOne = await createUser(trx, { email: `agent1@${emailDomain}`, firstName: 'Sara', lastName: 'Nasser', passwordHash });
    const agentTwo = await createUser(trx, { email: `agent2@${emailDomain}`, firstName: 'Karim', lastName: 'Fahim', passwordHash });
    const listingAdmin = await createUser(trx, { email: `listings@${emailDomain}`, firstName: 'Dina', lastName: 'Aziz', passwordHash });
    const offplanAdmin = await createUser(trx, { email: `offplan@${emailDomain}`, firstName: 'Rami', lastName: 'Saleh', passwordHash });
    const finance = await createUser(trx, { email: `finance@${emailDomain}`, firstName: 'Leila', lastName: 'Mansour', passwordHash });

    const teamId = newId();
    await trx('teams').insert({
      id: teamId,
      organization_id: organization.id,
      branch_id: defaults.branchId,
      name: 'Sales Team A',
      code: 'SALES-A',
      is_active: true,
    });

    const ownerMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: owner.id,
      roleCode: 'org_owner',
      branchId: defaults.branchId,
      modules: [...modules, 'finance', 'admin'],
      recordScope: 'organization',
      jobTitle: 'Managing Director',
    });
    const managerMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: manager.id,
      roleCode: 'sales_manager',
      branchId: defaults.branchId,
      teamId,
      managerMembershipId: ownerMembership,
      modules,
      recordScope: 'team',
      jobTitle: 'Sales Manager',
    });
    const agentOneMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: agentOne.id,
      roleCode: 'agent',
      branchId: defaults.branchId,
      teamId,
      managerMembershipId: managerMembership,
      modules: ['ready'],
      recordScope: 'assigned',
      jobTitle: 'Property Consultant',
    });
    const agentTwoMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: agentTwo.id,
      roleCode: modules.includes('offplan') ? 'offplan_agent' : 'agent',
      branchId: defaults.branchId,
      teamId,
      managerMembershipId: managerMembership,
      modules: modules.includes('offplan') ? ['offplan'] : ['ready'],
      recordScope: 'assigned',
      jobTitle: 'Off-plan Consultant',
    });
    const listingAdminMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: listingAdmin.id,
      roleCode: 'listing_admin',
      branchId: defaults.branchId,
      modules: ['ready'],
      recordScope: 'organization',
      jobTitle: 'Listing Administrator',
    });
    const offplanAdminMembership = modules.includes('offplan')
      ? await addMembership(trx, {
          organizationId: organization.id,
          userId: offplanAdmin.id,
          roleCode: 'offplan_admin',
          branchId: defaults.branchId,
          modules: ['offplan'],
          recordScope: 'organization',
          jobTitle: 'Off-plan Administrator',
        })
      : null;
    const financeMembership = await addMembership(trx, {
      organizationId: organization.id,
      userId: finance.id,
      roleCode: 'finance',
      branchId: defaults.branchId,
      modules: ['finance', ...modules],
      recordScope: 'organization',
      jobTitle: 'Finance Manager',
    });

    await trx('teams').where('id', teamId).update({ manager_membership_id: managerMembership, leader_membership_id: managerMembership });

    if (modules.includes('sales_screen')) {
      const displayId = newId();
      const playlist = await trx('display_playlists').where({ organization_id: organization.id, is_default: true }).first('id');
      await trx('sales_displays').insert({
        id: displayId,
        organization_id: organization.id,
        name: 'Reception TV',
        location: 'Main reception',
        branch_id: defaults.branchId,
        playlist_id: playlist?.id ?? null,
        status: 'unpaired',
        theme: 'midnight',
        privacy_settings: JSON.stringify({ mask_agent_names: false, mask_amounts: false, hide_exact_address: true, show_client_initials_only: true }),
        auto_approve_events: true,
        created_by: ownerMembership,
      });

      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      monthEnd.setUTCDate(0);
      await trx('targets').insert({
        id: newId(),
        organization_id: organization.id,
        target_type: 'revenue',
        scope_type: 'organization',
        period_type: 'month',
        period_start: monthStart,
        period_end: monthEnd,
        target_value: 750000,
        currency: 'AED',
        is_active: true,
      });
    }

    // A published workflow the tenant can inspect and edit.
    const workflowId = newId();
    const versionId = newId();
    await trx('workflow_definitions').insert({
      id: workflowId,
      organization_id: organization.id,
      name: 'Notify manager when a high value lead arrives',
      code: 'high_value_lead_alert',
      description: 'Alerts the sales manager and creates a same-day follow up task.',
      trigger_type: 'record_created',
      entity_type: 'lead',
      status: 'published',
      current_version_id: versionId,
      is_enabled: true,
      created_by: ownerMembership,
    });
    await trx('workflow_versions').insert({
      id: versionId,
      organization_id: organization.id,
      workflow_id: workflowId,
      version_number: 1,
      trigger_config: JSON.stringify({ entity_type: 'lead' }),
      conditions: JSON.stringify([{ field: 'lead.estimated_value', operator: 'gte', value: 2000000 }]),
      actions: JSON.stringify([
        { position: 1, action_type: 'notify_manager', config: { title: 'High value lead', body: 'A lead above AED 2M just arrived.' } },
        { position: 2, action_type: 'create_task', config: { title: 'Call the high value lead today', due_in_minutes: 120, priority: 'high' } },
      ]),
      status: 'published',
      published_by_membership_id: ownerMembership,
      published_at: trx.fn.now(),
    });

    return {
      organization,
      branchId: defaults.branchId,
      teamId,
      ownerMembership,
      managerMembership,
      agentOneMembership,
      agentTwoMembership,
      listingAdminMembership,
      offplanAdminMembership,
      financeMembership,
      users: { owner, manager, agentOne, agentTwo, listingAdmin, offplanAdmin, finance },
    };
  });

  return people;
}

function actorFor(org, membershipId, permissions) {
  return {
    type: 'user',
    organizationId: org.organization.id,
    membershipId,
    userId: null,
    isPlatformAdmin: false,
    permissions: new Set(permissions),
    modules: ['ready', 'offplan', 'sales_screen', 'finance', 'admin'],
    recordScope: 'organization',
    referencePrefix: org.organization.reference_prefix,
    vatPercentage: 5,
    teamId: org.teamId,
    branchId: org.branchId,
    managerMembershipId: org.managerMembership,
  };
}

const ALL_PERMISSIONS = ['listings.publish', 'listings.approve', 'leads.assign', 'deals.win', 'commissions.read'];

async function seedBusinessData(db, org, { withOffplan }) {
  const organizationId = org.organization.id;
  const actor = actorFor(org, org.ownerMembership, ALL_PERMISSIONS);
  const community = await db('communities').where('organization_id', '').where('name', 'Dubai Marina').first();
  const city = community ? await db('cities').where('id', community.city_id).first() : null;

  // --- Ready listings ---
  const listingSpecs = [
    { title: 'Full marina view 2BR in Marina Gate', price: 2450000, bedrooms: 2, area: 1280, exclusive: true, agent: org.agentOneMembership, status: 'published' },
    { title: 'Upgraded 1BR with study near the tram', price: 1350000, bedrooms: 1, area: 820, exclusive: false, agent: org.agentOneMembership, status: 'approved' },
    { title: 'Spacious 3BR family home with maid room', price: 4200000, bedrooms: 3, area: 2150, exclusive: false, agent: org.agentTwoMembership, status: 'draft' },
    { title: 'Bright 2BR available for rent from June', price: 165000, bedrooms: 2, area: 1180, exclusive: false, agent: org.agentOneMembership, status: 'published', offering: 'rent' },
  ];

  const listings = [];
  for (const spec of listingSpecs) {
    const { listing } = await createListing({
      organizationId,
      actor,
      payload: {
        offering_type: spec.offering ?? 'sale',
        property_category: 'residential',
        property_type: 'apartment',
        title: spec.title,
        description: `${spec.title}. Bright layout, well maintained building, close to retail and the metro. Chiller and maintenance handled by the building management.`,
        price: spec.price,
        currency: 'AED',
        rent_frequency: spec.offering === 'rent' ? 'yearly' : undefined,
        bedrooms: spec.bedrooms,
        bathrooms: spec.bedrooms,
        built_up_area: spec.area,
        size_unit: 'sqft',
        parking_spaces: 1,
        furnishing: 'unfurnished',
        occupancy_status: 'vacant',
        is_exclusive: spec.exclusive,
        city_id: city?.id,
        community_id: community?.id,
        permit_number: `71${Math.floor(Math.random() * 100000000)}`,
        permit_expires_on: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
        primary_agent_membership_id: spec.agent,
        manager_membership_id: org.managerMembership,
        amenity_codes: ['balcony', 'shared_pool', 'shared_gym', 'covered_parking'],
      },
    });

    if (spec.status !== 'draft') {
      await submitForApproval({ organizationId, actor, id: listing.id });
      await decideApproval({ organizationId, actor, id: listing.id, decision: 'approved', reason: 'Permit and media verified' });
    }
    if (spec.status === 'published') {
      await db('listings').where('id', listing.id).update({ status: 'published', published_at: db.fn.now() });
    }
    listings.push(listing);
  }

  // --- Contacts with several simultaneous leads ---
  const leadSpecs = [
    {
      contact: { first_name: 'Omar', last_name: 'Al Habtoor', identifiers: [{ identifier_type: 'phone', value: '0501112233', is_primary: true }, { identifier_type: 'email', value: 'omar.habtoor@example.ae' }], roles: ['buyer', 'investor'] },
      leads: [
        { module: 'ready', purpose: 'buy', estimated_value: 2500000, listing_id: listings[0].id, source_code: 'property_finder', stage: 'qualified' },
        { module: withOffplan ? 'offplan' : 'ready', purpose: 'invest', estimated_value: 1800000, source_code: 'website', stage: 'contacted' },
      ],
    },
    {
      contact: { first_name: 'Noura', last_name: 'Al Suwaidi', identifiers: [{ identifier_type: 'phone', value: '0554445566', is_primary: true }], roles: ['tenant'] },
      leads: [{ module: 'ready', purpose: 'rent', estimated_value: 170000, listing_id: listings[3].id, source_code: 'bayut', stage: 'meeting_scheduled' }],
    },
    {
      contact: { first_name: 'James', last_name: 'Whitfield', identifiers: [{ identifier_type: 'email', value: 'james.whitfield@example.com' }], roles: ['buyer'] },
      leads: [{ module: 'ready', purpose: 'buy', estimated_value: 4300000, source_code: 'referral', stage: 'negotiation' }],
    },
    {
      contact: { first_name: 'Fatima', last_name: 'Khan', identifiers: [{ identifier_type: 'phone', value: '0567778899', is_primary: true }], roles: ['seller', 'landlord'] },
      leads: [{ module: 'ready', purpose: 'sell', estimated_value: 3100000, source_code: 'walk_in', stage: 'new_inquiry' }],
    },
  ];

  const createdLeads = [];
  for (const spec of leadSpecs) {
    let contactId = null;
    for (const leadSpec of spec.leads) {
      const result = await createLead({
        organizationId,
        actor,
        payload: {
          contact_id: contactId ?? undefined,
          contact: contactId ? undefined : spec.contact,
          module: leadSpec.module,
          purpose: leadSpec.purpose,
          source_code: leadSpec.source_code,
          listing_id: leadSpec.listing_id,
          estimated_value: leadSpec.estimated_value,
          language: 'en',
          assigned_membership_id: leadSpec.module === 'offplan' ? org.agentTwoMembership : org.agentOneMembership,
          requirements: [
            {
              purpose: leadSpec.purpose,
              module: leadSpec.module,
              property_types: ['apartment'],
              bedrooms_min: 2,
              bedrooms_max: 3,
              budget_min: Math.round(leadSpec.estimated_value * 0.8),
              budget_max: leadSpec.estimated_value,
              community_ids: community ? [community.id] : [],
            },
          ],
        },
        source: 'seed',
      });
      contactId = result.contact.id;
      createdLeads.push(result.lead);
      if (leadSpec.stage !== 'new_inquiry') {
        await db('leads').where('id', result.lead.id).update({ stage_code: leadSpec.stage, first_response_at: db.fn.now(), acknowledged_at: db.fn.now(), sla_status: 'met' });
      }
    }
  }

  // --- Activities ---
  const now = Date.now();
  await db('meetings').insert({
    id: newId(),
    organization_id: organizationId,
    title: 'Marina Gate viewing',
    meeting_type: 'viewing',
    module: 'ready',
    lead_id: createdLeads[0].id,
    contact_id: createdLeads[0].contact_id,
    listing_id: listings[0].id,
    location: 'Marina Gate lobby',
    location_type: 'site',
    starts_at: new Date(now + 24 * 60 * 60 * 1000),
    ends_at: new Date(now + 25 * 60 * 60 * 1000),
    status: 'scheduled',
    organizer_membership_id: org.agentOneMembership,
    created_by: org.agentOneMembership,
  });
  await db('viewings').insert({
    id: newId(),
    organization_id: organizationId,
    lead_id: createdLeads[0].id,
    contact_id: createdLeads[0].contact_id,
    listing_id: listings[0].id,
    scheduled_at: new Date(now - 3 * 24 * 60 * 60 * 1000),
    completed_at: new Date(now - 3 * 24 * 60 * 60 * 1000),
    status: 'completed',
    agent_membership_id: org.agentOneMembership,
    feedback: 'Client liked the view, asked about service charges.',
    interest_level: 4,
    outcome: 'follow_up',
    created_by: org.agentOneMembership,
  });
  await db('tasks').insert({
    id: newId(),
    organization_id: organizationId,
    title: 'Send service charge breakdown',
    entity_type: 'lead',
    entity_id: createdLeads[0].id,
    assigned_membership_id: org.agentOneMembership,
    status: 'open',
    priority: 'high',
    due_at: new Date(now + 6 * 60 * 60 * 1000),
    created_by: org.agentOneMembership,
  });

  // --- Off-plan inventory ---
  let reservation = null;
  if (withOffplan) {
    const developerId = newId();
    await db('developers').insert({
      id: developerId,
      organization_id: organizationId,
      name: 'Harbour Developments',
      slug: 'harbour-developments',
      description: 'Waterfront developer focused on Dubai Creek and Marina districts.',
      default_commission_percentage: 4,
      is_active: true,
      created_by: org.offplanAdminMembership ?? org.ownerMembership,
    });

    const projectId = newId();
    const projectReference = await nextReference({ organizationId, entity: 'project', prefix: org.organization.reference_prefix, periodic: false });
    await db('projects').insert({
      id: projectId,
      organization_id: organizationId,
      developer_id: developerId,
      name: 'Harbour Lights Residences',
      reference: projectReference,
      slug: 'harbour-lights-residences',
      project_type: 'residential',
      status: 'selling',
      construction_status: 'under_construction',
      construction_percentage: 35,
      city_id: city?.id,
      community_id: community?.id,
      description: 'A waterfront tower with 1-3 bedroom residences, a podium pool deck and direct promenade access.',
      handover_date: new Date(now + 700 * 24 * 60 * 60 * 1000),
      starting_price: 1450000,
      total_units: 24,
      default_manager_membership_id: org.managerMembership,
      assignment_policy: JSON.stringify({ strategies: ['project_specialist', 'least_workload'], membership_ids: [org.agentTwoMembership] }),
      created_by: org.offplanAdminMembership ?? org.ownerMembership,
    });

    const unitTypes = [
      ['1BR-A', '1 Bedroom Type A', 1, 780],
      ['2BR-A', '2 Bedroom Type A', 2, 1250],
      ['3BR-A', '3 Bedroom Type A', 3, 1780],
    ];
    const unitTypeIds = {};
    for (const [code, name, bedrooms, area] of unitTypes) {
      const id = newId();
      unitTypeIds[code] = id;
      await db('unit_types').insert({
        id,
        organization_id: organizationId,
        project_id: projectId,
        code,
        name,
        property_type: 'apartment',
        bedrooms,
        bathrooms: bedrooms,
        total_area: area,
        size_unit: 'sqft',
      });
    }

    const planId = newId();
    await db('project_payment_plans').insert({
      id: planId,
      organization_id: organizationId,
      project_id: projectId,
      name: '60/40 construction linked',
      code: '60-40',
      plan_type: 'construction_linked',
      down_payment_percentage: 20,
      on_handover_percentage: 40,
      booking_amount: 50000,
      dld_fee_percentage: 4,
      currency: 'AED',
      is_default: true,
      created_by: org.offplanAdminMembership ?? org.ownerMembership,
    });
    await db('payment_plan_installments').insert([
      { id: newId(), organization_id: organizationId, payment_plan_id: planId, position: 1, label: 'Down payment', percentage: 20, trigger_type: 'milestone', milestone: 'Booking' },
      { id: newId(), organization_id: organizationId, payment_plan_id: planId, position: 2, label: '40% during construction', percentage: 40, trigger_type: 'milestone', milestone: 'Construction milestones' },
      { id: newId(), organization_id: organizationId, payment_plan_id: planId, position: 3, label: '40% on handover', percentage: 40, trigger_type: 'on_handover' },
    ]);

    const statuses = ['available', 'available', 'available', 'available', 'on_hold', 'reserved', 'booked', 'sold', 'blocked', 'unreleased'];
    const unitIds = [];
    for (let index = 0; index < 24; index += 1) {
      const floor = 5 + Math.floor(index / 4);
      const typeCode = index % 3 === 0 ? '1BR-A' : index % 3 === 1 ? '2BR-A' : '3BR-A';
      const area = unitTypes.find(([code]) => code === typeCode)[3];
      const price = 1450000 + index * 65000;
      const id = newId();
      const reference = await nextReference({ organizationId, entity: 'unit', prefix: org.organization.reference_prefix, periodic: false });
      await db('units').insert({
        id,
        organization_id: organizationId,
        module: 'offplan',
        project_id: projectId,
        unit_type_id: unitTypeIds[typeCode],
        city_id: city?.id,
        community_id: community?.id,
        unit_number: `${floor}0${(index % 4) + 1}`,
        reference,
        floor_label: String(floor),
        property_type: 'apartment',
        bedrooms: unitTypes.find(([code]) => code === typeCode)[2],
        bathrooms: unitTypes.find(([code]) => code === typeCode)[2],
        built_up_area: area,
        size_unit: 'sqft',
        parking_spaces: 1,
        view: index % 2 === 0 ? 'Marina' : 'Community',
        base_price: price,
        current_price: price,
        currency: 'AED',
        stock_status: index < 10 ? statuses[index] : 'available',
        handover_date: new Date(now + 700 * 24 * 60 * 60 * 1000),
        payment_plan_id: planId,
        created_by: org.offplanAdminMembership ?? org.ownerMembership,
      });
      unitIds.push(id);
    }

    const offplanLead = createdLeads.find((lead) => lead.module === 'offplan');
    if (offplanLead) {
      const availableUnit = await db('units').where({ organization_id: organizationId, project_id: projectId, stock_status: 'available' }).first();
      const reservationActor = actorFor(org, org.agentTwoMembership, ALL_PERMISSIONS);
      const result = await createReservation({
        organizationId,
        actor: reservationActor,
        payload: {
          unit_id: availableUnit.id,
          contact_id: offplanLead.contact_id,
          lead_id: offplanLead.id,
          payment_plan_id: planId,
          unit_price: availableUnit.current_price,
          reservation_amount: 50000,
          currency: 'AED',
          expires_in_hours: 72,
        },
      });
      reservation = result.reservation;
      await createBooking({ organizationId, actor: reservationActor, reservationId: reservation.id, payload: { total_price: availableUnit.current_price, paid_amount: 50000 } });
    }
  }

  // --- Deals with commission snapshots ---
  const wonDeals = [
    { listing: listings[0], value: 2450000, percentage: 2, agent: org.agentOneMembership },
    { listing: listings[3], value: 165000, percentage: 5, agent: org.agentOneMembership, type: 'ready_rental' },
  ];
  for (const spec of wonDeals) {
    const deal = await createDeal({
      organizationId,
      actor,
      payload: {
        deal_type: spec.type ?? 'ready_sale',
        module: 'ready',
        listing_id: spec.listing.id,
        contact_id: createdLeads[0].contact_id,
        agent_membership_id: spec.agent,
        property_value: spec.value,
        commission_percentage: spec.percentage,
        currency: 'AED',
        contract_date: new Date(),
        parties: [],
      },
    });
    await changeStage({ organizationId, actor, id: deal.id, stage: 'documentation' });
    await changeStage({ organizationId, actor, id: deal.id, stage: 'signed' });
    await changeStage({ organizationId, actor, id: deal.id, stage: 'won', reason: 'Contract signed' });
  }

  if (reservation) {
    const offplanDeal = await createDeal({
      organizationId,
      actor,
      payload: {
        deal_type: 'offplan_sale',
        module: 'offplan',
        reservation_id: reservation.id,
        agent_membership_id: org.agentTwoMembership,
        commission_percentage: 4,
        currency: 'AED',
        parties: [],
      },
    });
    await changeStage({ organizationId, actor, id: offplanDeal.id, stage: 'documentation' });
  }

  return { listings, leads: createdLeads };
}

async function main() {
  const { isProduction, env } = loadServerConfig();
  if (isProduction) {
    console.error('Refusing to seed demo data: APP_ENV=production');
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const passwordHash = await hash();

  await withTransaction(db, async (trx) => {
    await ensurePlatformCatalogue(trx);
    await createUser(trx, {
      email: 'platform-admin@govyzer.local',
      firstName: 'Platform',
      lastName: 'Admin',
      passwordHash,
      isPlatformAdmin: true,
    });
  });

  const orgA = await seedOrganization(db, {
    name: 'Luxora Properties',
    slug: 'luxora-properties',
    prefix: 'LUX',
    modules: ['ready', 'offplan', 'sales_screen'],
    passwordHash,
    emailDomain: 'luxora.demo',
  });
  if (orgA) await seedBusinessData(db, orgA, { withOffplan: true });

  const orgB = await seedOrganization(db, {
    name: 'Skyline Realty',
    slug: 'skyline-realty',
    prefix: 'SKY',
    modules: ['ready'],
    passwordHash,
    emailDomain: 'skyline.demo',
  });
  if (orgB) await seedBusinessData(db, orgB, { withOffplan: false });

  // Drain the outbox so Sales Screen events, points and workflow runs exist too.
  for (let round = 0; round < 3; round += 1) {
    await processOutboxBatch({ limit: 200, budgetMs: 20_000 });
    await runJobBatch({ limit: 50, budgetMs: 20_000 });
  }

  console.log('\nDemo data ready (development only).\n');
  console.log('Platform administrator');
  console.log(`  platform-admin@govyzer.local / ${PASSWORD}\n`);
  for (const [label, org] of [
    ['Luxora Properties (Ready + Off-plan + Sales Screen)', orgA],
    ['Skyline Realty (Ready only)', orgB],
  ]) {
    if (!org) continue;
    console.log(label);
    console.log(`  workspace: ${org.organization.slug}`);
    for (const [role, user] of Object.entries(org.users)) {
      if (!user) continue;
      console.log(`  ${role.padEnd(12)} ${user.email} / ${PASSWORD}`);
    }
    console.log('');
  }
  console.log(`API: ${env.API_PUBLIC_URL}   CRM: ${env.CRM_PUBLIC_URL}   Sales Screen: ${env.SALES_SCREEN_PUBLIC_URL}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => destroyDb());

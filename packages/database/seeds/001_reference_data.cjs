'use strict';

/**
 * Platform reference data shared by every tenant: geography, amenities and the portal
 * catalogue. Safe to run repeatedly — every insert is keyed and skipped when present.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newId() {
  let out = '';
  const now = Date.now();
  let time = now;
  for (let index = 10; index > 0; index -= 1) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  for (let index = 0; index < 16; index += 1) {
    out += ENCODING[Math.floor(Math.random() * 32)];
  }
  return out;
}

const AE_COMMUNITIES = {
  Dubai: [
    ['Dubai Marina', ['Marina Gate', 'Marina Promenade', 'Dubai Marina Moon Tower']],
    ['Downtown Dubai', ['Burj Khalifa Area', 'Old Town', 'The Address Residences']],
    ['Business Bay', ['Executive Towers', 'Bay Square']],
    ['Jumeirah Village Circle', ['District 12', 'District 13']],
    ['Palm Jumeirah', ['Shoreline Apartments', 'Golden Mile']],
    ['Dubai Hills Estate', ['Park Ridge', 'Collective']],
    ['Arabian Ranches', ['Palmera', 'Al Reem']],
    ['Jumeirah Lake Towers', ['Cluster A', 'Cluster T']],
    ['Dubai Creek Harbour', ['Creek Beach', 'Harbour Views']],
    ['Emaar Beachfront', ['Beach Vista', 'Sunrise Bay']],
  ],
  'Abu Dhabi': [
    ['Al Reem Island', ['Marina Square', 'Shams Abu Dhabi']],
    ['Yas Island', ['Yas Acres', 'Water’s Edge']],
    ['Saadiyat Island', ['Saadiyat Beach', 'Mamsha Al Saadiyat']],
  ],
  Sharjah: [['Aljada', ['Sarab', 'Nest']], ['Al Mamsha', ['Retail District']]],
};

const AMENITIES = [
  ['balcony', 'Balcony', 'unit'],
  ['built_in_wardrobes', 'Built-in wardrobes', 'unit'],
  ['central_ac', 'Central A/C', 'unit'],
  ['maids_room', "Maid's room", 'unit'],
  ['study', 'Study', 'unit'],
  ['private_pool', 'Private pool', 'unit'],
  ['shared_pool', 'Shared pool', 'building'],
  ['shared_gym', 'Shared gym', 'building'],
  ['covered_parking', 'Covered parking', 'building'],
  ['security', '24h security', 'building'],
  ['concierge', 'Concierge', 'building'],
  ['children_play_area', "Children's play area", 'community'],
  ['pets_allowed', 'Pets allowed', 'building'],
  ['beach_access', 'Beach access', 'community'],
  ['metro_nearby', 'Metro nearby', 'community'],
  ['retail_nearby', 'Retail nearby', 'community'],
  ['view_of_water', 'Water view', 'unit'],
  ['view_of_landmark', 'Landmark view', 'unit'],
];

exports.seed = async function seed(knex) {
  // --- Countries ---
  const countries = [
    ['AE', 'ARE', 'United Arab Emirates', 'الإمارات العربية المتحدة', 'AED', 'Asia/Dubai', '+971', 'sqft'],
    ['SA', 'SAU', 'Saudi Arabia', 'المملكة العربية السعودية', 'SAR', 'Asia/Riyadh', '+966', 'sqm'],
    ['QA', 'QAT', 'Qatar', 'قطر', 'QAR', 'Asia/Qatar', '+974', 'sqm'],
    ['GB', 'GBR', 'United Kingdom', null, 'GBP', 'Europe/London', '+44', 'sqft'],
  ];
  for (const [iso2, iso3, name, nameAr, currency, timezone, phone, sizeUnit] of countries) {
    const exists = await knex('countries').where('iso2', iso2).first('id');
    if (exists) continue;
    await knex('countries').insert({
      id: newId(),
      iso2,
      iso3,
      name,
      name_ar: nameAr,
      default_currency: currency,
      default_timezone: timezone,
      phone_code: phone,
      size_unit: sizeUnit,
      is_active: iso2 === 'AE',
    });
  }

  const uae = await knex('countries').where('iso2', 'AE').first();

  // --- UAE cities, communities and subcommunities ---
  for (const [cityName, communities] of Object.entries(AE_COMMUNITIES)) {
    let city = await knex('cities').where({ country_id: uae.id, name: cityName, organization_id: '' }).first();
    if (!city) {
      const id = newId();
      await knex('cities').insert({ id, organization_id: '', country_id: uae.id, name: cityName });
      city = { id };
    }
    for (const [communityName, subcommunities] of communities) {
      let community = await knex('communities').where({ city_id: city.id, name: communityName, organization_id: '' }).first();
      if (!community) {
        const id = newId();
        await knex('communities').insert({
          id,
          organization_id: '',
          city_id: city.id,
          name: communityName,
          slug: communityName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        });
        community = { id };
      }
      for (const subName of subcommunities) {
        const exists = await knex('subcommunities').where({ community_id: community.id, name: subName }).first('id');
        if (exists) continue;
        await knex('subcommunities').insert({ id: newId(), organization_id: '', community_id: community.id, name: subName });
      }
    }
  }

  // --- Amenities ---
  for (const [code, name, category] of AMENITIES) {
    const exists = await knex('amenities').where({ organization_id: '', code }).first('id');
    if (exists) continue;
    await knex('amenities').insert({ id: newId(), organization_id: '', code, name, category });
  }

  // --- Report catalogue (system definitions) ---
  const reports = [
    ['lead_source_conversion', 'Lead source and conversion', 'leads'],
    ['lead_response_time', 'Lead response time', 'leads'],
    ['assignment_fairness', 'Assignment fairness', 'leads'],
    ['agent_performance', 'Agent performance', 'sales'],
    ['listings_by_status', 'Listings by status', 'ready'],
    ['listings_by_portal', 'Listings by portal', 'ready'],
    ['portal_errors', 'Portal errors', 'ready'],
    ['inventory_stock', 'Off-plan inventory and stock', 'offplan'],
    ['meetings_viewings', 'Meetings and viewings', 'activity'],
    ['reservations_bookings', 'Reservations and bookings', 'offplan'],
    ['revenue', 'Revenue', 'finance'],
    ['commission', 'Commission', 'finance'],
    ['ai_usage', 'AI usage', 'platform'],
    ['integration_health', 'Integration health', 'platform'],
    ['sales_points', 'Sales Screen points', 'sales_screen'],
  ];
  for (const [code, name, category] of reports) {
    const exists = await knex('report_definitions').where({ organization_id: '', code }).first('id');
    if (exists) continue;
    await knex('report_definitions').insert({
      id: newId(),
      organization_id: '',
      code,
      name,
      category,
      metrics: JSON.stringify([]),
      is_system: true,
    });
  }
};

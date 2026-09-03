/**
 * Structured matching runs first: hard filters remove anything that cannot satisfy the
 * requirement, then a transparent score ranks the survivors. AI ranking, when enabled,
 * only reorders this already-filtered set.
 */

function within(value, min, max) {
  if (value == null) return false;
  if (min != null && Number(value) < Number(min)) return false;
  if (max != null && Number(value) > Number(max)) return false;
  return true;
}

function overlaps(value, min, max, tolerance = 0) {
  if (value == null) return false;
  const numeric = Number(value);
  if (min != null && numeric < Number(min) * (1 - tolerance)) return false;
  if (max != null && numeric > Number(max) * (1 + tolerance)) return false;
  return true;
}

export function hardFilter(requirement, candidate) {
  const failures = [];
  if (requirement.property_types?.length && !requirement.property_types.includes(candidate.property_type)) {
    failures.push('property_type');
  }
  if (
    (requirement.bedrooms_min != null || requirement.bedrooms_max != null) &&
    !within(candidate.bedrooms, requirement.bedrooms_min, requirement.bedrooms_max)
  ) {
    failures.push('bedrooms');
  }
  if (
    (requirement.budget_min != null || requirement.budget_max != null) &&
    !overlaps(candidate.price, requirement.budget_min, requirement.budget_max, 0.1)
  ) {
    failures.push('budget');
  }
  if (
    (requirement.size_min != null || requirement.size_max != null) &&
    !overlaps(candidate.size, requirement.size_min, requirement.size_max, 0.1)
  ) {
    failures.push('size');
  }
  if (requirement.community_ids?.length && !requirement.community_ids.includes(candidate.community_id)) {
    failures.push('community');
  }
  if (requirement.handover_from || requirement.handover_to) {
    const handover = candidate.handover_date ? new Date(candidate.handover_date) : null;
    if (!handover) failures.push('handover');
    else {
      if (requirement.handover_from && handover < new Date(requirement.handover_from)) failures.push('handover');
      if (requirement.handover_to && handover > new Date(requirement.handover_to)) failures.push('handover');
    }
  }
  return failures;
}

export function scoreCandidate(requirement, candidate) {
  const reasons = [];
  let score = 0;

  if (requirement.budget_max != null && candidate.price != null) {
    const ratio = Number(candidate.price) / Number(requirement.budget_max);
    if (ratio <= 1) {
      score += 30;
      reasons.push('within_budget');
    } else if (ratio <= 1.1) {
      score += 18;
      reasons.push('slightly_over_budget');
    }
  }
  if (requirement.bedrooms_min != null && candidate.bedrooms === requirement.bedrooms_min) {
    score += 20;
    reasons.push('exact_bedrooms');
  }
  if (requirement.community_ids?.includes(candidate.community_id)) {
    score += 20;
    reasons.push('preferred_community');
  }
  if (requirement.views?.length && requirement.views.includes(candidate.view)) {
    score += 10;
    reasons.push('preferred_view');
  }
  const requestedAmenities = requirement.amenities ?? [];
  if (requestedAmenities.length > 0) {
    const available = candidate.amenities ?? [];
    const matched = requestedAmenities.filter((amenity) => available.includes(amenity));
    score += Math.round((matched.length / requestedAmenities.length) * 15);
    if (matched.length > 0) reasons.push(`amenities:${matched.length}/${requestedAmenities.length}`);
  }
  if (candidate.stock_status === 'available' || candidate.status === 'published') {
    score += 5;
    reasons.push('currently_available');
  }
  return { score, reasons };
}

export function matchCandidates(requirement, candidates, { limit = 20, includeRejected = false } = {}) {
  const results = [];
  const rejected = [];

  for (const candidate of candidates) {
    const failures = hardFilter(requirement, candidate);
    if (failures.length > 0) {
      if (includeRejected) rejected.push({ candidate, failures });
      continue;
    }
    const { score, reasons } = scoreCandidate(requirement, candidate);
    results.push({ ...candidate, match_score: score, match_reasons: reasons });
  }

  results.sort((a, b) => b.match_score - a.match_score || String(a.id).localeCompare(String(b.id)));
  return includeRejected ? { matches: results.slice(0, limit), rejected } : results.slice(0, limit);
}

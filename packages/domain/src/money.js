/**
 * All monetary maths runs on integer minor units so percentage splits never drift and a
 * distributed total always equals the source amount to the cent.
 */
const SCALE = 100;

export function toMinor(amount) {
  if (amount === null || amount === undefined || amount === '') return 0;
  const value = typeof amount === 'string' ? Number.parseFloat(amount) : Number(amount);
  if (!Number.isFinite(value)) throw new TypeError(`Invalid monetary amount: ${amount}`);
  return Math.round(value * SCALE);
}

export function fromMinor(minor) {
  return Math.round(minor) / SCALE;
}

export function percentageOfMinor(minor, percentage) {
  const pct = Number(percentage);
  if (!Number.isFinite(pct)) throw new TypeError(`Invalid percentage: ${percentage}`);
  return Math.round((minor * pct) / 100);
}

export function sumMinor(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Splits `minor` across `weights` using the largest-remainder method so the parts always
 * add up to the original amount.
 */
export function distributeMinor(minor, weights) {
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (minor * weight) / totalWeight);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = minor - floored.reduce((total, value) => total + value, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  for (let cursor = 0; remainder > 0 && cursor < order.length; cursor += 1, remainder -= 1) {
    floored[order[cursor].index] += 1;
  }
  return floored;
}

export function roundCurrency(amount) {
  return fromMinor(toMinor(amount));
}

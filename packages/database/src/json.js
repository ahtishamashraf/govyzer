/**
 * JSON column values do not arrive in the same shape on every supported server: MySQL 8
 * returns them already parsed, while MariaDB (whose JSON type is an alias for LONGTEXT)
 * returns them as text. Reading a column and writing it back therefore behaves differently
 * per server, and an array handed to the driver unparsed is expanded into one binding per
 * element, which fails the insert outright. Every read and write of a JSON column goes
 * through these helpers so the behaviour is identical on both.
 */

/** Reads a JSON column, accepting either the parsed value or its text form. */
export function fromJsonColumn(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Serializes a value for a JSON column. Strings are assumed to be JSON text already, which
 * is what a JSON column read returns on servers that hand back text.
 */
export function toJsonColumn(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Normalizes a value read from a JSON column back into storable JSON text. */
export function reserializeJsonColumn(value, fallback = null) {
  return toJsonColumn(fromJsonColumn(value, fallback));
}

import { describe, expect, it } from 'vitest';
import { fromJsonColumn, toJsonColumn, reserializeJsonColumn } from '@govyzer/database';

/**
 * MySQL 8 hands back JSON columns already parsed; MariaDB hands back text. Code that reads a
 * JSON column and writes the value somewhere else has to work on both, and an array reaching
 * the driver unparsed is expanded into one binding per element, which fails the insert. These
 * cover both server shapes so the difference cannot go unnoticed without a MySQL server.
 */
describe('JSON column helpers', () => {
  const rules = [{ position: 1, percentage: 50 }, { position: 2, percentage: 50 }];

  it('reads a column whether the server returns text or a parsed value', () => {
    expect(fromJsonColumn(JSON.stringify(rules), [])).toEqual(rules);
    expect(fromJsonColumn(rules, [])).toEqual(rules);
  });

  it('falls back for null and unparseable text rather than throwing', () => {
    expect(fromJsonColumn(null, [])).toEqual([]);
    expect(fromJsonColumn(undefined, {})).toEqual({});
    expect(fromJsonColumn('not json', null)).toBeNull();
  });

  it('serializes objects and arrays but leaves existing JSON text alone', () => {
    expect(toJsonColumn(rules)).toBe(JSON.stringify(rules));
    expect(toJsonColumn(JSON.stringify(rules))).toBe(JSON.stringify(rules));
    expect(toJsonColumn(null)).toBeNull();
    expect(toJsonColumn(undefined)).toBeUndefined();
  });

  it('re-serializes to identical text from either server shape, never to an array', () => {
    const fromMysql = reserializeJsonColumn(rules, []);
    const fromMariadb = reserializeJsonColumn(JSON.stringify(rules), []);
    expect(fromMysql).toBe(fromMariadb);
    expect(typeof fromMysql).toBe('string');
    expect(Array.isArray(fromMysql)).toBe(false);
    expect(JSON.parse(fromMysql)).toEqual(rules);
  });
});

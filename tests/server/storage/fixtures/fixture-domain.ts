import type { StorageDomainSchema } from '../../../../server/storage/contract.js';
import { defineStorageDomain, type StorageDomain } from '../../../../server/storage/domain.js';

/**
 * A test-only domain, bundled only into the fixture thread (fixture-thread.ts). It exercises the registry, receipts,
 * authority and failure paths the way a real schema owner will, and it carries a few fault commands that no
 * production domain has: `putThenDie` commits and then ends the thread before it answers, `exitNow` ends it inside
 * the transaction, `throwLater` throws outside any command, `spin` keeps the thread busy.
 */
export const fixtureSchema: StorageDomainSchema = {
  domain: 'fixture',
  migrations: [{ version: 1, sql: 'CREATE TABLE fixture_items (key TEXT PRIMARY KEY, value TEXT NOT NULL, parent TEXT REFERENCES fixture_items (key)) STRICT;' }],
  preparation: { requiredArtifactVersion: '0.0.0-fixture', readerContract: 1, writerContract: 1 },
  cutover: { artifactVersion: '0.0.0-fixture', importContract: 1 },
};
/** A domain without a cutover contract: it may not claim an import. */
export const plainSchema: StorageDomainSchema = {
  domain: 'plain',
  migrations: [{ version: 1, sql: 'CREATE TABLE plain_items (key TEXT PRIMARY KEY) STRICT;' }],
  preparation: { requiredArtifactVersion: '0.0.0-fixture', readerContract: 1, writerContract: 1 },
};

const record = (value: unknown) => value as Record<string, unknown>;
const spin = (ms: number) => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } };
export const fault = { dieBeforeAnswer: false };

export const fixtureDomain: StorageDomain = defineStorageDomain({
  schema: fixtureSchema,
  commands: {
    put: { kind: 'write', run(context, payload) {
      const { key, value, parent } = record(payload);
      context.prepare('INSERT INTO fixture_items (key, value, parent) VALUES (?, ?, ?)').run(String(key), String(value), parent === undefined ? null : String(parent));
      return { key };
    } },
    putMany: { kind: 'write', run(context, payload) {
      const { prefix, count } = record(payload);
      const insert = context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)');
      for (let index = 0; index < Number(count); index++) insert.run(`${prefix}-${index}`, 'x'.repeat(64));
      return { count };
    } },
    get: { kind: 'read', run(context, payload) {
      return context.prepare('SELECT key, value FROM fixture_items WHERE key = ?').get(String(record(payload).key)) ?? null;
    } },
    count: { kind: 'read', run(context) {
      return Number((context.prepare('SELECT count(*) AS n FROM fixture_items').get() as { n: number }).n);
    } },
    import: { kind: 'write', run(context, payload) { return context.authority.markImported({ manifestSha256: String(record(payload).manifestSha256) }); } },
    export: { kind: 'write', run(context, payload) { return context.authority.markLegacyExported({ manifestSha256: String(record(payload).manifestSha256) }); } },
    putThenDie: { kind: 'write', run(context, payload) {
      const { key } = record(payload);
      context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)').run(String(key), 'committed-before-exit');
      fault.dieBeforeAnswer = true;
      return { key };
    } },
    exitNow: { kind: 'write', run(context, payload) {
      context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)').run(String(record(payload).key), 'never-committed');
      process.exit(Number(record(payload).code ?? 3));
    } },
    throwLater: { kind: 'read', run() { setImmediate(() => { throw new Error('fixture boom'); }); return 'scheduled'; } },
    spin: { kind: 'read', run(_context, payload) { spin(Number(record(payload).ms)); return 'spun'; } },
    spinWrite: { kind: 'write', run(context, payload) {
      context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)').run(String(record(payload).key), 'slow');
      spin(Number(record(payload).ms));
      return 'spun';
    } },
    fail: { kind: 'write', run(context) {
      context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)').run('fail-row', 'rolled-back');
      throw new Error('fixture failure');
    } },
    later: { kind: 'read', run() { return Promise.resolve('async'); } },
    big: { kind: 'read', run(_context, payload) { return 'x'.repeat(Number(record(payload).bytes)); } },
    putLarge: { kind: 'write', run(context, payload) {
      const { key, bytes } = record(payload);
      context.prepare('INSERT INTO fixture_items (key, value) VALUES (?, ?)').run(String(key), 'large-answer');
      return 'x'.repeat(Number(bytes));
    } },
  },
});

/** Release A of the fixture domain: the same tables and reader/writer contracts, no cutover. It may not import. */
export const fixtureSchemaA: StorageDomainSchema = { domain: fixtureSchema.domain, migrations: fixtureSchema.migrations, preparation: fixtureSchema.preparation };
export const fixtureDomainA: StorageDomain = defineStorageDomain({ schema: fixtureSchemaA, commands: fixtureDomain.commands });

export const plainDomain: StorageDomain = defineStorageDomain({
  schema: plainSchema,
  commands: {
    import: { kind: 'write', run(context) { return context.authority.markImported({ manifestSha256: 'a'.repeat(64) }); } },
  },
});

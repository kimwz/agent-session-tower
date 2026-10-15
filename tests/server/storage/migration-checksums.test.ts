import assert from 'node:assert/strict';
import test from 'node:test';
import { migrationChecksum, migrationsOf, STORAGE_DOMAIN_SCHEMAS } from '../../../server/storage/schema.js';

/**
 * The checksum of every released migration, as v1.137.4 recorded them in schema_migrations (scope\nversion\nsql,
 * constants interpolated). A database whose rows differ is `unknown-schema`; so an edited migration locks every
 * existing storage out. A new migration is a new entry here, and with it a change of policy: existing stores are
 * never migrated (the worker opens with refuseBehind), so a new schema version needs that policy changed on purpose.
 */
const RELEASED: readonly (readonly [scope: string, version: number, checksum: string])[] = [
  ['core', 1, '42d97f18c93a5a4b58386a88ce44242dd74fbd011a6e56b66dd01e91b375e243'],
  ['retention', 1, '2244f4bac02bd6e5785b6c689162c680637166408d37b38950714a5e7baa99e5'],
  ['retention', 2, '1d4a9e1634399928ac97b5737c5c42e701b465d758745647f67ff5e8b7d4184f'],
  ['runs', 1, '47d2504db49344102181229020511b1b9dbb991c6b699b01d7d71d9faf0a3df5'],
  ['triggers', 1, '9f1f9ee41ca0998290c17efbf26719d3a31f40eca63ed273c1d9a75a098fd5ff'],
  ['permissions', 1, 'a099a98d927258be638634eab26c54c31c99a8744a4604dff912c3e2d32cf7f7'],
  ['remote', 1, '1bd73904b9b443600c90dbff16f718617a9b62e660dd0668f0803199c7e4319a'],
  ['auto-prompt', 1, 'd9eace47c811f5163968dcc952dfe553ba6014786a7f68ff3f35cc06ba7f0637'],
  ['automation-workflows', 1, '208f7b76a4cfb96a6072ce2ca1951d06b14db7f0518b5af1ef67c6a320dbefa7'],
];

test('every migration is byte-identical to the one released in v1.137.4, and none was added', () => {
  const actual = migrationsOf(STORAGE_DOMAIN_SCHEMAS).flatMap(({ scope, migrations }) => migrations.map(migration => [scope, migration.version, migrationChecksum(scope, migration)] as const));
  assert.deepEqual(actual, RELEASED);
});

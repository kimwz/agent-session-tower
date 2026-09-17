import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// @ts-expect-error plain .mjs script without type declarations
import { releaseNotes, withVersion } from '../scripts/release.mjs';
import { APP_VERSION } from '../shared/app-identity.ts';

const changelog = ['# Changelog', '', '## [1.1.0] - 2026-10-01', '', '### Added', '- Second thing', '', '## [1.0.0] - 2026-09-18', '', '- First thing', ''].join('\n');

test('release notes are the changelog section of exactly that version', () => {
  assert.equal(releaseNotes(changelog, '1.1.0'), '### Added\n- Second thing');
  assert.equal(releaseNotes(changelog, '1.0.0'), '- First thing');
});

test('a version without written notes cannot be released', () => {
  assert.equal(releaseNotes(changelog, '2.0.0'), undefined);
  assert.equal(releaseNotes('## [2.0.0] - 2027-01-01\n\n## [1.0.0] - 2026-09-18\n- First thing', '2.0.0'), undefined);
});

test('preparing a release rewrites only the reported app version', () => {
  const source = "export const APP_VERSION = '1.0.0';\nexport const APP_TITLE = 'Agent Session Tower';\n";
  assert.equal(withVersion(source, '1.2.3'), "export const APP_VERSION = '1.2.3';\nexport const APP_TITLE = 'Agent Session Tower';\n");
  assert.throws(() => withVersion('export const OTHER = 1;', '1.2.3'), /APP_VERSION/);
});

test('the current version already has release notes', async () => {
  const current = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.ok(releaseNotes(current, APP_VERSION), `CHANGELOG.md is missing notes for ${APP_VERSION}`);
});

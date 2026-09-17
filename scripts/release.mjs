// Release rules, enforced by `npm version <x>`:
//   - every version has a CHANGELOG.md section, which becomes the GitHub release notes
//   - shared/app-identity.ts reports the same version as package.json
// usage: node scripts/release.mjs prepare        (npm "version" hook: sync the version, require notes)
//        node scripts/release.mjs notes <x.y.z>  (print that version's release notes)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const VERSION_LINE = /^export const APP_VERSION = '[^']*';$/m;

/** The body of `## [version]` up to the next version heading; undefined if absent or empty. */
export function releaseNotes(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => line.startsWith('## ['));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim() || undefined;
}

export function withVersion(identitySource, version) {
  if (!VERSION_LINE.test(identitySource)) throw new Error('APP_VERSION line not found in shared/app-identity.ts');
  return identitySource.replace(VERSION_LINE, `export const APP_VERSION = '${version}';`);
}

async function main([command, requested]) {
  const changelog = await readFile(new URL('CHANGELOG.md', root), 'utf8');
  if (command === 'notes') {
    const notes = releaseNotes(changelog, requested?.replace(/^v/, ''));
    if (!notes) throw new Error(`CHANGELOG.md has no notes for ${requested}.`);
    console.log(notes);
    return;
  }
  if (command === 'prepare') {
    const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    if (!releaseNotes(changelog, version)) throw new Error(`Write the "## [${version}] - YYYY-MM-DD" section in CHANGELOG.md before releasing.`);
    const identity = new URL('shared/app-identity.ts', root);
    await writeFile(identity, withVersion(await readFile(identity, 'utf8'), version));
    return;
  }
  throw new Error('usage: release.mjs prepare | notes <version>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });

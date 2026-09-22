import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile, chmod, rename, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, 'dist', 'executable');
const outputDir = join(root, 'artifacts');
const output = join(outputDir, process.platform === 'win32' ? 'agent-session-tower.exe' : 'agent-session-tower');
const pendingOutput = join(staging, process.platform === 'win32' ? 'agent-session-tower.exe' : 'agent-session-tower');
if (Number(process.versions.node.split('.')[0]) < 26) throw new Error('Building the standalone executable requires Node.js 26 or newer. Running it needs no Node.js installation.');
await mkdir(staging, { recursive: true });
await mkdir(outputDir, { recursive: true });
const main = join(staging, 'monitor.mjs');
await build({
  entryPoints: [join(root, 'server/index.ts')], outfile: main, bundle: true, platform: 'node', format: 'esm', target: 'node26', sourcemap: false,
  // Bundled CommonJS dependencies still require Node built-ins inside the SEA.
  banner: { js: "import { createRequire as monitorCreateRequire } from 'node:module'; const require = monitorCreateRequire(import.meta.url);" },
  // Keep the single executable independent of optional native ws accelerators.
  define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
});

const assets = {};
async function collect(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collect(path, key);
    else if (entry.isFile()) assets[key] = path;
  }
}
await collect(join(root, 'dist/client'), 'web');

// PTY native bindings and their helper must be extracted to real paths at runtime.
// Include only this executable's platform/architecture, plus the unbundled JS loader.
const ptyRoot = join(root, 'node_modules/node-pty');
await collect(join(ptyRoot, 'lib'), 'pty/lib');
let ptyNative;
for (const candidate of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
  try { await access(join(ptyRoot, candidate, process.platform === 'win32' ? 'conpty.node' : 'pty.node')); ptyNative = candidate; break; }
  catch { /* A source build or a matching prebuild must exist. */ }
}
if (!ptyNative) throw new Error('node-pty native binding is missing. Rebuild node-pty before packaging.');
await collect(join(ptyRoot, ptyNative), `pty/${ptyNative}`);
const ptyManifest = join(staging, 'pty-manifest.json');
await writeFile(ptyManifest, JSON.stringify(Object.keys(assets).filter(key => key.startsWith('pty/')).map(key => key.slice(4))));
assets['pty/manifest.json'] = ptyManifest;

// The binary carries its licenses too, so it can be moved without companion files.
const nodePath = await realpath(process.execPath);
const nodeLicensePath = process.env.AGENT_MONITOR_NODE_LICENSE || resolve(dirname(nodePath), '../LICENSE');
let notices = `Agent Session Tower\n${await readFile(join(root, 'LICENSE'), 'utf8')}\n\nNode.js ${process.versions.node}\n${await readFile(nodeLicensePath, 'utf8')}\n`;
async function collectLicenses(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectLicenses(path);
    else if (entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name)) {
      notices += `\n\n${path.slice(root.length + 1)}\n${await readFile(path, 'utf8')}\n`;
    }
  }
}
await collectLicenses(join(root, 'node_modules'));
const noticesPath = join(staging, 'THIRD_PARTY_NOTICES.txt');
await writeFile(noticesPath, notices);
assets['web/THIRD_PARTY_NOTICES.txt'] = noticesPath;

const config = join(staging, 'sea-config.json');
await writeFile(config, JSON.stringify({ main, mainFormat: 'module', output: pendingOutput, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: 'none', assets }, null, 2));
execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit', cwd: root });
await chmod(pendingOutput, 0o755);
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', pendingOutput], { stdio: 'inherit' });
// Publish a complete signed binary without modifying the image of a running server.
await rename(pendingOutput, output);
const checksum = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${checksum}  ${output.split('/').at(-1)}\n`);
console.log(`\nStandalone ${process.platform}/${process.arch}: ${output}\nSHA-256: ${checksum}`);

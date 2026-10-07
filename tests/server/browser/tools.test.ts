import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserInstructions, parseBrowserServerArgs } from '../../../server/browser/server.js';
import { browserEnvironment, browserNote, browserTools, claudeInChromeManifests, type BrowserEnvironment } from '../../../server/browser/tools.js';

const entry = { command: '/node', args: ['/tower/index.js'] };
const env = (overrides: Partial<BrowserEnvironment> = {}): BrowserEnvironment => ({ playwright: true, claudeInChrome: false, ...overrides });
const names = (tools: ReturnType<typeof browserTools>) => Object.keys(tools.servers).sort();

test('every turn gets the light and general browsers from this build\'s own browser entry', () => {
  const tools = browserTools({ command: '/node', args: ['--import', 'tsx', '/tower/index.ts'] }, '/state', 'codex', false, env());
  assert.deepEqual(names(tools), ['browser', 'browser_light']);
  assert.deepEqual(tools.servers.browser_light, { command: '/node', args: ['--import', 'tsx', '/tower/browser/entry.ts', 'light', '/state'] });
  assert.deepEqual(browserTools(entry, '/state', 'codex', false, env()).servers.browser, { command: '/node', args: ['/tower/browser/entry.js', 'general', '/state'] });
  assert.equal(tools.claudeChrome, false);
});

test('Aside is the strong browser for both providers when installed; Claude in Chrome only for Claude and only without Aside', () => {
  const aside = env({ aside: '/usr/local/bin/aside', claudeInChrome: true });
  for (const provider of ['claude', 'codex'] as const) {
    const tools = browserTools(entry, '/state', provider, false, aside);
    assert.deepEqual(names(tools), ['browser', 'browser_light', 'browser_strong']);
    assert.deepEqual(tools.servers.browser_strong, { command: '/usr/local/bin/aside', args: ['mcp'] });
    assert.equal(tools.claudeChrome, false, 'Aside comes first');
    assert.deepEqual(tools.servers.browser.args.slice(-2), ['--strong', 'aside']);
  }
  const chrome = browserTools(entry, '/state', 'claude', false, env({ claudeInChrome: true }));
  assert.deepEqual([names(chrome), chrome.claudeChrome], [['browser', 'browser_light'], true]);
  assert.deepEqual(chrome.servers.browser_light.args.slice(-2), ['--strong', 'claude-in-chrome']);
  const codex = browserTools(entry, '/state', 'codex', false, env({ claudeInChrome: true }));
  assert.deepEqual([names(codex), codex.claudeChrome], [['browser', 'browser_light'], false]);
  assert.equal(codex.servers.browser.args.includes('--strong'), false);
});

test('a conversation holding outside content gets neither the saved logins nor the owner\'s real browser', () => {
  for (const environment of [env({ aside: '/bin/aside' }), env({ claudeInChrome: true })]) {
    const tools = browserTools(entry, '/state', 'claude', true, environment);
    assert.deepEqual([names(tools), tools.claudeChrome], [['browser', 'browser_light'], false]);
    assert.deepEqual(tools.servers.browser.args.slice(-1), ['--outside-content']);
    assert.deepEqual(tools.servers.browser_light.args.slice(-1), ['--outside-content'], 'both are kept from this computer\'s own addresses');
  }
});

test('a build that cannot run Playwright offers only an installed Aside', () => {
  assert.deepEqual(names(browserTools(entry, '/state', 'codex', false, env({ playwright: false }))), []);
  assert.deepEqual(names(browserTools(entry, '/state', 'codex', false, env({ playwright: false, aside: '/bin/aside' }))), ['browser_strong']);
});

test('the Claude in Chrome host is looked for where Claude Code installs it on macOS and Linux', () => {
  assert.ok(claudeInChromeManifests('/Users/me', 'darwin').includes('/Users/me/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json'));
  assert.ok(claudeInChromeManifests('/home/me', 'linux').includes('/home/me/.config/google-chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json'));
  assert.deepEqual(claudeInChromeManifests('C:\\me', 'win32'), []);
});

test('the tool server reads its tier, state folder and options strictly', () => {
  assert.deepEqual(parseBrowserServerArgs(['light', '/state']), { tier: 'light', stateDir: '/state', savedLogins: false, outsideContent: false });
  assert.deepEqual(parseBrowserServerArgs(['general', '/state']), { tier: 'general', stateDir: '/state', savedLogins: true, outsideContent: false });
  assert.deepEqual(parseBrowserServerArgs(['general', '/state', '--outside-content', '--strong', 'aside']), { tier: 'general', stateDir: '/state', savedLogins: false, outsideContent: true, strong: 'aside' });
  for (const bad of [['heavy', '/state'], ['light', 'relative'], ['light'], ['general', '/state', '--strong', 'firefox'], ['general', '/state', '--other']]) assert.throws(() => parseBrowserServerArgs(bad), JSON.stringify(bad));
});

test('instructions give each browser its uses and point to the strong browser the turn has', () => {
  const light = browserInstructions({ tier: 'light', stateDir: '/s', savedLogins: false, outsideContent: false }, '/out');
  assert.match(light, /localhost/);
  assert.match(light, /no logins/);
  assert.match(light, /under \/out/);
  const general = browserInstructions({ tier: 'general', stateDir: '/s', savedLogins: true, outsideContent: false }, '/out');
  assert.match(general, /kept for later turns/);
  assert.match(general, /vault/);
  assert.match(general, /no stronger browser on this computer/);
  assert.match(general, /Never try to solve CAPTCHAs/);
  assert.match(browserInstructions({ tier: 'general', stateDir: '/s', savedLogins: true, outsideContent: false, strong: 'aside' }, '/o'), /`browser_strong` tools \(Aside/);
  const chrome = browserInstructions({ tier: 'general', stateDir: '/s', savedLogins: false, outsideContent: true, strong: 'claude-in-chrome' }, '/o');
  assert.match(chrome, /`claude-in-chrome` tools/);
  assert.match(chrome, /tabs_close_mcp before you finish/);
  assert.match(chrome, /not kept in this conversation/);
  assert.match(chrome, /localhost\) are blocked here/);
  assert.doesNotMatch(general, /blocked here/);
  assert.match(browserInstructions({ tier: 'light', stateDir: '/s', savedLogins: false, outsideContent: false, strong: 'claude-in-chrome' }, '/o'), /tabs_close_mcp/, 'whichever browser the agent reads first');
});

test('every turn\'s Tower instructions name its browsers, so Codex reaches for them before computer use', () => {
  const plain = browserNote(browserTools(entry, '/state', 'codex', false, env()))!;
  assert.match(plain, /`browser_light` for pages this project serves/);
  assert.match(plain, /`browser` for outside sites/);
  assert.match(plain, /rather than computer use/);
  assert.doesNotMatch(plain, /browser_strong|claude-in-chrome/);
  assert.match(browserNote(browserTools(entry, '/state', 'codex', false, env({ aside: '/bin/aside' })))!, /`browser_strong` \(Aside/);
  assert.match(browserNote(browserTools(entry, '/state', 'claude', false, env({ claudeInChrome: true })))!, /`claude-in-chrome`.*close the tabs/);
  assert.doesNotMatch(browserNote(browserTools(entry, '/state', 'claude', true, env({ claudeInChrome: true })))!, /claude-in-chrome/, 'not for outside content');
  assert.equal(browserNote(browserTools(entry, '/state', 'codex', false, env({ playwright: false }))), undefined);
});

test('Aside is found on the PATH as an executable file, and Claude in Chrome by its native host file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tower-browser-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), home = join(root, 'home');
  await mkdir(bin, { recursive: true });
  assert.deepEqual([browserEnvironment({ PATH: bin }, home, 'darwin').aside, browserEnvironment({ PATH: bin }, home, 'darwin').claudeInChrome], [undefined, false]);
  await writeFile(join(bin, 'aside'), '#!/bin/sh\n');
  assert.equal(browserEnvironment({ PATH: bin }, home, 'darwin').aside, undefined, 'not executable');
  await chmod(join(bin, 'aside'), 0o755);
  assert.equal(browserEnvironment({ PATH: bin }, home, 'darwin').aside, join(bin, 'aside'));
  const manifest = claudeInChromeManifests(home, 'linux')[0];
  await mkdir(join(manifest, '..'), { recursive: true });
  await writeFile(manifest, '{}');
  assert.equal(browserEnvironment({ PATH: bin }, home, 'linux').claudeInChrome, true);
  assert.equal(browserEnvironment({ PATH: bin }, home, 'darwin').claudeInChrome, false, 'each system\'s own location');
});

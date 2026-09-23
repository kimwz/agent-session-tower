import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeUsage, parseCodexUsage, parseCodexModels, parseCodexConfig, readClaudeDefaultEffort, claudeStorage, readClaudeCredential, readClaudeUsage, readCodexCapabilities, ProviderCapabilities } from '../../../server/providers/capabilities.js';
import type { ProviderHealth } from '../../../shared/types.js';

const now = Date.parse('2026-09-15T00:00:00Z');
const reset = '2026-09-16T00:00:00.000Z';
const signal = () => new AbortController().signal;
const credential = { claudeAiOauth: { accessToken: 'private-access-token', refreshToken: 'private-refresh-token', scopes: ['user:profile'], expiresAt: Date.now() + 3600000 } };

test('quota parsers whitelist real windows and never infer primary means five hours', () => {
  const usage = parseCodexUsage({ accountId: 'private-account', rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300 } },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 }, secondary: null, credits: { balance: 'secret' } },
      another: { primary: { usedPercent: 99 } } } }, now);
  assert.deepEqual(usage, { status: 'available', windows: [{ id: 'primary', usedPercent: 62, windowMinutes: 10080, resetsAt: reset }], updatedAt: new Date(now).toISOString() });
  const claude = parseClaudeUsage({ five_hour: { utilization: 4.5, resets_at: reset }, seven_day: { utilization: 60, resets_at: reset },
    seven_day_sonnet: null, extra_usage: { used_credits: 'private' }, account_id: 'private' }, now);
  assert.deepEqual(claude.windows.map(window => [window.id, window.usedPercent, window.windowMinutes]), [['five_hour', 4.5, 300], ['seven_day', 60, 10080]]);
  assert.doesNotMatch(JSON.stringify([usage, claude]), /private|credits|another/);
});

test('unknown, invalid and expired quota is never fabricated as zero', () => {
  for (const value of [null, {}, { five_hour: { utilization: -1 } }, { five_hour: { utilization: 101 } }, { five_hour: { utilization: '0' } }]) {
    assert.equal(parseClaudeUsage(value, now).status, 'unavailable');
    assert.deepEqual(parseClaudeUsage(value, now).windows, []);
  }
  const expired = parseCodexUsage({ rateLimits: { primary: { usedPercent: 70, resetsAt: now / 1000 - 1 } } }, now);
  assert.equal(expired.status, 'unavailable'); assert.equal(expired.stale, true); assert.equal(expired.windows[0].usedPercent, 70);
  assert.equal(parseClaudeUsage({ five_hour: { utilization: 0, resets_at: reset } }, now).status, 'available');
});

test('Codex catalog keeps each model\'s advertised reasoning efforts and a default only when it is listed', () => {
  assert.deepEqual(parseCodexModels({ data: [
    { model: 'native-model', displayName: 'Native', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: '--config' }, 'high'] },
    { model: 'unlisted-default', displayName: 'Other', defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
  ] }), { models: [
    { id: 'native-model', label: 'Native', efforts: [{ id: 'low', description: 'Fast' }, { id: 'medium', description: 'Balanced' }], defaultEffort: 'medium' },
    { id: 'unlisted-default', label: 'Other', efforts: [{ id: 'high' }] },
  ] });
});

test('Codex catalog uses callable model slug and strips hidden models and private fields', () => {
  assert.deepEqual(parseCodexModels({ data: [{ id: 'opaque-id', model: 'native-model', displayName: 'Native Model', isDefault: true, accountId: 'secret' },
    { model: 'hidden', hidden: true }, { model: '--config' }, { model: 42 }] }), { models: [{ id: 'native-model', label: 'Native Model' }], defaultModel: 'native-model' });
});

test('Claude credential roots match native explicit storage override and keychain precedence', async () => {
  assert.deepEqual(claudeStorage({ USER: 'developer' }, '/home/developer'), { directory: '/home/developer/.claude', service: 'Claude Code-credentials', account: 'developer' });
  const regular = claudeStorage({ CLAUDE_CONFIG_DIR: '/custom/claude', USER: 'bad user' });
  assert.match(regular.service, /^Claude Code-credentials-[a-f0-9]{8}$/); assert.equal(regular.account, 'claude-code-user');
  assert.equal(claudeStorage({ CLAUDE_CONFIG_DIR: '/custom/claude', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/secure', USER: 'dev' }).directory, '/secure');
  let reads = 0;
  assert.deepEqual(await readClaudeCredential({ platform: 'darwin', signal: signal(), keychain: async () => '{}', readJson: async () => { reads++; return credential; } }), { reason: 'not_signed_in' });
  assert.equal(reads, 0);
  const found = await readClaudeCredential({ env: { CLAUDE_CONFIG_DIR: '/custom/claude' }, platform: 'linux', signal: signal(), readJson: async path => { assert.equal(path, '/custom/claude/.credentials.json'); return credential; } });
  assert.equal(found.token, 'private-access-token');
});

test('missing, malformed and expired credentials yield safe reasons without auth refresh', async () => {
  const read = (value: unknown) => readClaudeCredential({ platform: 'linux', signal: signal(), readJson: async () => value });
  assert.deepEqual(await read({}), { reason: 'not_signed_in' });
  assert.deepEqual(await read({ claudeAiOauth: { ...credential.claudeAiOauth, expiresAt: 1 } }), { reason: 'not_signed_in' });
  assert.deepEqual(await read({ claudeAiOauth: { ...credential.claudeAiOauth, scopes: [] } }), { reason: 'not_supported' });
  assert.deepEqual(await readClaudeCredential({ platform: 'linux', signal: signal(), readJson: async () => { throw Object.assign(new Error('secret path'), { code: 'ENOENT' }); } }), { reason: 'not_signed_in' });
  assert.deepEqual(await readClaudeCredential({ platform: 'darwin', signal: signal(), keychain: async () => '{private-bad-json', readJson: async () => credential }), { reason: 'credentials_unavailable' });
});

test('explicit Claude auth does not display quota from a different stored account', async () => {
  let reads = 0;
  const options = { platform: 'linux', signal: signal(), readJson: async () => { reads++; return credential; } };
  assert.deepEqual(await readClaudeCredential({ ...options, env: { CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token', CLAUDE_CODE_OAUTH_SCOPES: 'user:profile user:inference' } }), { token: 'explicit-oauth-token' });
  assert.deepEqual(await readClaudeCredential({ ...options, env: { CLAUDE_CODE_OAUTH_TOKEN: 'explicit-oauth-token' } }), { reason: 'not_supported' });
  for (const env of [{ ANTHROPIC_API_KEY: 'api-secret' }, { ANTHROPIC_AUTH_TOKEN: 'proxy-secret' }, { CLAUDE_CODE_USE_BEDROCK: '1' },
    { CLAUDE_CODE_USE_VERTEX: 'true' }, { ANTHROPIC_BASE_URL: 'https://proxy.example' }, { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '4' }, { CLAUDE_CODE_SIMPLE: '1' }]) {
    assert.deepEqual(await readClaudeCredential({ ...options, env }), { reason: 'not_supported' });
  }
  assert.equal(reads, 0);
});

test('Claude sends credentials only to official HTTPS endpoint and sanitizes HTTP failures', async () => {
  const request = async (status: number) => readClaudeUsage({ platform: 'linux', signal: signal(), readJson: async () => credential, fetch: (async (url, init) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage'); assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer private-access-token');
    return new Response(status === 200 ? JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600000).toISOString() }, accessToken: 'private' }) : 'private body accessToken', { status });
  }) as typeof fetch });
  assert.equal((await request(200)).windows[0].usedPercent, 12);
  for (const [status, reason] of [[401, 'not_signed_in'], [403, 'not_supported'], [429, 'rate_limited'], [500, 'unreachable']] as const) {
    assert.equal((await request(status)).reason, reason); assert.doesNotMatch(JSON.stringify(await request(status)), /private/);
  }
});

test('native default efforts come only from Claude Code\'s override or settings and Codex\'s effective config', async () => {
  const settings = (value: unknown) => async () => value;
  assert.equal(await readClaudeDefaultEffort({ CLAUDE_CONFIG_DIR: '/fixture' }, settings({ effortLevel: 'xhigh', apiKeyHelper: 'private' })), 'xhigh');
  assert.equal(await readClaudeDefaultEffort({ CLAUDE_CODE_EFFORT_LEVEL: 'low' }, settings({ effortLevel: 'max' })), 'low');
  assert.equal(await readClaudeDefaultEffort({ CLAUDE_CODE_EFFORT_LEVEL: 'auto' }, settings({ effortLevel: 'max' })), undefined);
  assert.equal(await readClaudeDefaultEffort({}, settings({ effortLevel: '--flag' })), undefined);
  assert.equal(await readClaudeDefaultEffort({}, async () => { throw new Error('missing'); }), undefined);
  assert.deepEqual(parseCodexConfig({ config: { model: 'native-model', model_reasoning_effort: 'high', api_key: 'secret' } }), { defaultModel: 'native-model', defaultEffort: 'high' });
  assert.deepEqual(parseCodexConfig({ config: { model: '--config', model_reasoning_effort: null } }), {});
});

test('read-only Codex app-server enumerates quota and paginated catalog, then exits without thread calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-capabilities-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'codex');
  const recorded = join(directory, 'methods.jsonl');
  await writeFile(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); appendFileSync(process.env.RECORDED, JSON.stringify({method:r.method,params:r.params})+'\\n');
  if(r.method==='initialized') return;
  const result=r.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:19,windowDurationMins:10080}}}:r.method==='config/read'?{config:{model:'second',model_reasoning_effort:'high',api_key:'private'}}:r.method==='model/list'?{data:[{model:r.params.cursor?'second':'first',displayName:'Native',isDefault:!r.params.cursor}],nextCursor:r.params.cursor?null:'next'}:{};
  process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});
`);
  await chmod(executable, 0o700);
  const capabilities = await readCodexCapabilities(executable, { ...process.env, RECORDED: recorded }, signal());
  assert.equal(capabilities.usage?.windows[0].windowMinutes, 10080);
  assert.deepEqual(capabilities.models?.map(model => model.id), ['first', 'second']);
  assert.equal(capabilities.defaultModel, 'second', 'the configured model wins over the catalog default');
  assert.equal(capabilities.defaultEffort, 'high');
  assert.doesNotMatch(JSON.stringify(capabilities), /private/);
  const requests = (await readFile(recorded, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'initialized', 'account/rateLimits/read', 'model/list', 'model/list', 'config/read']);
});

test('aborting an unresponsive Codex reader force-kills its child even when SIGTERM is ignored', { timeout: 6000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-capability-abort-'));
  const executable = join(directory, 'codex');
  const pidFile = join(directory, 'pid');
  let pid: number | undefined;
  t.after(async () => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ } } await rm(directory, { recursive: true, force: true }); });
  await writeFile(executable, `#!${process.execPath}
import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>{}); process.stdin.resume();
writeFileSync(process.env.PID_FILE,String(process.pid));
setInterval(()=>{},1000);
`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const pending = readCodexCapabilities(executable, { ...process.env, PID_FILE: pidFile }, controller.signal);
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(pid);
  const at = Date.now(); controller.abort();
  const result = await pending;
  assert.equal(result.usage?.status, 'error'); assert.equal(result.usage?.reason, 'unreachable');
  assert.ok(Date.now() - at < 3500);
  assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  pid = undefined;
});

test('capability cache shares in-flight reads and retains explicitly stale observations on failure', async t => {
  const initial: ProviderHealth[] = [{ provider: 'codex', available: true, executable: '/fixture/codex', sessionCount: 0 }];
  let reads = 0;
  let release: (() => void) | undefined;
  let failing = false;
  let updates = 0;
  const cache = new ProviderCapabilities(initial, { health: async () => initial, onChange: () => { updates++; }, read: async () => {
    reads++;
    if (failing) throw new Error('secret raw failure');
    await new Promise<void>(resolve => { release = resolve; });
    return { usage: parseCodexUsage({ rateLimits: { primary: { usedPercent: 45 } } }), models: [{ id: 'native', label: 'Native' }] };
  } });
  t.after(() => cache.stop());
  assert.equal(cache.list()[0].usage?.status, 'loading');
  const first = cache.refresh(); assert.equal(cache.refresh(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1); release!(); await first;
  failing = true; await cache.refresh();
  const result = cache.list()[0];
  assert.equal(result.usage?.status, 'error'); assert.equal(result.usage?.stale, true); assert.equal(result.usage?.windows[0].usedPercent, 45);
  assert.deepEqual(result.models, [{ id: 'native', label: 'Native' }]); assert.equal(updates, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('stopping the capability cache aborts a pending provider read and prevents updates', async () => {
  const initial: ProviderHealth[] = [{ provider: 'codex', available: true, executable: '/fixture/codex', sessionCount: 0 }];
  let aborted = false;
  let updates = 0;
  const cache = new ProviderCapabilities(initial, { health: async () => initial, onChange: () => { updates++; }, read: async (_provider, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return {};
  } });
  cache.start(); await new Promise(resolve => setImmediate(resolve)); await cache.stop();
  assert.equal(aborted, true); assert.equal(updates, 0);
});

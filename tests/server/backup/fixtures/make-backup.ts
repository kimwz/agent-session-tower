/**
 * Makes a fixture backup with the code of one released Tower, so the backups the owner already holds stay readable.
 * Run against a checkout of that release (`git archive vX.Y.Z server shared package.json tsconfig.json`, with this
 * repository's node_modules linked in), never against personal state:
 *
 *   node --import tsx tests/server/backup/fixtures/make-backup.ts <release tree> <plain|vault|once> <out prefix>
 *
 * It writes `<out>.towerbackup` (what the release exported), `<out>.payload.json` (that file decrypted by the same
 * release) and `<out>.state.json` (the state folder the release backed up, see state.ts). Values and passwords are the
 * fixed test ones below.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotState } from './state.ts';

export const FIXTURE_PASSPHRASE = 'fixture backup passphrase';
export const FIXTURE_VAULT_PASSWORD = 'fixture vault password 1';

const [tree, scenario, out] = process.argv.slice(2);
if (!tree || !['plain', 'vault', 'once'].includes(scenario) || !out) throw new Error('usage: make-backup.ts <release tree> <plain|vault|once> <out prefix>');
const load = async <T>(path: string): Promise<T> => import(pathToFileURL(resolve(tree, path)).href) as Promise<T>;
const version = JSON.parse(await (await import('node:fs/promises')).readFile(join(tree, 'package.json'), 'utf8')).version as string;

const { BackupService } = await load<any>('server/backup/service.ts');
const { decryptBackup } = await load<any>('server/backup/crypto.ts');
const { TriggerService } = await load<any>('server/triggers/service.ts');
const { SecretStore } = await load<any>('server/triggers/secrets.ts');
const { PublicAgentService } = await load<any>('server/public-agents/service.ts');
const { ProjectGroupStore } = await load<any>('server/stores/project-groups.ts');
const { RemoteExclusionStore } = await load<any>('server/remote/exclusions.ts');
const { DecisionService } = await load<any>('server/decisions/service.ts');

const root = await mkdtemp(join(tmpdir(), 'tower-backup-fixture-'));
try {
  const stateDir = join(root, 'state'), project = join(root, 'project');
  await mkdir(stateDir, { recursive: true }); await mkdir(project);
  const write = (name: string, value: unknown) => mkdir(join(stateDir, name, '..'), { recursive: true }).then(() => writeFile(join(stateDir, name), JSON.stringify(value), { mode: 0o600 }));
  const OWNER = { kind: 'owner', via: 'ui' };
  const clock = { now: Date.parse('2026-09-24T00:00:30.000Z') };

  // Worker settings files, each with the runtime records a backup must leave out.
  const RULE = { id: 'rule', name: 'Rule', enabled: true, condition: 'Asked', instructions: 'Answer', replyInstructions: 'Reply', provider: 'codex' };
  await write('permissions.json', { version: 1, rules: [{ id: 'r1', tool: 'Bash', pattern: 'npm test' }], requests: [{ id: 'local-request' }], codex: [{ path: '/fixture/codex.rules' }], lost: 'fixture lost note', autoReview: { enabled: true, provider: 'claude', model: 'opus', resume: true } });
  await write('slack-connection.json', { enabled: true, userToken: 'xoxp-fixture', appToken: 'xapp-fixture', account: { teamId: 'TFIX', userId: 'UFIX' } });
  await write('slack-tone.json', { tone: 'Short and friendly.' });
  await write('slack-automation.json', { rules: [RULE], workflows: [{ id: 'local-work', status: 'completed' }] });
  await write('github-automation.json', { rules: [{ ...RULE, id: 'github-rule' }], workflows: [{ id: 'github-work', status: 'completed' }] });
  if (version !== '1.92.0') {
    const { saveModelSettings } = await load<any>('server/models/settings.ts');
    const { initialModelSettings } = await load<any>('shared/models.ts');
    const settings = initialModelSettings();
    settings.roles['slack.match'] = { provider: 'codex', claude: {}, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
    await saveModelSettings(stateDir, settings);
  }
  const agents = new PublicAgentService({ stateDir, runs: { list: () => [], create: async () => { throw new Error('Fixture agents never run.'); } }, model: async () => ({}) });
  await agents.start();
  await agents.mutate('create', { agent: { name: 'Content desk', description: 'Ask for new posts.', scope: 'Only publish new blog posts about tea.', workInstructions: 'Use content/posts.', cwd: project,
    provider: 'claude', intakeProvider: 'claude', conversation: 'visitor', enabled: true }, password: 'fixture agent password' });
  agents.close(); await agents.flush();

  // Triggers through the release's own engine.
  let vault: any;
  if (scenario === 'vault') {
    const { SecretService } = await load<any>('server/secrets/service.ts');
    vault = new SecretService({ stateDir });
    await vault.start(); await vault.initialize(FIXTURE_VAULT_PASSWORD);
    const bound = await vault.project({ name: 'fixture', bindings: [{ hostId: vault.device().id, root: project }] });
    await vault.create({ name: 'deploy-token', kind: 'scalar', scope: 'project', projectId: bound.id, value: 'FIXTURE_PERMANENT_VALUE' });
  }
  const runs: any[] = [];
  const executor = {
    submitAutoPrompt: async () => { throw new Error('Fixture triggers do not route.'); }, getAutoPrompt: () => undefined,
    create: async (input: any, internal: any) => { const run = { id: `run-${runs.length + 1}`, sessionId: `${input.provider}:fixture-${runs.length + 1}`, prompt: input.prompt, status: 'running', createdAt: new Date(clock.now).toISOString(), output: '', origin: internal.origin };
      runs.push(run); return { run, session: { id: run.sessionId, nativeId: 'n', provider: input.provider, title: '', cwd: project, project: 'project', status: 'idle', statusReason: '', createdAt: '', updatedAt: '', lastMessage: '', messageCount: 0, isSubagent: false, resumable: true } }; },
    enqueue: async () => { throw new Error('Fixture triggers start new sessions.'); },
    runs: () => structuredClone(runs), session: () => undefined,
  };
  const triggers = new TriggerService({ stateDir, executor, now: () => clock.now, tickMs: 60_000, ...(vault ? { secretStore: new SecretStore(stateDir, { vault }) } : {}) });
  await triggers.start();
  await triggers.updateSettings({ maxConcurrentRuns: 2 }, OWNER);
  const task = (name: string) => ({ kind: 'task', instructions: `${name} instructions`, provider: 'codex', approvals: 'auto', target: { node: 'local', mode: 'folder', cwd: project } });
  const policy = { overlap: 'skip', maxEventsPerHour: 20 };
  const hourly = (name: string, enabled = true) => ({ name, enabled, source: { kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, catchUp: 'latest' }, handler: task(name), policy });
  await triggers.create(hourly('Hourly report'), OWNER);
  if (scenario === 'plain' || scenario === 'vault') {
    const secret = await triggers.createSecret({ name: 'Status token', origin: 'https://status.example.com', value: 'Bearer FIXTURE_LEGACY_VALUE' }, OWNER);
    await triggers.create({ name: 'Status', enabled: true,
      source: { kind: 'http', schedule: { type: 'interval', everySeconds: 300 }, request: { method: 'GET', url: 'https://status.example.com/', headers: [{ name: 'authorization', secretId: secret.id }], timeoutSeconds: 5 }, condition: { type: 'every-success' } },
      handler: task('Status'), policy }, OWNER);
  }
  if (scenario === 'once') {
    const once = (name: string, at: string) => ({ ...hourly(name), source: { kind: 'schedule', schedule: { type: 'once', at }, catchUp: 'latest' } });
    await triggers.create(once('Pending reservation', '2026-12-01T09:00:00Z'), OWNER);
    const used = await triggers.create(once('Used reservation', '2026-09-24T01:00:00Z'), OWNER);
    await triggers.run(used.id, OWNER); await triggers.tick();
    for (const run of runs) run.status = 'completed';
    await triggers.tick();
    const recurring = await triggers.create(hourly('Old weekly digest', false), OWNER);
    await triggers.setArchived(recurring.id, true, recurring.revision, OWNER);
  }
  triggers.close(); await triggers.settle();

  const groups = new ProjectGroupStore(stateDir), exclusions = new RemoteExclusionStore(stateDir), decisions = new DecisionService(stateDir);
  await groups.start(); await exclusions.start(); await decisions.start();
  await groups.set({ cwd: project, title: 'Fixture project', pinned: true });
  await exclusions.add('/fixture/private');
  const skills = { bundle: { format: 'agent-session-tower.skills', version: 1, exportedAt: '', from: 'fixture', skills: [] }, guidance: 'Be brief.', settings: { enabled: true, provider: 'claude' } };
  const backup = new BackupService({ stateDir, version, skills: async () => structuredClone(skills), restartWorker: async () => true, stores: { groups, exclusions, decisions }, master: async () => {}, host: 'fixture' });
  await backup.start();
  const file = await backup.export(FIXTURE_PASSPHRASE);
  const { payload } = await decryptBackup(file.text, FIXTURE_PASSPHRASE);
  await writeFile(`${out}.towerbackup`, file.text);
  await writeFile(`${out}.payload.json`, `${JSON.stringify(payload, null, 2)}\n`);
  await backup.flush?.();
  await writeFile(`${out}.state.json`, `${JSON.stringify(await snapshotState(stateDir), null, 1)}\n`);
  console.log(JSON.stringify({ version, scenario, out, name: file.name }));
} finally {
  await rm(root, { recursive: true, force: true });
}

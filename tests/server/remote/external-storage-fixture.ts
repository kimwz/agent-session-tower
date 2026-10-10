import { TriggersRepository } from '../../../server/triggers/storage-repository.js';
import { triggerBackupOf } from '../../../server/triggers/backup.js';
import { serializeState, type EngineState } from '../../../server/triggers/state.js';
import { slackRequestId, workflowRows } from '../../../server/slack/storage-codec.js';
import { randomUUID } from 'node:crypto';
import { PermissionsRepository } from '../../../server/permissions/storage-repository.js';
import { permissionRows, type PermissionChange } from '../../../server/permissions/storage-codec.js';
import { permissionsBackupOf, mergePermissions } from '../../../server/permissions/backup.js';
import type { PermissionState } from '../../../server/permissions/service.js';
import { collectAutomationSettings, restoreAutomationSettings, guardSlackConnectionRestore } from '../../../server/slack/backup.js';
import type { WorkerSqlFile, WorkerSqlSettings, WorkerSettingsOwner } from '../../../server/backup/payload.js';
import { after, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retentionBuild } from '../storage/fixtures/retention-build.js';
import { RemoteRepository } from '../../../server/remote/storage-repository.js';
import { AutoPromptRepository } from '../../../server/auto-prompt/storage-repository.js';
import { WorkflowRepository } from '../../../server/slack/storage-repository.js';
import { importRemote } from '../../../server/remote/storage-transfer.js';
import { importAutoPrompts } from '../../../server/auto-prompt/storage-transfer.js';
import { importWorkflows } from '../../../server/slack/storage-transfer.js';
/** Existing actual SDK/artifact fixture, extended with the three owner registries. No second harness. */
let build: ReturnType<typeof retentionBuild> | undefined;
let buildDirectory: string | undefined;
after(async()=> { if(buildDirectory) await rm(buildDirectory,{recursive:true,force:true}); });
async function artifact() {
 if(!build) build=(async()=> {buildDirectory=await realpath(await mkdtemp(join(tmpdir(),'tower-external-artifact-')));return retentionBuild('1.125.0',buildDirectory,true,true,true);})();return build;
}
export async function externalStorageFixture(t:TestContext | undefined,stateDir:string,importDomains=true,fault='normal',registerClose=true) {
 if(registerClose && !t) throw new Error('Fixture close owner is required.');
 await mkdir(stateDir,{recursive:true,mode:0o700}); stateDir = await realpath(stateDir);
 const captured=await artifact(),storage=await captured.storage.openStorage({stateDir,bundle:captured.bundle(fault)});
 if(registerClose) t!.after(()=>storage.close());
 await storage.prepare({allowMigration:true});
 const remote=new RemoteRepository(storage),autoPrompt=new AutoPromptRepository(storage),workflows=new WorkflowRepository(storage);
 const checkActivation=async()=> {
  // The fixture invokes domain import directly; it is not a replacement for C's product offline owner checker.
  if(storage.context?.manifest.digest!==captured.manifest.digest||storage.context.identity.appVersion!=='1.125.0') throw new Error('External fixture identity mismatch.');
  for(const scope of ['core','remote','auto-prompt','automation-workflows']) if(!(await storage.gate(scope)).open) throw new Error('Fixture actual SDK gate closed.');
 };
 if(importDomains) for(const [repository,importer] of [[remote,importRemote],[autoPrompt,importAutoPrompts],[workflows,importWorkflows]] as const) {
  if(!(await repository.head()).authority) await importer({repository,stateDir,evidenceParent:join(stateDir,`${repository.codec.scope}-storage-migrations`),commandId:`fixture-${repository.codec.scope}`,checkActivation});
 }
 return {storage,remote,autoPrompt,workflows,captured,checkActivation,effectGate:checkActivation};
}

/** Fixture setup/probes use owner commands; stale runtime JSON is never an observation API. */
export async function readAutoPromptFixture(repository:AutoPromptRepository):Promise<string> {
 return JSON.stringify((await repository.load()).map(({entry})=>entry));
}
export async function writeAutoPromptFixture(repository:AutoPromptRepository,json:string):Promise<void> {
 const {autoPromptRows}=await import('../../../server/auto-prompt/storage-codec.js');
 const current=await repository.loadRows(),next=autoPromptRows(JSON.parse(json));
 const changes=next.map(row=>({...row,previous:current.find(old=>old.id===row.id)?.json??null}));
 for(const old of current) if(!next.some(row=>row.id===old.id)) changes.push({...old,previous:old.json,remove:true} as typeof changes[number]);
 await repository.update(changes);
}
export async function readWorkflowFixture(repository:WorkflowRepository,channel:'slack'|'github'='slack'):Promise<string> {
 return JSON.stringify(repository.source(await repository.loadRows(),channel));
}
export async function writeWorkflowFixture(repository:WorkflowRepository,json:string,channel:'slack'|'github'='slack'):Promise<void> {
 const {workflowRows}=await import('../../../server/slack/storage-codec.js');
 const current=(await repository.loadRows()).filter(row=>row.channel===channel),next=workflowRows(JSON.parse(json),channel);
 const changes=next.map(row=>({...row,previous:current.find(old=>old.id===row.id&&old.kind===row.kind)?.json??null}));
 for(const old of current) if(!next.some(row=>row.id===old.id&&row.kind===old.kind)) changes.push({...old,previous:old.json,remove:true} as typeof changes[number]);
 await repository.update(changes);
}

/** Public backup tests share this fixture's single SDK and the actual settings owners. */
const settingsOwners = new Map<string, Promise<Awaited<ReturnType<typeof openSettingsOwner>>>>();
export function workerSettingsFixture(stateDir: string) {
 let owner = settingsOwners.get(stateDir);
 if (!owner) {
  owner = openSettingsOwner(stateDir);
  settingsOwners.set(stateDir, owner);
 }
 return owner;
}
async function openSettingsOwner(stateDir: string) {
 const f = await externalStorageFixture(undefined, stateDir, false, 'normal', false);
 const permissions = new PermissionsRepository(f.storage, stateDir), triggers = new TriggersRepository(f.storage);
 try {
  if (!(await permissions.head()).authority) await permissions.importPrepared({ version: 1, rules: [], requests: [], codex: [] }, 'a'.repeat(64), 'backup-fixture-permissions', f.checkActivation);
  if (!(await f.workflows.head()).authority) await f.workflows.importPrepared(['slack', 'github'].flatMap(channel => workflowRows({ rules: [], workflows: [] }, channel as 'slack' | 'github')), 'b'.repeat(64), 'backup-fixture-workflows', f.checkActivation);
 } catch (error) { await f.storage.close(); throw error; }
 const collect = async (): Promise<WorkerSqlSettings> => ({
  'permissions.json': permissionsBackupOf(await permissions.load() as unknown as Record<string, unknown>),
  'slack-automation.json': await collectAutomationSettings(f.workflows, 'slack'),
  'github-automation.json': await collectAutomationSettings(f.workflows, 'github'),
 });
 const owner: WorkerSettingsOwner = {
  restore: async (name, incoming) => {
   if (name !== 'permissions.json') return restoreAutomationSettings(f.workflows, name === 'slack-automation.json' ? 'slack' : 'github', incoming);
   const merged = mergePermissions(incoming, await permissions.load());
   if (!merged) throw new Error('Invalid permissions backup.');
   const settings = { version: 1, rules: merged.rules, requests: [], codex: [], ...(merged.autoReview ? { autoReview: merged.autoReview } : {}) } as PermissionState;
   permissionRows(settings);
   await permissions.restore(settings, (await permissions.head()).authority!.generation, `backup-fixture-restore-${randomUUID()}`);
  },
  guardSlackConnection: (existing, incoming) => guardSlackConnectionRestore(f.workflows, existing, incoming),
 };
 const seed = async (name: WorkerSqlFile, value: unknown) => {
  if (name !== 'permissions.json') return writeWorkflowFixture(f.workflows, JSON.stringify(value), name === 'slack-automation.json' ? 'slack' : 'github');
  const current = permissionRows(await permissions.load()), next = permissionRows(value);
  const changes: PermissionChange[] = next.map(row => ({ ...row, previous: current.find(old => old.kind === row.kind && old.id === row.id)?.json ?? null }));
  for (const old of current) if (!next.some(row => row.kind === old.kind && row.id === old.id)) changes.push({ ...old, previous: old.json, remove: true });
  await permissions.update(changes);
 };
 const read = async (name: WorkerSqlFile) => name === 'permissions.json' ? permissions.load() : f.workflows.source(await f.workflows.loadRows(), name === 'slack-automation.json' ? 'slack' : 'github');
 const beforeClose: Array<() => Promise<void>> = [];
 const seedTriggers = async (state: EngineState) => {
  if (!await triggers.databaseAuthority()) await triggers.importPrepared(state, 'c'.repeat(64), 'backup-fixture-triggers', f.checkActivation);
  else await triggers.restore(state, `backup-fixture-triggers-${randomUUID()}`);
 };
 const triggerState = async () => (await triggers.exportCurrent()).documents;
 const triggersBackup = async () => await triggers.databaseAuthority() ? triggerBackupOf(JSON.parse(serializeState(await triggerState()))) : undefined;
 return { ...f, permissions, triggers, seedTriggers, triggerState, triggersBackup, beforeClose, collect, owner, seed, read, close: async (): Promise<void> => { try { for (const settle of beforeClose) await settle(); } finally { await f.storage.close(); } settingsOwners.delete(stateDir); } };
}

export const backupPermissionRule = (id: string) => ({ id, kind: 'command' as const, value: 'git status', providers: ['claude' as const], scope: 'project' as const, cwd: '/fixture', source: 'owner' as const, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
export const backupPermissionRequest = (id: string) => ({ id, status: 'pending' as const, sessionId: 'fixture-session', cwd: '/fixture', provider: 'claude' as const, createdAt: '2026-10-10T00:00:00.000Z', reason: 'Fixture pending approval', rule: { kind: 'command' as const, value: 'git status', providers: ['claude' as const], scope: 'project' as const, cwd: '/fixture' } });
export const backupWorkflow = (key: string, status: import('../../../shared/slack.js').SlackWorkflow['status'] = 'running', teamId = 'T') => {
 const mention = { id: key, teamId, channel: 'C', user: 'U', ts: '1.0', threadTs: '1.0', text: 'Fixture mention' };
 return { id: slackRequestId(mention), mention, status, rules: [], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
};
export async function closeWorkerSettingsFixture(stateDir: string): Promise<void> {
 const owner = settingsOwners.get(stateDir);
 if (owner) await (await owner).close();
}

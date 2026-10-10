import { createHash } from 'node:crypto';
import { MAX_REVIEWED_FILES, MAX_REVIEW_REASON, MAX_RUN_SECONDS, ruleProblem, type PermissionRuleInput } from '../../shared/permissions.js';
import type { PermissionState } from './service.js';

export const PERMISSION_BYTES = 4_000_000;
export const PERMISSION_CHUNK_BYTES = 64 * 1024;
export type PermissionRowKind = 'rule' | 'request' | 'codex' | 'meta';
export interface PermissionRow { kind: PermissionRowKind; id: string; ordinal: number; json: string }
export interface PermissionChange extends PermissionRow { previous: string | null; remove?: true }
export const permissionHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const permissionJson = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || Buffer.byteLength(json) > PERMISSION_BYTES) throw new Error('Permission JSON exceeds its bounded allowance.');
  return json;
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Malformed permission object.');
  return v as Record<string, unknown>;
};
const string = (v: unknown, max = PERMISSION_BYTES): void => { if (typeof v !== 'string' || !v.length || v.length > max) throw new Error('Malformed permission string.'); };
const time = (v: unknown): void => { string(v,40); if (!Number.isFinite(Date.parse(v as string))) throw new Error('Malformed permission time.'); };
const optional = (v: unknown, check: (v: unknown) => void): void => { if (v !== undefined) check(v); };
const choice = (v: unknown, values: string[]): void => { if (!values.includes(String(v))) throw new Error('Malformed permission enum.'); };
const bool = (v: unknown): void => { if (typeof v !== 'boolean') throw new Error('Malformed permission boolean.'); };
const integer = (v: unknown): void => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error('Malformed permission count.'); };
function rule(v: unknown, run: boolean): void {
  const r = object(v);
  choice(r.kind, run ? ['command','claude','run'] : ['command','claude']);
  string(r.value, r.kind === 'run' ? 4000 : 400);
  choice(r.scope,['global','project','conversation']);
  if (!Array.isArray(r.providers) || !r.providers.length || r.providers.some(p => p !== 'claude' && p !== 'codex')) throw new Error('Malformed permission providers.');
  if (r.scope !== 'global') string(r.cwd);
  if (r.scope === 'conversation') { string(r.sessionId); time(r.expiresAt); }
  optional(r.note,v => { if (typeof v !== 'string' || v.length > 500) throw new Error('Malformed rule note.'); });
  const problem = ruleProblem(r as unknown as PermissionRuleInput);
  if (problem) throw new Error(problem);
}
export function validatePermissionRow(row: PermissionRow): void {
  choice(row.kind,['rule','request','codex','meta']); string(row.id); integer(row.ordinal);
  if (typeof row.json !== 'string' || Buffer.byteLength(row.json) > PERMISSION_BYTES) throw new Error('Oversized permission row.');
  const v = JSON.parse(row.json);
  if (row.kind === 'rule') {
    const r = object(v); rule(r,false); if (r.id !== row.id) throw new Error('Permission rule identity mismatch.');
    choice(r.source,['owner','request','auto']); time(r.createdAt); time(r.updatedAt); optional(r.requestId,string);
  } else if (row.kind === 'request') {
    const r = object(v); rule(r.rule,true); if (r.id !== row.id) throw new Error('Permission request identity mismatch.');
    choice(r.status,['pending','approved','denied','withdrawn']); string(r.sessionId); string(r.cwd); time(r.createdAt);
    if (typeof r.reason !== 'string' || r.reason.length > 500) throw new Error('Malformed permission reason.');
    optional(r.provider,v => choice(v,['claude','codex'])); optional(r.decidedBy,v => choice(v,['owner','auto'])); optional(r.decidedAt,time);
    for (const k of ['runId','ruleId','key']) optional(r[k],string);
    optional(r.rechecks,integer); optional(r.keyExplicit,bool);
    optional(r.timeoutSeconds,v => { integer(v); if ((v as number) < 1 || (v as number) > MAX_RUN_SECONDS) throw new Error('Malformed permission timeout.'); });
    if (r.notification !== undefined) { const n = object(r.notification); choice(n.state,['pending','recorded']); if (typeof n.message !== 'string' || n.message.length > 4000) throw new Error('Malformed permission notice.'); }
    if (r.review !== undefined) {
      const review = object(r.review); choice(review.status,['queued','running','done','skipped','failed']);
      optional(review.verdict,v => choice(v,['approve','narrow','owner'])); optional(review.at,time);
      for (const [key,max] of [['reason',MAX_REVIEW_REASON],['suggestion',500],['model',64]] as const) optional(review[key],v => { if (typeof v !== 'string' || v.length > max) throw new Error('Malformed review field.'); });
      if (review.files !== undefined) {
        if (!Array.isArray(review.files) || review.files.length > MAX_REVIEWED_FILES) throw new Error('Malformed reviewed files.');
        for (const file of review.files) {
          const f = object(file); string(f.path,4096);
          if (f.real !== null) string(f.real,4096);
          if (f.sha256 !== null && (typeof f.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(f.sha256))) throw new Error('Malformed reviewed digest.');
          if (f.real === null && f.sha256 !== null) throw new Error('Malformed reviewed binding.');
          optional(f.depth,v => { integer(v); if ((v as number) < 1 || (v as number) > 3) throw new Error('Malformed reviewed depth.'); });
        }
      }
    }
    if (r.run !== undefined) {
      if (object(r.rule).kind !== 'run') throw new Error('Run without approved run request.');
      const run = object(r.run); choice(run.status,['waiting','running','done','failed']);
      for (const k of ['startedAt','finishedAt','toldAt']) optional(run[k],time);
      for (const k of ['pid','stdoutBytes','stderrBytes']) optional(run[k],integer);
      optional(run.exitCode,v => { if (!Number.isSafeInteger(v)) throw new Error('Malformed exit code.'); });
      for (const k of ['started','signal','error']) optional(run[k],string);
      for (const k of ['timedOut','delivered','notify','truncated']) optional(run[k],bool);
      if (run.preview !== undefined) { const p = object(run.preview); for (const k of ['stdout','stderr']) if (typeof p[k] !== 'string' || (p[k] as string).length > 4000) throw new Error('Malformed run preview.'); }
    }
  } else if (row.kind === 'codex') {
    const r = object(v); if (r.path !== row.id) throw new Error('Permission file identity mismatch.');
    choice(r.scope,['global','project']); if (r.scope === 'project') string(r.cwd);
  } else {
    choice(row.id,['autoReview','lost','extensions']);
    if (row.id === 'autoReview') { const r = object(v); bool(r.enabled); bool(r.resume); optional(r.provider,v => choice(v,['claude','codex'])); optional(r.model,v => string(v,64)); }
    if (row.id === 'lost') string(v);
    if (row.id === 'extensions') { const r = object(v); for (const key of ['version','rules','requests','codex','autoReview','lost']) if (key in r) throw new Error('Reserved permission extension key.'); }
  }
}
/** Lossless DTO codec for initial import/export only; never normalizes, drops, grants, or recovers native objects. */
export function permissionRows(value: unknown): PermissionRow[] {
  const state = object(value);
  if (state.version !== 1) throw new Error('Unknown permission state version.');
  const rows: PermissionRow[] = [];
  for (const [field,kind,key] of [['rules','rule','id'],['requests','request','id'],['codex','codex','path']] as const) {
    if (!Array.isArray(state[field])) throw new Error(`Missing permission ${field}.`);
    const seen = new Set<string>();
    for (const [ordinal,value] of (state[field] as unknown[]).entries()) {
      const id = object(value)[key]; string(id); if (seen.has(id as string)) throw new Error('Duplicate permission row.'); seen.add(id as string);
      rows.push({ kind,id: id as string,ordinal,json: permissionJson(value) });
    }
  }
  for (const key of ['autoReview','lost'] as const) if (state[key] !== undefined) rows.push({ kind:'meta',id:key,ordinal:0,json:permissionJson(state[key]) });
  const extensions = Object.fromEntries(Object.entries(state).filter(([key]) => !['version','rules','requests','codex','autoReview','lost'].includes(key)));
  if (Object.keys(extensions).length) rows.push({ kind:'meta',id:'extensions',ordinal:0,json:permissionJson(extensions) });
  for (const row of rows) validatePermissionRow(row);
  if ((state.rules as unknown[]).length > 200 || (state.requests as { status: string }[]).filter(r => r.status === 'pending').length > 50) throw new Error('Permission record count exceeds bounds.');
  if (Buffer.byteLength(JSON.stringify(state,null,2)) > PERMISSION_BYTES) throw new Error('Permission state exceeds its existing allowance.');
  return rows;
}
export function permissionState(rows: readonly PermissionRow[]): PermissionState {
  const state: Record<string,unknown> = { version:1,rules:[],requests:[],codex:[] };
  const keys = new Set<string>();
  for (const row of [...rows].sort((a,b) => a.ordinal - b.ordinal)) {
    validatePermissionRow(row);
    const key = JSON.stringify([row.kind,row.id]); if (keys.has(key)) throw new Error('Duplicate permission row.'); keys.add(key);
    const value = JSON.parse(row.json);
    if (row.kind === 'meta') {
      if (row.id === 'extensions') { for (const [key,v] of Object.entries(value)) Object.defineProperty(state,key,{ value:v,writable:true,enumerable:true,configurable:true }); }
      else state[row.id] = value;
    }
    else (state[row.kind === 'rule' ? 'rules' : row.kind === 'request' ? 'requests' : 'codex'] as unknown[]).push(value);
  }
  checkPermissionBounds(rows);
  return state as unknown as PermissionState;
}

/** Exact pretty-JSON projection budget using individual values; no runtime whole-state serialization. */
export function checkPermissionBounds(rows:readonly PermissionRow[]): void {
  const grouped={ rule:[] as unknown[],request:[] as unknown[],codex:[] as unknown[] };
  const properties:Record<string,unknown>=Object.assign(Object.create(null),{ version:1,rules:grouped.rule,requests:grouped.request,codex:grouped.codex });
  let pending=0,held=0;
  for (const row of rows) {
    validatePermissionRow(row); const value=JSON.parse(row.json);
    if (row.kind==='meta') { if (row.id==='extensions') Object.assign(properties,value); else properties[row.id]=value; }
    else grouped[row.kind].push(value);
    if (row.kind==='request') {
      if (value.status==='pending') pending++;
      if (value.review?.files) held+=Buffer.byteLength(JSON.stringify(value.review.files,null,2));
    }
  }
  if (grouped.rule.length>200 || pending>50 || held>1_000_000 || rows.length>PERMISSION_BYTES) throw new Error('Permission count/attachment allowance exceeded.');
  if (permissionStateBytes(properties)>PERMISSION_BYTES) throw new Error('Permission state exceeds its existing allowance.');
}

/** Measures each row/value independently, including pretty JSON wrapper/indentation costs. */
export function permissionStateBytes(properties:Record<string,unknown> | PermissionState):number {
  const valueBytes=(value:unknown, indent:number):number => {
    const text=JSON.stringify(value,null,2); return Buffer.byteLength(text)+(text.split('\n').length-1)*indent;
  };
  let bytes=4; // opening/closing braces and newlines
  const entries=Object.entries(properties);
  for (const [key,value] of entries) {
    bytes+=2+Buffer.byteLength(JSON.stringify(key))+2;
    if (key==='rules' || key==='requests' || key==='codex') {
      const values=value as unknown[];
      bytes+=values.length ? 6+values.reduce<number>((sum,v)=>sum+4+valueBytes(v,4),0)+2*(values.length-1) : 2;
    } else bytes+=valueBytes(value,2);
  }
  bytes+=2*Math.max(0,entries.length-1);
  return bytes;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Updates } from '../../../server/link/update.js';
import { runtimePaths } from '../../../server/link/service.js';
import { liveness, withStorageTransition, transitionLockPath, transitionBreakerPath, inspectStorageTransition } from '../../../server/link/storage-transition-lock.js';

const faults = [Object.assign(new Error('injected EIO'), { code: 'EIO' }), Object.assign(new Error('injected EINVAL'), { code: 'EINVAL' }), new Error('injected generic')];
async function child() {
 const c = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));"], { stdio: ['pipe','pipe','pipe'] });
 await once(c.stdout!, 'data');
 return { pid: c.pid!, finish: async () => { if (c.exitCode !== null) return; const ended = once(c, 'exit'); c.stdin!.end(); await ended; } };
}
async function directory() { return mkdtemp(join(tmpdir(), 'tower-owner-observation-')); }
function fault(pid: number, error: unknown) { const original = process.kill; process.kill = ((p: number, s: any) => { if(p === pid && s === 0) throw error; return original(p,s); }) as typeof process.kill; return () => { process.kill = original; }; }

test('actual alive staging without helper keeps unobserved owners and prunes unrelated release; actual ESRCH removes staging', async () => {
 const c = await child(); const dir = await directory();
 try {
 const versions = runtimePaths(dir).versions; const staging = join(versions, `1.2.0.installing-${c.pid}`);
 await mkdir(staging, {recursive:true});
 const updates = new Updates({stateDir:dir,version:'1.0.0',port:1,managed:true,spawnHelper:()=>{}});
 for(const error of faults) {
 await mkdir(join(versions,'9.0.0'),{recursive:true});
 const restore = fault(c.pid,error);
 try { await updates.prune(async()=>[]); } finally { restore(); }
 await access(staging);
 await assert.rejects(access(join(versions,'9.0.0')));
 }
 await c.finish();
 await updates.prune(async()=>[]); await assert.rejects(access(staging));
 } finally { await c.finish().catch(()=>{}); await rm(dir,{recursive:true,force:true}); }
});

test('transition observation errors preserve actual owner bytes and generation until deadline', async () => {
 const c = await child(); const dir = await directory();
 try {
 await mkdir(join(dir,'runtime')); const path = transitionLockPath(dir);
 const text = JSON.stringify({format:'tower-transition-owner',version:1,role:'lock',pid:c.pid,start:'observed',nonce:'a'.repeat(24)});
 await writeFile(path,text); const before = await lstat(path); let work = 0;
 for(const error of faults) {
 const restore = fault(c.pid,error);
 try { await assert.rejects(withStorageTransition(dir,async()=>{work++;},{waitMs:5}), (e:any)=>e.code==='transition-busy' && e.diagnostic?.lock.liveness==='unknown'); } finally {restore();}
 assert.equal(await readFile(path,'utf8'),text); const after = await lstat(path); assert.equal(after.ino,before.ino); assert.equal(after.mtimeMs,before.mtimeMs); assert.equal(work,0); await assert.rejects(access(transitionBreakerPath(dir)));
 }
 } finally {await c.finish(); await rm(dir,{recursive:true,force:true});}
});

test('out of int32 range is unknown without a syscall, including rollback liveness input', async () => {
 const original=process.kill; let calls=0; process.kill=((...args:any[])=>{calls++; throw new Error('must not reach syscall');}) as typeof process.kill;
 try { for(const pid of [2**31,Number.MAX_SAFE_INTEGER]) assert.equal(await liveness({pid,start:'x'}),'unknown'); assert.equal(calls,0); } finally {process.kill=original;}
});

test('actual barrier child holds the transition; unknown waits then enters only after controlled release', async () => {
 const dir=await directory();
 const c=spawn(process.execPath,['--import','tsx','tests/server/link/fixtures/transition-barrier-child.ts',dir],{stdio:['pipe','pipe','pipe']});
 await once(c.stdout!,'data');
 const path=transitionLockPath(dir); const text=await readFile(path,'utf8'); const before=await lstat(path);
 const sentinels=['current','storage-pin.json','update-hold'];
 for(const name of sentinels) await writeFile(join(dir,'runtime',name),`unchanged-${name}`);
 const restore=fault(c.pid!,faults[0]); let work=0;
 try {
 await assert.rejects(withStorageTransition(dir,async()=>{work++;},{waitMs:5}), (e:any)=>e.code==='transition-busy' && e.diagnostic.lock.reason.includes('EIO'));
 assert.equal(await readFile(path,'utf8'),text); const after=await lstat(path); assert.equal(after.ino,before.ino); assert.equal(after.mtimeMs,before.mtimeMs); assert.equal(work,0);
 for(const name of sentinels) assert.equal(await readFile(join(dir,'runtime',name),'utf8'),`unchanged-${name}`);
 const entering=withStorageTransition(dir,async()=>{work++;},{waitMs:2000});
 const ended=once(c,'exit'); c.stdin!.end(); await ended; await entering; assert.equal(work,1);
 } finally {restore(); if(c.exitCode===null){const ended=once(c,'exit');c.stdin!.end();await ended;} await rm(dir,{recursive:true,force:true});}
});

test('first gone then unobserved preserves foreign lock and cleans only own breaker', async()=>{
 const dir=await directory(); const pid=123456; await mkdir(join(dir,'runtime'));
 const text=JSON.stringify({format:'tower-transition-owner',version:1,role:'lock',pid,start:'old',nonce:'b'.repeat(24)}); const path=transitionLockPath(dir); await writeFile(path,text); const before=await lstat(path);
 const original=process.kill; let calls=0; let work=0;
 process.kill=((p:number,s:any)=>{if(p===pid && s===0)throw ++calls===1?Object.assign(new Error('gone'),{code:'ESRCH'}):faults[0];return original(p,s);}) as typeof process.kill;
 try {await assert.rejects(withStorageTransition(dir,async()=>{work++;},{waitMs:5}),{code:'transition-busy'}); assert.equal(await readFile(path,'utf8'),text); assert.equal((await lstat(path)).ino,before.ino);assert.equal(work,0);await assert.rejects(access(transitionBreakerPath(dir)));}finally{process.kill=original;await rm(dir,{recursive:true,force:true});}
});

test('staging live and EPERM stay, range owners make no syscall, and unknown never blocks other release cleanup', async()=>{
 const c=await child();const dir=await directory();const versions=runtimePaths(dir).versions;
 try {
 const updates=new Updates({stateDir:dir,version:'1.0.0',port:1,managed:true,spawnHelper:()=>{}});
 const live=join(versions,`1.2.0.installing-${c.pid}`);await mkdir(live,{recursive:true});
 await updates.prune(async()=>[]);await access(live);
 const restore=fault(c.pid,Object.assign(new Error('injected EPERM'),{code:'EPERM'}));try{await updates.prune(async()=>[]);await access(live);}finally{restore();}
 for(const pid of [2**31,Number.MAX_SAFE_INTEGER]){
 const path=join(versions,`1.3.0.installing-${pid}`);await mkdir(path);await mkdir(join(versions,'9.0.0'));
 const original=process.kill;let calls=0;process.kill=((p:number,s:any)=>{if(p===pid){calls++;throw new Error('out of range syscall');}return original(p,s);}) as typeof process.kill;
 try{await updates.prune(async()=>[]);await access(path);await assert.rejects(access(join(versions,'9.0.0')));assert.equal(calls,0);}finally{process.kill=original;}
 }
 }finally{await c.finish();await rm(dir,{recursive:true,force:true});}
});

test('unknown foreign breaker beside confirmed stale lock is refused immediately and preserved',async()=>{
 const dir=await directory();await mkdir(join(dir,'runtime'));const stale=await child();await stale.finish();const live=await child();
 const lock=JSON.stringify({format:'tower-transition-owner',version:1,role:'lock',pid:stale.pid,start:'old',nonce:'a'.repeat(24)});
 const breaker=JSON.stringify({format:'tower-transition-owner',version:1,role:'breaker',pid:live.pid,start:'owner',nonce:'b'.repeat(24)});
 await writeFile(transitionLockPath(dir),lock);await writeFile(transitionBreakerPath(dir),breaker);
 const before=await lstat(transitionBreakerPath(dir));const restore=fault(live.pid,faults[1]);let work=0;
 try{await assert.rejects(withStorageTransition(dir,async()=>{work++;},{waitMs:2000}),(e:any)=>e.code==='transition-lock-stale-breaker' && e.diagnostic.breaker.reason.includes('EINVAL'));assert.equal(work,0);assert.equal(await readFile(transitionLockPath(dir),'utf8'),lock);assert.equal(await readFile(transitionBreakerPath(dir),'utf8'),breaker);assert.equal((await lstat(transitionBreakerPath(dir))).ino,before.ino);}finally{restore();await live.finish();await rm(dir,{recursive:true,force:true});}
});

test('range transition owner preserves lock with reason and no syscall or work', async()=>{
 for(const pid of [2**31,Number.MAX_SAFE_INTEGER]){
 const dir=await directory();await mkdir(join(dir,'runtime'));const path=transitionLockPath(dir);const text=JSON.stringify({format:'tower-transition-owner',version:1,role:'lock',pid,start:'old',nonce:'c'.repeat(24)});await writeFile(path,text);const before=await lstat(path);
 const original=process.kill;let calls=0;let work=0;process.kill=((p:number,s:any)=>{if(p===pid){calls++;throw new Error('must not call');}return original(p,s);}) as typeof process.kill;
 try{await assert.rejects(withStorageTransition(dir,async()=>{work++;},{waitMs:5}),(e:any)=>e.code==='transition-busy'&&e.diagnostic.lock.reason.includes('outside'));assert.equal(calls,0);assert.equal(work,0);assert.equal(await readFile(path,'utf8'),text);assert.equal((await lstat(path)).ino,before.ino);await assert.rejects(access(transitionBreakerPath(dir)));}finally{process.kill=original;await rm(dir,{recursive:true,force:true});}
 }
});

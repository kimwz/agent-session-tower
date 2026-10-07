import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtemp,realpath,rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join,basename } from 'node:path';
import { inspectNativeRetention,type NativeInspectionRunner } from '../../../server/sessions/retention/native-inspection.js';
test('native inspector refuses partial lsof output even when its exit status is zero',async()=>{const temp=await mkdtemp(join(tmpdir(),'tower-native-inspector-'));const root=await realpath(temp);try{for(const warning of ['', 'lsof: partial output']){const run:NativeInspectionRunner=async(file)=>basename(file)==='ps'?{stdout:`${process.getuid!()} 12 codex\n`,stderr:''}:{stdout:'p12\nn'+join(root,'sessions','rollout-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')+'\n',stderr:warning};const result=await inspectNativeRetention(root,{claude:[join(root,'projects')],codex:[join(root,'sessions')]},run);assert.equal(result.complete,!warning);if(warning)assert.match(result.issues.join(';'),/Open-file inspection unavailable/);else assert.ok(result.activeIds.has('codex:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));}const psWarning:NativeInspectionRunner=async()=>({stdout:`${process.getuid!()} 12 codex\n`,stderr:'ps: partial output'});assert.equal((await inspectNativeRetention(root,{claude:[],codex:[]},psWarning)).complete,false);}finally{await rm(temp,{recursive:true,force:true});}});
test('empty no-match lsof result is complete only when a fresh process snapshot proves selected owners exited',async()=>{const temp=await mkdtemp(join(tmpdir(),'tower-native-inspector-'));const root=await realpath(temp);try{for(const exited of [false,true]){let snapshots=0;const run:NativeInspectionRunner=async(file)=>{if(basename(file)==='ps')return{stdout:++snapshots===1||!exited?`${process.getuid!()} 12 codex\n${process.getuid!()} 1 launchd\n`:`${process.getuid!()} 1 launchd\n`,stderr:''};throw Object.assign(new Error('No matching PID'),{code:1,stdout:'',stderr:''});};const result=await inspectNativeRetention(root,{claude:[join(root,'projects')],codex:[join(root,'sessions')]},run);assert.equal(result.complete,exited);assert.equal(snapshots,2);if(!exited)assert.match(result.issues.join(';'),/omitted a live provider/);}}finally{await rm(temp,{recursive:true,force:true});}});

test('native inspection excludes foreign UID processes without losing same UID writer protection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tower-native-uid-')); const root = await realpath(temp);
  const uid = process.getuid!(); const foreign = uid === 0 ? 501 : 0;
  try {
    const run: NativeInspectionRunner = async (file, args) => {
      if (basename(file) === 'ps') { assert.deepEqual(args, ['-axo', 'uid=,pid=,comm=']); return {stdout:`${uid} 12 codex\n${foreign} 13 node\n   -2   330 /usr/sbin/distnoted\n`,stderr:''}; }
      assert.equal(args.at(-1), '12');
      return {stdout:'p12\nn'+join(root,'sessions','rollout-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')+'\n',stderr:''};
    };
    const result = await inspectNativeRetention(root, {claude:[root],codex:[join(root,'sessions')]}, run);
    assert.equal(result.complete, true); assert.ok(result.activeIds.has('codex:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  } finally { await rm(temp, {recursive:true,force:true}); }
});
test('native inspection refuses process rows without provable UID ownership', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tower-native-uid-invalid-')); const root = await realpath(temp);
  try {
    const run: NativeInspectionRunner = async () => ({stdout:'12 codex\n',stderr:''});
    const result = await inspectNativeRetention(root,{claude:[root],codex:[]},run);
    assert.equal(result.complete,false); assert.match(result.issues.join(';'),/ownership metadata/);
  } finally { await rm(temp,{recursive:true,force:true}); }
});

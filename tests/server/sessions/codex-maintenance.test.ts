import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtemp,realpath,writeFile,chmod,rm } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import {join,delimiter} from 'node:path';
import { providerDirectories } from '../../../server/providers/discovery.js';
import { CodexMaintenanceClient } from '../../../server/sessions/retention/codex-maintenance.js';
test('unresponsive owned maintenance process is bounded and closed after startup timeout',async t=>{const temp=await mkdtemp(join(tmpdir(),'tower-maintenance-fixture-')); const root=await realpath(temp); const script=join(root,'native'); await writeFile(script,'#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(()=>{},1000);\n'); await chmod(script,0o700); const client=new CodexMaintenanceClient(script,root,80);try{await assert.rejects(()=>client.metadata('fixture'),/timed out/);
// The close's one-second grace before SIGTERM passes on a fake clock: the close ends once it has, however long the real exit takes.
t.mock.timers.enable({apis:['setTimeout']});const closing=client.close();t.mock.timers.tick(1000);await closing;t.mock.timers.reset();assert.throws(()=>process.kill((client as unknown as {child:{pid:number}}).child.pid,0));}finally{await client.close();await rm(temp,{recursive:true,force:true});}});

test('maintenance uses the shared provider lookup PATH under a minimal launch environment', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'tower-maintenance-path-')); const root = await realpath(temp);
  const script = join(root, 'owned-maintenance-fixture');
  const env = { ...process.env, PATH: `relative${delimiter}${root}${delimiter}/usr/bin${delimiter}/bin` };
  await writeFile(script, `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => { const req = JSON.parse(line); if (!req.id) return; let result = {}; if (req.method === 'thread/loaded/list') result = {data:[]}; if (req.method === 'thread/read') result = {thread:{id:req.params.threadId,path:process.env.PATH}}; process.stdout.write(JSON.stringify({id:req.id,result})+'\\n'); });
`);
  await chmod(script, 0o700);
  const client = new CodexMaintenanceClient('owned-maintenance-fixture', root, 5000, env);
  try { assert.equal((await client.metadata('fixture')).path, providerDirectories(env).join(delimiter)); }
  finally { await client.close(); await rm(temp, { recursive: true, force: true }); }
});

/** Official full A124 fixture, only inside the existing disposable hosted validation root. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=process.env.TOWER_SQLITE_OLD124_ROOT;
assert.equal(process.env.SQLITE_VALIDATION_CI,'1');
assert.ok(root && process.env.VALIDATION_ROOT && resolve(root).startsWith(`${resolve(process.env.VALIDATION_ROOT)}/`));
await mkdir(root,{mode:0o700}); // exclusive fresh root; never reuse a partial extraction
assert.equal(await realpath(root),root);
const response=await fetch('https://github.com/kimwz/agent-session-tower/releases/download/v1.124.0/agent-session-tower-1.124.0.tgz');
assert.equal(response.ok,true);
const archive=Buffer.from(await response.arrayBuffer());
assert.equal(archive.length,5118858);
assert.equal(sha(archive),'5647224b149023ad8f5a429832c1fc6b3012e7b27c16808a1fc2af6b00ef371d');
const tar=gunzipSync(archive), members={};
const text=bytes=>bytes.toString('utf8').replace(/\0.*$/s,'');
let offset=0;
while(offset+512<=tar.length) {
  const header=tar.subarray(offset,offset+512);
  if(header.every(byte=>byte===0)) break;
  const checksum=parseInt(text(header.subarray(148,156)).trim(),8);
  assert.equal(header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0),checksum);
  const name=text(header.subarray(0,100));
  assert.equal(text(header.subarray(345,500)),'');
  assert.equal(header[156],48,'only genuine release regular files; links/devices/PAX refused');
  assert.match(name,/^package\/[A-Za-z0-9_./-]+$/);
  assert.ok(name.split('/').every(part=>part && part!=='.' && part!=='..'));
  const member=name.slice(8);assert.ok(!Object.hasOwn(members,member));
  const size=parseInt(text(header.subarray(124,136)).trim(),8);
  assert.ok(Number.isSafeInteger(size)&&size>=0 && offset+512+size<=tar.length);
  const bytes=tar.subarray(offset+512,offset+512+size), target=join(root,name);
  await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o600});
  assert.equal(sha(await readFile(target)),sha(bytes));members[member]={bytes:size,sha256:sha(bytes)};
  offset+=512+Math.ceil(size/512)*512;
}
assert.equal(Object.keys(members).length,714);
assert.ok(tar.subarray(offset).every(byte=>byte===0),'no unparsed trailing archive bytes');
const packageRoot=join(root,'package');
const old=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
const current=JSON.parse(await readFile('package.json','utf8'));
assert.equal(old.version,'1.124.0');
assert.deepEqual(old.dependencies,current.dependencies);
assert.deepEqual(old.devDependencies,current.devDependencies);
// Only dependency resolution is shared after metadata equality. Never replace old product modules.
await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
const {stdout}=await promisify(execFile)(process.execPath,[join(packageRoot,'bin/agent-session-tower.mjs'),'--storage-contract'],{timeout:60_000,maxBuffer:16*1024*1024});
const contract=JSON.parse(stdout);
const captured=JSON.parse(await readFile('tests/server/storage/fixtures/triggers-a124/capture.json','utf8'));
assert.equal(contract.supported,true);assert.deepEqual(contract.identity,captured.identity);
for(const [captureRoot,captureName] of [['triggers-a124','capture.json'],['triggers-a124-package','capture.json']]) {
  const capture=JSON.parse(await readFile(`tests/server/storage/fixtures/${captureRoot}/${captureName}`,'utf8'));
  for(const fact of Object.values(capture.files)) {
    const member=fact.member.slice(8);assert.equal(members[member].sha256,fact.sha256);
  }
}
const sdk=await import(pathToFileURL(join(packageRoot,'dist/server/storage/index.js')).href);
const bundle=await sdk.captureStorageBundle(), context=sdk.storageBuildContext(bundle);
assert.equal(context.ok,true);assert.deepEqual(context.identity,contract.identity);
await writeFile(join(root,'storage-contract.json'),stdout,{flag:'wx',mode:0o600});
const receipt={format:'tower-full-old124-capture',packageSHA256:sha(archive),archiveBytes:archive.length,members,identity:contract.identity,contractSHA256:sha(Buffer.from(stdout)),runtime:process.versions.node,dependenciesEqual:true};
await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
await writeFile(join(process.env.VALIDATION_ROOT,'reports','old124-full-artifact.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
await writeFile(join(process.env.VALIDATION_ROOT,'reports','old124-full-cli-stdout.json'),stdout,{flag:'wx',mode:0o600});

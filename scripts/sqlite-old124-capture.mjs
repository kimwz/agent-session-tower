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
const version=process.argv[2] ?? '1.124.0';
assert.ok(['1.122.0','1.124.0'].includes(version), 'only the two pinned official releases');
const a122=version==='1.122.0', label=a122?'old122':'old124';
const pinned=a122?{bytes:4981649,sha256:'438767a17b42db5c021b8d9f91f650b9b6c24eeaf7272ea90e9992feaf85a2fd',members:704,captures:['runs-a122']}:{bytes:5118858,sha256:'5647224b149023ad8f5a429832c1fc6b3012e7b27c16808a1fc2af6b00ef371d',members:714,captures:['triggers-a124','triggers-a124-package']};
const root=process.env[a122?'TOWER_SQLITE_OLD122_ROOT':'TOWER_SQLITE_OLD124_ROOT'];
assert.equal(process.env.SQLITE_VALIDATION_CI,'1');
assert.ok(root && process.env.VALIDATION_ROOT && resolve(root).startsWith(`${resolve(process.env.VALIDATION_ROOT)}/`));
await mkdir(root,{mode:0o700}); // exclusive fresh root; never reuse a partial extraction
assert.equal(await realpath(root),root);
const response=await fetch(`https://github.com/kimwz/agent-session-tower/releases/download/v${version}/agent-session-tower-${version}.tgz`);
assert.equal(response.ok,true);
const archive=Buffer.from(await response.arrayBuffer());
assert.equal(archive.length,pinned.bytes);
assert.equal(sha(archive),pinned.sha256);
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
assert.equal(Object.keys(members).length,pinned.members);
assert.ok(tar.subarray(offset).every(byte=>byte===0),'no unparsed trailing archive bytes');
const packageRoot=join(root,'package');
const old=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
const current=JSON.parse(await readFile('package.json','utf8'));
assert.equal(old.version,version);
assert.deepEqual(old.dependencies,current.dependencies);
assert.deepEqual(old.devDependencies,current.devDependencies);
// Only dependency resolution is shared after metadata equality. Never replace old product modules.
await symlink(resolve('node_modules'),join(root,'node_modules'),'dir');
const {stdout}=await promisify(execFile)(process.execPath,[join(packageRoot,'bin/agent-session-tower.mjs'),'--storage-contract'],{timeout:60_000,maxBuffer:16*1024*1024});
const contract=JSON.parse(stdout);
const captured=JSON.parse(await readFile(`tests/server/storage/fixtures/${pinned.captures[0]}/capture.json`,'utf8'));
assert.equal(contract.supported,true);assert.deepEqual(contract.identity,captured.identity);
for(const captureRoot of pinned.captures) {
  const capture=JSON.parse(await readFile(`tests/server/storage/fixtures/${captureRoot}/capture.json`,'utf8'));
  if (a122) {
    assert.equal(members['dist/server/storage/generated/thread-bundle.json'].sha256,capture.threadArtifactSHA256);
    // The original package maps omit sourcesContent; pin its original exported JS, never relabel current TS.
    const schemas={"dist/server/runs/storage-schema.js": "a643b7a317ab22b38cb66225dbe27f08f52dfa0389e4437567a2329a36dfac2a", "dist/server/sessions/retention/storage-schema.js": "2a70ebbd6111deb76d241478416c2a248bb8d16b023345c8d486b9d55967eec8"};
    for (const [member,hash] of Object.entries(schemas)) assert.equal(members[member].sha256,hash);
  } else for(const fact of Object.values(capture.files)) {
    const member=fact.member.slice(8);assert.equal(members[member].sha256,fact.sha256);
  }
}
const sdk=await import(pathToFileURL(join(packageRoot,'dist/server/storage/index.js')).href);
const bundle=await sdk.captureStorageBundle(), context=sdk.storageBuildContext(bundle);
assert.equal(context.ok,true);assert.deepEqual(context.identity,contract.identity);
await writeFile(join(root,'storage-contract.json'),stdout,{flag:'wx',mode:0o600});
const receipt={format:`tower-full-${label}-capture`,packageSHA256:sha(archive),archiveBytes:archive.length,members,identity:contract.identity,contractSHA256:sha(Buffer.from(stdout)),runtime:process.versions.node,dependenciesEqual:true};
await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
await writeFile(join(process.env.VALIDATION_ROOT,'reports',`${label}-full-artifact.json`),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
await writeFile(join(process.env.VALIDATION_ROOT,'reports',`${label}-full-cli-stdout.json`),stdout,{flag:'wx',mode:0o600});

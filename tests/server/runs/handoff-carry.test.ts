import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSuccessor } from '../../../server/runs/handoff.js';

const handoff = fileURLToPath(new URL('../../../server/runs/handoff.ts', import.meta.url));

/** A stand-in successor: reads its stdin as the worker does and writes what it got. */
async function successorScript(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'tower-handoff-carry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'successor.mts'), out = join(directory, 'out.json');
  await writeFile(script, `import { writeFileSync } from 'node:fs';
import { readHandoffCarry } from ${JSON.stringify(handoff)};
const started = Date.now();
const carry = await readHandoffCarry(process.stdin, Number(process.env.CARRY_TIMEOUT ?? 10000));
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ carry: carry?.toString('base64') ?? null, nonce: process.env.TOWER_HANDOFF, ms: Date.now() - started }));
`);
  const result = async () => { const deadline = Date.now() + 20_000; while (!existsSync(out)) { if (Date.now() > deadline) throw new Error('successor did not finish'); await new Promise(resolve => setTimeout(resolve, 50)); } await new Promise(resolve => setTimeout(resolve, 50)); return JSON.parse(await readFile(out, 'utf8')) as { carry: string | null; nonce: string; ms: number }; };
  return { command: { execPath: process.execPath, args: ['--import', 'tsx', script] }, result };
}

test('the successor receives the carried state on stdin, and the sender clears its copy', async t => {
  const s = await successorScript(t);
  const carry = Buffer.from('{"format":1,"key":"c2VjcmV0"}');
  const expected = carry.toString('base64');
  spawnSuccessor(s.command, 'a'.repeat(32), carry);
  const got = await s.result();
  assert.equal(got.carry, expected);
  assert.equal(got.nonce, 'a'.repeat(32));
  assert.ok(carry.every(byte => byte === 0), 'the predecessor zeroes its copy once written');
});

test('without carried state the successor gets nothing and does not wait', async t => {
  const s = await successorScript(t);
  spawnSuccessor(s.command, 'b'.repeat(32));
  const got = await s.result();
  assert.equal(got.carry, null);
  assert.ok(got.ms < 5000);
});

test('a successor started by an older build (stdin ignored) starts without carried state at once', async t => {
  const s = await successorScript(t);
  const child = spawn(s.command.execPath, s.command.args, { detached: true, stdio: 'ignore', env: { ...process.env, TOWER_HANDOFF: 'c'.repeat(32) } });
  child.unref();
  const got = await s.result();
  assert.equal(got.carry, null);
  assert.ok(got.ms < 5000);
});

test('a predecessor that never finishes sending is not waited on forever', async t => {
  const s = await successorScript(t);
  const child = spawn(s.command.execPath, s.command.args, { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TOWER_HANDOFF: 'd'.repeat(32), CARRY_TIMEOUT: '300' } });
  child.stdin.write('partial');
  t.after(() => { child.stdin.destroy(); child.kill(); });
  const got = await s.result();
  assert.equal(got.carry, null);
});

test('a successor that cannot be started leaves no handed-over state behind', async () => {
  const carry = Buffer.from('open vault');
  spawnSuccessor({ execPath: '/nonexistent/tower-successor', args: [] }, 'e'.repeat(32), carry);
  const deadline = Date.now() + 5000;
  while (!carry.every(byte => byte === 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(carry.every(byte => byte === 0));
});

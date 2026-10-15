/**
 * Exit 0 only when the newest CI run of a commit and its `validation gate (all platforms)` completed with success. A run
 * or rerun still going, skipped, cancelled, failed, or never started (as `[skip ci]` does) fails. Used before merging,
 * before tagging and by the Release workflow before it publishes. Usage: node scripts/ci-verify.mjs <commit>
 */
import { execFileSync } from 'node:child_process';
import { commitGate } from './ci-scope.mjs';

const sha = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('usage: ci-verify.mjs <full commit SHA>');
const repo = process.env.GITHUB_REPOSITORY ?? execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).trim();
const gate = commitGate(sha, repo);
console.log(`${sha}: ${gate.reason}`);
if (!gate.passed) process.exitCode = 1;

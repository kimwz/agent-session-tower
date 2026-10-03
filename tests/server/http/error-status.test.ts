import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Snapshot } from '../../../shared/types.js';
import { parseModelSettings } from '../../../shared/models.js';
import { errorDisposition, errorStatus, httpError } from '../../../server/http/requests.js';
import { normalizeSessionTitle } from '../../../server/stores/session-titles.js';
import { requestedEffort, requestedModel } from '../../../server/providers/models.js';
import { requestedApprovalsReviewer } from '../../../server/providers/approvals.js';
import { newWorkerSession } from '../../../server/models/worker.js';
import { validateSchedule } from '../../../server/triggers/schedule.js';
import { failure as triggerFailure } from '../../../server/triggers/errors.js';
import { decodeJoinCode } from '../../../server/link/join-code.js';
import { parseSuccessor } from '../../../server/runs/handoff.js';
import { screenCommand } from '../../../server/master/tools.js';
import { mergeSettings } from '../../../server/master/settings.js';
import { BackupError, checkPassphrase } from '../../../server/backup/crypto.js';
import { notAdmitted, RunError } from '../../../server/runs/run-records.js';
import { SteeringError } from '../../../server/runs/steering.js';
import { SkillError } from '../../../server/skills/files.js';
import { assertWorkspace, readWorkspaceFile } from '../../../server/workspace-files.js';

/**
 * What the HTTP edge answers for an error: its status, message and delivery disposition. These expectations hold
 * whatever an error is made of inside, so they pin the answers a page and another process see.
 */
const edge = (error: unknown) => ({ status: errorStatus(error), message: error instanceof Error ? error.message : String(error), disposition: errorDisposition(error) });
const caught = async (work: () => unknown) => {
  try { await work(); } catch (error) { return edge(error); }
  throw new Error('expected a failure');
};

test('the edge reads a numeric statusCode as it is, whatever its value, and falls back to the message otherwise', () => {
  const plain = (statusCode: unknown, message = 'x') => Object.assign(new Error(message), { statusCode });
  assert.equal(errorStatus(plain(404)), 404);
  assert.equal(errorStatus(plain(599)), 599, 'an unmapped status is kept');
  assert.equal(errorStatus(plain(0)), 0, 'zero is kept, not replaced');
  assert.ok(Number.isNaN(errorStatus(plain(Number.NaN))), 'NaN is kept');
  assert.ok(Number.isNaN(errorStatus(plain(undefined, 'not found'))), 'a statusCode key without a value beats the message');
  assert.equal(errorStatus(plain(null)), 0, 'null reads as 0');
  assert.equal(errorStatus(plain('404')), 404, 'a numeric string is read as its number');
  assert.equal(errorStatus({ statusCode: 410 }), 410, 'an object that is not an Error is read too');
  assert.equal(errorStatus(new Error('Session not found')), 404);
  assert.equal(errorStatus(new Error('찾을 수 없습니다')), 404);
  assert.equal(errorStatus(new Error('the queue is busy')), 409);
  assert.equal(errorStatus(new Error('Claude CLI missing')), 409);
  assert.equal(errorStatus(new Error('boom')), 500);
  assert.equal(errorStatus('not found'), 500, 'only an Error message is read');
  assert.equal(errorStatus(undefined), 500);
  assert.equal(errorStatus(null), 500);
});

test('the edge reports only handoff, not-admitted and uncertain dispositions, from any object', () => {
  const with_ = (disposition: unknown) => Object.assign(new Error('x'), { disposition });
  assert.equal(errorDisposition(with_('handoff')), 'not-admitted');
  assert.equal(errorDisposition(with_('not-admitted')), 'not-admitted');
  assert.equal(errorDisposition(with_('uncertain')), 'uncertain');
  assert.equal(errorDisposition(with_('rejected')), undefined);
  assert.equal(errorDisposition(with_('other')), undefined);
  assert.equal(errorDisposition({ disposition: 'uncertain' }), 'uncertain', 'a plain object keeps its disposition');
  assert.equal(errorDisposition({ disposition: 'handoff', statusCode: 503 }), 'not-admitted');
  assert.equal(errorDisposition(undefined), undefined);
  assert.equal(errorDisposition(null), undefined);
});

test('every domain error keeps its status, message and disposition at the edge', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tower-error-status-'));
  try {
    const cwd = join(base, 'workspace');
    await writeFile(join(base, 'file'), 'x');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(cwd);
    await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
    const snapshot: Snapshot = { sessions: [], runs: [], providers: [], scanning: false, hostname: 'fixture', version: 'test', updatedAt: '', groups: [{ cwd, title: '', pinned: true }, { cwd: join(base, 'file'), title: '', pinned: true }] };
    const rows: Array<[string, ReturnType<typeof edge>, ReturnType<typeof edge>]> = [];
    const row = async (name: string, work: () => unknown, status: number, message: string | RegExp, disposition?: string) => {
      const actual = await caught(work);
      rows.push([name, actual, { status, message: typeof message === 'string' ? message : actual.message, disposition: disposition as ReturnType<typeof edge>['disposition'] }]);
      if (message instanceof RegExp) assert.match(actual.message, message, name);
    };
    await row('shared/models strict settings', () => parseModelSettings('x', true), 400, '모델 설정이 올바르지 않습니다.');
    await row('stores/session-titles', () => normalizeSessionTitle(5), 400, '제목은 120자 이하의 문자열이어야 합니다.');
    await row('providers/models model', () => requestedModel('bad id'), 400, 'Invalid model. Choose a valid provider model.');
    await row('providers/models effort', () => requestedEffort('ultra', 'claude'), 400, 'Invalid reasoning effort. Choose a level the model supports.');
    await row('providers/approvals', () => requestedApprovalsReviewer('x'), 400, '승인 검토는 자동 검토 또는 직접 확인만 선택할 수 있습니다.');
    await row('models/worker role', () => newWorkerSession(base, { cwd, prompt: 'x', modelRole: 'other' } as never), 400, 'Unknown worker model role.');
    await row('triggers/schedule', () => validateSchedule({ type: 'cron', expression: 'bad', timezone: 'UTC' } as never), 400, /five-field cron/);
    await row('triggers failure default', () => { throw triggerFailure('t'); }, 400, 't');
    await row('triggers failure 507', () => { throw triggerFailure('full', 507); }, 507, 'full');
    await row('triggers failure 423', () => { throw triggerFailure('locked', 423); }, 423, 'locked');
    await row('link/join-code', () => decodeJoinCode('nope'), 400, 'Tower 연결 코드가 아닙니다. 다른 컴퓨터에서 코드 전체를 복사하세요.');
    await row('runs/handoff', () => parseSuccessor({}, base), 400, 'Invalid successor worker command.');
    await row('master/tools', () => screenCommand({}), 400, 'action은 openSession, close, openPanel, filter, setPreference 중 하나입니다.');
    await row('master/settings', () => mergeSettings({} as never, 'x'), 400, '마스터 설정이 올바르지 않습니다.');
    await row('backup/crypto passphrase', () => checkPassphrase(''), 400, /./);
    await row('backup BackupError 500', () => { throw new BackupError('b', 500); }, 500, 'b');
    await row('runs RunError default', () => { throw new RunError('r'); }, 400, 'r');
    await row('runs RunError 404', () => { throw new RunError('r404', 404); }, 404, 'r404');
    await row('runs RunError not admitted', () => { throw notAdmitted(new RunError('full', 503)); }, 503, 'full');
    await row('runs SteeringError rejected', () => { throw new SteeringError('s', 'rejected'); }, 409, 's');
    await row('runs SteeringError uncertain', () => { throw new SteeringError('u', 'uncertain'); }, 409, 'u', 'uncertain');
    await row('skills SkillError default', () => { throw new SkillError('k'); }, 400, 'k');
    await row('skills SkillError 409', () => { throw new SkillError('k409', 409); }, 409, 'k409');
    await row('http httpError', () => { throw httpError(410, 'gone'); }, 410, 'gone');
    await row('workspace relative', () => assertWorkspace('relative', snapshot), 400, 'An absolute workspace directory is required.');
    await row('workspace unlisted', () => assertWorkspace(base, snapshot), 403, 'Only workspace directories listed in Tower can be opened.');
    await row('workspace not a directory (typed error passes through)', () => assertWorkspace(join(base, 'file'), snapshot), 400, 'Workspace is not a directory.');
    await row('workspace missing', () => readWorkspaceFile(cwd, 'missing.txt', snapshot), 404, 'File or directory no longer exists.');
    await row('workspace binary 415', () => readWorkspaceFile(cwd, 'binary.bin', snapshot), 415, 'Binary files cannot be opened in the text editor.');
    for (const [name, actual, expected] of rows) assert.deepEqual(actual, expected, name);
    // Kept as the classes they are: callers branch on them.
    assert.equal((notAdmitted(new RunError('x', 503))).retryable, true);
    assert.ok(new SteeringError('s', 'rejected') instanceof Error);
    assert.equal(new SteeringError('s', 'rejected').disposition, 'rejected');
  } finally { await rm(base, { recursive: true, force: true }); }
});

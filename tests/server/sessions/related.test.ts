import assert from 'node:assert/strict';
import test from 'node:test';
import type { DecisionEngine } from '../../../server/decisions/engine.js';
import { relatedSessionNotes } from '../../../server/sessions/related.js';
import type { Run, Session } from '../../../shared/types.js';

const now = Date.parse('2026-09-28T02:00:00.000Z');
const session = (id: string, title: string, cwd: string, daysAgo: number, extra: Partial<Session> = {}): Session => ({ id, nativeId: id.split(':')[1]!, provider: 'codex', title, cwd,
  project: 'p', status: 'completed', statusReason: '', createdAt: '', updatedAt: new Date(now - daysAgo * 86_400_000).toISOString(), lastMessage: `${title} done`, messageCount: 2,
  isSubagent: false, resumable: true, ...extra });
const run: Run = { id: 'r', sessionId: 'claude:new', prompt: '용사단 키우기 결제 아이템이 서버를 거치지 않고 지급됩니다', status: 'queued', createdAt: '', output: '' };
const fresh = session('claude:new', 'new', '/slack', 0);
const noRequests = () => [];

/** A judgment that says yes to the sessions whose titles mention a word, and records what it was shown. */
function engine(word: string, seen: Array<{ state: any; questions: Record<string, any> }>): DecisionEngine {
  return { provider: 'jev', label: 'Jev', decide: async request => {
    seen.push(request as never);
    const earlier = (request.state as { earlierSessions: Record<string, { title: string }> }).earlierSessions;
    return Object.fromEntries(Object.keys(request.questions).map(key => [key, { yes: earlier[key]!.title.includes(word) ? 0.9 : 0.1 }])) as never;
  } };
}

test('a new conversation hears of at most three earlier sessions a judgment finds to be about the same work', async () => {
  const seen: Array<{ state: any; questions: Record<string, any> }> = [];
  const all = [fresh,
    session('codex:heroes', 'Heroes Unite 용사단 결제 조사', '/work/verse8', 0.01),
    session('codex:other', 'Unrelated refactor', '/work/verse8', 0.02),
    session('codex:old', '용사단 old', '/work/verse8', 40),
    session('codex:sub', '용사단 subagent', '/work/verse8', 0.01, { isSubagent: true }),
    session('codex:exec', '용사단 exec', '/work/verse8', 0.01, { launchedByAgent: true }),
    ...Array.from({ length: 5 }, (_, i) => session(`codex:many${i}`, `용사단 follow-up ${i}`, '/work/verse8', 1 + i))];
  const notes = await relatedSessionNotes(engine('용사단', seen), run, fresh, all, noRequests, now);
  const ids = [...notes!.matchAll(/^- (\S+)/gm)].map(match => match[1]);
  assert.equal(ids.length, 3, 'at most three');
  assert.ok(ids.includes('codex:heroes'));
  assert.match(notes!, /may not be related/);
  const shown = Object.values(seen[0]!.state.earlierSessions).map((item: any) => item.title);
  assert.ok(!shown.some(title => /old|subagent|exec/.test(title)), 'nothing older than 30 days, no subagents, no agent-launched runs');
  assert.ok(!shown.includes('new'), 'never the new conversation itself');
  assert.equal(Object.keys(seen[0]!.questions).length, shown.length, 'one question per earlier session');
});

test('no judgment, no likely match or no request means no notes', async () => {
  const all = [fresh, session('codex:other', 'Unrelated refactor', '/work', 0.1)];
  assert.equal(await relatedSessionNotes(undefined, run, fresh, all, noRequests, now), undefined);
  assert.equal(await relatedSessionNotes(engine('용사단', []), run, fresh, all, noRequests, now), undefined);
  assert.equal(await relatedSessionNotes(engine('Unrelated', []), { ...run, prompt: ' ' }, fresh, all, noRequests, now), undefined);
});

test('sessions in the same folder are offered first when there are more than can be asked about', async () => {
  const seen: Array<{ state: any; questions: Record<string, any> }> = [];
  const all = [fresh, ...Array.from({ length: 45 }, (_, i) => session(`codex:elsewhere${i}`, `elsewhere ${i}`, '/other', 0.001 * (i + 1))),
    session('codex:here', 'same folder', '/slack', 10)];
  await relatedSessionNotes(engine('nothing', seen), run, fresh, all, noRequests, now);
  const shown = Object.values(seen[0]!.state.earlierSessions).map((item: any) => item.title);
  assert.equal(shown.length, 40);
  assert.equal(shown[0], 'same folder');
});

test('each earlier session is described by its latest user requests, newest first, as many as fit its share', async () => {
  const seen: Array<{ state: any; questions: Record<string, any> }> = [];
  const requests = new Map([['codex:long', Array.from({ length: 8 }, (_, i) => `${String(8 - i)} ${'x'.repeat(298)}`)], ['codex:short', ['결제 아이템 서버 지급 확인', '용사단 키우기 결제 조사']]]);
  const all = [fresh, session('codex:short', 'Payments', '/work', 0.1), ...Array.from({ length: 38 }, (_, i) => session(`codex:long${i}`, `busy ${i}`, '/work', 0.2 + i / 100)), session('codex:long', 'Long', '/work', 0.05)];
  await relatedSessionNotes(engine('nothing', seen), run, fresh, all, id => requests.get(id) ?? [], now);
  const earlier = Object.values(seen[0]!.state.earlierSessions) as Array<{ title: string; latestUserRequests: string[]; lastMessage?: string }>;
  assert.deepEqual(earlier.find(item => item.title === 'Payments')!.latestUserRequests, ['결제 아이템 서버 지급 확인', '용사단 키우기 결제 조사'], 'newest first, as kept');
  const long = earlier.find(item => item.title === 'Long')!.latestUserRequests;
  assert.ok(long.length >= 1 && long.length < 8, 'only as many as fit');
  assert.match(long[0]!, /^8 /, 'the newest first');
  assert.ok(earlier.every(item => item.lastMessage === undefined), 'the agent’s answers are not sent');
  assert.ok(JSON.stringify(seen[0]!.state).length < 105_000, 'within what the judgment takes');
});

test('what is sent stays within the judgment’s limit even when every request is full of characters JSON escapes', async () => {
  const seen: Array<{ state: any; questions: Record<string, any> }> = [];
  const escaped = '\\"\u001b'.repeat(100);
  const all = [fresh, ...Array.from({ length: 45 }, (_, i) => session(`codex:e${i}`, `${escaped} ${i}`.repeat(3), `/w/${escaped.repeat(20)}`, 0.01 * (i + 1)))];
  await relatedSessionNotes(engine('nothing', seen), { ...run, prompt: escaped.repeat(20) }, fresh, all, id => id.endsWith('e0') ? ['plain request'] : Array.from({ length: 8 }, () => escaped), now);
  const state = JSON.stringify(seen[0]!.state);
  const longestQuestion = Math.max(...Object.values(seen[0]!.questions).map(question => JSON.stringify(question).length));
  assert.ok(state.length + longestQuestion <= 110_000, `${state.length + longestQuestion} characters`);
  assert.deepEqual((Object.values(seen[0]!.state.earlierSessions)[0] as { latestUserRequests: string[] }).latestUserRequests, ['plain request'], 'what fits is still sent');
});

test('when titles and folders alone are too much, the sessions last in line are left out', async () => {
  const seen: Array<{ state: any; questions: Record<string, any> }> = [];
  const control = '\u001b'.repeat(300);
  const all = [fresh, ...Array.from({ length: 40 }, (_, i) => session(`codex:c${i}`, control, `/${control}`, 0.01 * (i + 1)))];
  await relatedSessionNotes(engine('nothing', seen), { ...run, prompt: control.repeat(14) }, fresh, all, () => [], now);
  const state = JSON.stringify(seen[0]!.state);
  const questions = Object.keys(seen[0]!.questions).length;
  assert.ok(state.length <= 100_000 && questions < 40 && questions === Object.keys(seen[0]!.state.earlierSessions).length);
});

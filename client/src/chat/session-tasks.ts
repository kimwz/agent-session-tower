import type { SessionTask } from '../../../shared/types';
import { currentTask } from '../../../shared/session-tasks';

/** The color family a stage is shown in. Only how it looks: the stage itself is the summary's free text. */
export type StageTone = 'done' | 'review' | 'build' | 'think' | 'wait' | 'neutral';

const TONES: Array<[StageTone, RegExp]> = [
  ['wait', /대기|보류|막힘|중단|waiting|blocked|on hold|paused|stuck/i],
  ['done', /배포|완료|머지|병합|답변|해결|deployed|done|merged|released|shipped|answered|resolved|complete/i],
  ['review', /리뷰|검토|pr\b|review/i],
  ['build', /구현|수정|작성|개발|리팩|implement|fix|build|writ|refactor|coding/i],
  ['think', /분석|조사|설계|계획|검증|테스트|확인|investigat|analy|design|plan|research|test|verif|check/i],
];

export function stageTone(stage: string): StageTone {
  return TONES.find(([, pattern]) => pattern.test(stage))?.[0] ?? 'neutral';
}

/** The tasks to show: the current one, and every task newest first, the current one marked. */
export function taskTimeline(tasks: readonly SessionTask[] | undefined): { current?: SessionTask; items: Array<SessionTask & { current: boolean }> } {
  const current = currentTask(tasks);
  const items = [...tasks ?? []].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => ({ ...task, current: task === current }));
  return { current, items };
}

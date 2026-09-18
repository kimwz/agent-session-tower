import type { CodexApprovalsReviewer } from '../../shared/types.js';

/** Sending nothing keeps the reviewer Codex itself is configured to use. */
export function requestedApprovalsReviewer(value: unknown): CodexApprovalsReviewer | undefined {
  if (value === undefined) return undefined;
  if (value !== 'user' && value !== 'auto_review') throw Object.assign(new Error('승인 검토는 자동 검토 또는 직접 확인만 선택할 수 있습니다.'), { statusCode: 400 });
  return value;
}

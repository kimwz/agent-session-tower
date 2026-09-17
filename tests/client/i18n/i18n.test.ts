import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectLanguage, getLanguage, setLanguage, translate, translateMessage } from '../../../client/src/i18n/i18n.js';
import { absoluteTime, relativeTime, sessionTitle, statusLabels } from '../../../client/src/common/lib.js';
import { ChatTranscript } from '../../../client/src/chat/ChatTranscript.js';
import { RunControl } from '../../../client/src/chat/RunControl.js';
import type { Run, Session } from '../../../shared/types.js';

const originalLanguage = getLanguage();
test.afterEach(() => setLanguage(originalLanguage));

test('language detection respects a saved choice and falls back to browser language', () => {
  assert.equal(detectLanguage('en', 'ko-KR'), 'en');
  assert.equal(detectLanguage('ko', 'en-US'), 'ko');
  assert.equal(detectLanguage(null, 'ko'), 'ko');
  assert.equal(detectLanguage('invalid', 'KO-kr'), 'ko');
  assert.equal(detectLanguage(null, 'en-GB'), 'en');
  assert.equal(detectLanguage(null, 'ja-JP'), 'en');
  assert.equal(detectLanguage(null), 'en');
});

test('language changes refresh labels, interpolation, time formats and only known application messages', () => {
  setLanguage('en');
  assert.equal(statusLabels.working, 'Working');
  assert.equal(translate('기존 모델 유지: {0}', { 0: 'native/model' }), 'Keep existing model: native/model');
  assert.equal(translateMessage('Agent Session Tower에서 작업 중'), 'Working in Agent Session Tower');
  assert.equal(translateMessage('USER_NATIVE_ERROR 내용'), 'USER_NATIVE_ERROR 내용');
  assert.equal(relativeTime('2026-09-15T00:00:00Z', Date.parse('2026-09-15T00:03:00Z')), '3 min ago');
  assert.match(absoluteTime('2026-09-15T12:00:00Z'), /Sep/);
  assert.equal(relativeTime('invalid'), 'Time unavailable');
  setLanguage('ko');
  assert.equal(statusLabels.working, '작업 중');
  assert.equal(translateMessage('The last task finished'), '마지막 작업을 완료했습니다');
  assert.equal(relativeTime('2026-09-15T00:00:00Z', Date.parse('2026-09-15T00:03:00Z')), '3분 전');
});

test('both languages render application controls while preserving the complete native transcript', () => {
  const messages = [{ id: 'user', role: 'user' as const, timestamp: '2026-09-15T00:00:00Z', text: '새 활동 — Keep this exact native text.' }];
  const run: Run = { id: 'r', sessionId: 's', prompt: '원본 요청', createdAt: '2026-09-15T00:00:00Z', status: 'error', output: '', error: '새 세션을 생성할 수 없습니다.' };
  for (const language of ['ko', 'en'] as const) {
    setLanguage(language);
    const transcript = renderToStaticMarkup(createElement(ChatTranscript, { messages }));
    assert.match(transcript, /새 활동 — Keep this exact native text\./);
    assert.match(transcript, language === 'en' ? />You</ : />나</);
    const control = renderToStaticMarkup(createElement(RunControl, { run, onCancel() {}, onRetry() {}, cancelling: false }));
    assert.match(control, /원본 요청/);
    assert.match(control, language === 'en' ? /A new session cannot be created/ : /새 세션을 생성할 수 없습니다/);
    assert.match(control, language === 'en' ? /Edit request for retry/ : /요청 다시 작성/);
  }
});

test('fallback session titles localize while user titles and agent names remain intact', () => {
  const session = { title: '' } as Session;
  setLanguage('en');
  assert.equal(sessionTitle(session), 'Untitled session');
  assert.equal(sessionTitle({ ...session, customTitle: '제목 없는 세션' }), '제목 없는 세션');
  assert.equal(sessionTitle({ ...session, agentName: '작업 중' }), '작업 중');
  setLanguage('ko');
  assert.equal(sessionTitle(session), '제목 없는 세션');
});

test('known runtime error templates translate in either direction without changing filenames or native details', () => {
  setLanguage('en');
  assert.equal(translateMessage('폴더 그룹을 저장하지 못했습니다: EACCES'), 'Could not save the folder group: EACCES');
  assert.equal(translateMessage('실패한 작업만 지울 수 있습니다.'), 'Only failed tasks can be dismissed.');
  assert.equal(translateMessage('Codex thread/resume 응답을 확인하지 못했습니다. 요청을 다시 보내지 않았습니다. 원래 앱에서 확인하세요.'), 'Could not confirm the Codex thread/resume response. The request was not resent. Check the original app.');
  const original = '원본 report.pdf: 파일 하나는 10 MB 이하여야 합니다.';
  const english = translateMessage(original);
  assert.equal(english, '원본 report.pdf: each file must be 10 MB or smaller.');
  assert.equal(translateMessage('제목을 저장하지 못했습니다: 오류 원본\nEACCES /사용자/폴더'), 'Could not save the title: 오류 원본\nEACCES /사용자/폴더');
  const unknown = '사용자가 쓴 원문: 파일 크기 10 MB / provider native error';
  assert.equal(translateMessage(unknown), unknown);
  assert.equal(translateMessage(''), '');
  setLanguage('ko');
  assert.equal(translateMessage(english), original);
  assert.equal(translateMessage('Claude Code CLI was not found in PATH.'), 'PATH에서 Claude Code CLI를 찾을 수 없습니다.');
  assert.equal(translateMessage('Invalid model. Choose a valid provider model.'), '모델이 올바르지 않습니다. 유효한 도구 모델을 선택하세요.');
  assert.equal(translateMessage('Codex could not apply the selected model. No message was submitted.'), 'Codex가 선택한 모델을 적용하지 못했습니다. 메시지를 보내지 않았습니다.');
});

test('approval denial, initialization and cancellation errors explain the same outcome in both languages', () => {
  const cases = [
    ['This permission request is no longer pending. Refresh the conversation.', '이 권한 요청은 더 이상 대기 중이 아닙니다. 대화를 새로고침하세요.'],
    ['This approval is no longer pending. Refresh the conversation.', '이 승인 요청은 더 이상 대기 중이 아닙니다. 대화를 새로고침하세요.'],
    ['Claude Code did not initialize its permission connection. No instruction was submitted.', 'Claude Code의 권한 연결 초기화가 완료되지 않았습니다. 요청을 보내지 않았습니다.'],
    ['Could not confirm Codex cancellation. The owned process was stopped; check the native conversation before retrying.', 'Codex 취소를 확인하지 못했습니다. 이 앱에서 시작한 프로세스는 중지했습니다. 다시 시도하기 전에 원래 대화를 확인하세요.'],
    ['Permission was denied for: Bash, mcp__github__pull_request. The instruction could not complete with the current permissions.', 'Bash, mcp__github__pull_request 권한이 거절되었습니다. 현재 권한으로 요청을 완료할 수 없습니다.'],
    ['Codex did not acknowledge turn/start within 15 seconds.', 'Codex가 15초 안에 turn/start 요청을 확인하지 않았습니다.'],
    ['EPIPE /사용자/경로\n{"method":"turn/start"} Codex may have received the request. It was not resent automatically; check the native conversation before retrying.', 'EPIPE /사용자/경로\n{"method":"turn/start"} Codex가 요청을 받았을 수 있습니다. 자동으로 다시 보내지 않았습니다. 다시 시도하기 전에 원래 대화를 확인하세요.'],
  ];
  for (const [en, ko] of cases) {
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
    setLanguage('en'); assert.equal(translateMessage(ko), en);
  }
});

test('known unsupported interactions localize the complete explanation while keeping the native method exact', () => {
  const reasons = [
    'The request does not belong to this monitored turn.',
    'This request does not offer both a one-time approval and a supported denial. Use the native app to review it.',
    'Codex did not provide the exact command or terminal input for review. Continue in the native app.',
    'Codex did not provide the file changes for review. Continue in the native app.',
    'Codex requested an unsupported permission profile.',
    'Continue in the native Codex app for this interaction.',
  ];
  const method = 'item/permissions/requestApproval';
  for (const reason of reasons) {
    const en = `Codex requested an unsupported interaction (${method}). ${reason}`;
    setLanguage('ko');
    const ko = translateMessage(en);
    assert.ok(ko.startsWith(`Codex가 요청한 상호작용(${method})은 이 앱에서 지원하지 않습니다.`));
    assert.equal(ko.includes(reason), false, 'the application explanation must also be translated');
    setLanguage('en'); assert.equal(translateMessage(ko), en);
  }
});

test('approval localization does not match partial errors or alter native transcript content', () => {
  const denied = 'Permission was denied for: Bash. The instruction could not complete with the current permissions.';
  const unknown = [
    `The model said: ${denied}`,
    `${denied} Native follow-up text.`,
    'Codex requested an unsupported interaction (custom/native). Unknown native explanation.',
    'Native permission_denials: [{"tool_name":"Bash","input":{"command":"gh pr view 1"}}]',
  ];
  for (const language of ['ko', 'en'] as const) {
    setLanguage(language);
    for (const text of unknown) assert.equal(translateMessage(text), text);
    const messages = [{ id: 'native', role: 'assistant' as const, timestamp: '2026-09-15T00:00:00Z', text: denied }];
    const transcript = renderToStaticMarkup(createElement(ChatTranscript, { messages }));
    assert.ok(transcript.includes(denied), 'even a known error stays verbatim inside a native message');
  }
});

test('Auto Prompt admission, validation and native failures translate in both directions', () => {
  const cases = [
    ['선택한 Codex 계정에서 라우팅 모델 GPT Sol을 사용할 수 없습니다.', 'The routing model GPT Sol is unavailable for the selected Codex account.'],
    ['Auto Prompt 요청 ID가 올바르지 않습니다.', 'Invalid Auto Prompt request ID.'],
    ['취소 요청 본문은 비워 두세요.', 'Leave the cancellation request body empty.'],
    ['이미 실행 대상으로 전달된 요청입니다. 세션의 작업 중지 기능을 사용하세요.', 'This request has already been handed off for execution. Use the session controls to stop the task.'],
    ['선택한 세션은 인접 작업에 재사용할 수 없습니다. 컨텍스트 사용률이 확인된 30% 이하의 대기 세션이 필요합니다.', 'The selected session cannot be reused for an adjacent task. Choose an idle session with confirmed context usage of 30% or less.'],
    ['Auto Prompt: 라우팅 시간이 초과되었습니다. 작업을 보내지 않았습니다.', 'Auto Prompt: native routing timed out. No task was dispatched.'],
    ['Auto Prompt: Codex가 올바르지 않은 형식의 선택 결과를 반환했습니다.', 'Auto Prompt: Codex returned malformed structured output.'],
    ['Auto Prompt: Claude Code가 올바른 선택 결과를 반환하지 않았습니다. 해당 CLI의 로그인과 모델 접근 권한을 확인하세요.', 'Auto Prompt: Claude Code did not return a successful structured decision. Check native sign-in and model access.'],
  ];
  for (const [ko, en] of cases) {
    setLanguage('en'); assert.equal(translateMessage(ko), en);
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
  }
});

test('Auto Prompt provider error templates preserve native provider names in either language', () => {
  for (const provider of ['Claude Code', 'Codex']) {
    const ko = `${provider}를 사용할 수 없습니다. 설치와 로그인을 확인하세요.`;
    const en = `${provider} is unavailable. Check its installation and sign-in.`;
    setLanguage('en'); assert.equal(translateMessage(ko), en);
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
    const missing = `Auto Prompt: ${provider} CLI was not found. Install and sign in to the native CLI first.`;
    const localized = `Auto Prompt: ${provider} CLI를 찾을 수 없습니다. 먼저 해당 CLI를 설치하고 로그인하세요.`;
    assert.equal(translateMessage(missing), localized);
    setLanguage('en'); assert.equal(translateMessage(localized), missing);
  }
  for (const provider of ['claude', 'codex']) {
    const en = `Auto Prompt: native ${provider} routing exited unsuccessfully. Check native sign-in, model access, and CLI compatibility.`;
    const ko = `Auto Prompt: ${provider} 라우팅이 정상적으로 종료되지 않았습니다. 해당 CLI의 로그인, 모델 접근 권한과 호환성을 확인하세요.`;
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
    setLanguage('en'); assert.equal(translateMessage(ko), en);
  }
});

test('Claude routing diagnostics preserve event identifiers and legacy errors in both languages', () => {
  for (const identifier of ['system/thinking_tokens', 'system/future_event.v2', 'unknown']) {
    const en = `Auto Prompt: Claude Code returned an unsupported routing event (${identifier}).`;
    const ko = `Auto Prompt: Claude Code가 지원하지 않는 라우팅 이벤트를 반환했습니다 (${identifier}).`;
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
    setLanguage('en'); assert.equal(translateMessage(ko), en);
    for (const language of ['ko', 'en'] as const) {
      setLanguage(language);
      for (const partial of [`The model said: ${en}`, `${en} Native follow-up text.`]) assert.equal(translateMessage(partial), partial);
      const messages = [{ id: 'native', role: 'assistant' as const, timestamp: '2026-09-16T00:00:00Z', text: en }];
      const transcript = renderToStaticMarkup(createElement(ChatTranscript, { messages }));
      assert.ok(transcript.includes(en), 'a native conversation retains the exact diagnostic text');
    }
  }
  const legacyEn = 'Auto Prompt: Claude Code returned an unsupported routing event.';
  const legacyKo = 'Auto Prompt: Claude Code가 지원하지 않는 라우팅 이벤트를 반환했습니다.';
  setLanguage('ko'); assert.equal(translateMessage(legacyEn), legacyKo);
  setLanguage('en'); assert.equal(translateMessage(legacyKo), legacyEn);
});

test('Auto Prompt localization leaves model reasons, partial errors and unknown native text untouched', () => {
  const nativeReason = 'Auto Prompt: Codex 세션에서 src/편집기.ts 작업을 이어갑니다. Model: gpt-5.6-sol.';
  const unknown = [
    nativeReason,
    'Auto Prompt: Unknown native diagnostic: {"model":"gpt-5.6-sol"}',
    'The model said: Auto Prompt: native routing timed out. No task was dispatched.',
    'Auto Prompt: Codex CLI was not found. Install and sign in to the native CLI first. Native follow-up text.',
    'Auto Prompt: native codex routing exited unsuccessfully.',
  ];
  for (const language of ['ko', 'en'] as const) {
    setLanguage(language);
    for (const message of unknown) assert.equal(translateMessage(message), message);
  }
});

test('structured approval validation errors localize without altering field identifiers', () => {
  const cases = [
    ['Answer every question before submitting.', '제출하기 전에 모든 질문에 답변하세요.'],
    ['Answer the required field: native_field.', '필수 항목에 답변하세요: native_field.'],
    ['Enter a valid integer within the allowed range for native_count.', 'native_count에 허용 범위 내의 올바른 integer 값을 입력하세요.'],
    ['Enter a valid email for native_email.', 'native_email에 올바른 email 값을 입력하세요.'],
  ];
  for (const [en, ko] of cases) {
    setLanguage('ko'); assert.equal(translateMessage(en), ko);
    setLanguage('en'); assert.equal(translateMessage(ko), en);
  }
});

test('steering controls expose only eligible sends and never offer uncertain delivery retries', () => {
  setLanguage('ko');
  const run: Run = { id: 'queued', sessionId: 's', prompt: '추가 요청', createdAt: '2026-09-17T00:00:00Z', status: 'queued', output: '' };
  const render = (value: Run) => renderToStaticMarkup(createElement(RunControl, { run: value, onCancel() {}, onRetry() {}, onSteer() {}, onDismiss() {}, cancelling: false }));
  assert.doesNotMatch(render(run), /지금 끼워넣기/);
  assert.match(render({ ...run, canSteer: true }), /지금 끼워넣기/);
  const steering: NonNullable<Run['steering']> = { targetRunId: 'active', state: 'delivered', requestedAt: run.createdAt };
  const delivered = render({ ...run, status: 'running', steering });
  assert.match(delivered, /현재 작업에 전달됨/);
  assert.doesNotMatch(delivered, /<button/);
  const uncertain = render({ ...run, status: 'error', steering: { ...steering, state: 'uncertain' } });
  assert.match(uncertain, /전달 여부 확인 필요/);
  assert.match(uncertain, /실패 내역 지우기/);
  assert.doesNotMatch(uncertain, /요청 다시 작성|지금 끼워넣기/);
  assert.equal(render({ ...run, status: 'completed', steering }), '');
});

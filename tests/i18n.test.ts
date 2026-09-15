import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { detectLanguage, getLanguage, setLanguage, translate, translateMessage } from '../client/src/i18n.js';
import { absoluteTime, relativeTime, sessionTitle, statusLabels } from '../client/src/lib.js';
import { ChatTranscript, RunControl } from '../client/src/ChatPanel.js';
import type { Run, Session } from '../shared/types.js';

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

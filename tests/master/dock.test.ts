import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dockLayout } from '../../client/src/master/dock-layout.js';
import { atEnd, missedText, VoiceBar, type VoiceControls } from '../../client/src/master/VoiceBar.js';
import { OpenChatButton } from '../../client/src/master/OpenChatButton.js';
import { setLanguage } from '../../client/src/i18n/i18n.js';
import type { VoiceView } from '../../client/src/master/voice-client.js';

const layout = (change: Partial<Parameters<typeof dockLayout>[0]> = {}) => dockLayout({ conversationOpen: false, voiceOn: false, ended: false, panelOpen: false, hasSession: true, ...change });
const state = (change: Partial<Parameters<typeof dockLayout>[0]> = {}) => { const { button, side } = layout(change); return { button, side }; };

test('by default only the button shows; opening the conversation slides out the microphone and settings, nothing else', () => {
  assert.deepEqual(state(), { button: 'toggle', side: null });
  assert.deepEqual(state({ conversationOpen: true }), { button: 'toggle', side: 'tray' });
});

test('with voice on the button ends voice and the live voice bar shows, the conversation open or not', () => {
  assert.deepEqual(state({ voiceOn: true }), { button: 'end-voice', side: 'voice' });
  assert.deepEqual(state({ voiceOn: true, conversationOpen: true }), { button: 'end-voice', side: 'voice' });
  // Ended by the owner, voice leaves the conversation as it was: the icons come back while it is open.
  assert.deepEqual(state({ conversationOpen: true }), { button: 'toggle', side: 'tray' });
});

test('voice that ended by itself says why in place of the icons, and the master\'s panel covers everything beside the button', () => {
  assert.deepEqual(state({ ended: true }), { button: 'toggle', side: 'ended' });
  assert.deepEqual(state({ ended: true, conversationOpen: true }), { button: 'toggle', side: 'ended' }, 'never the icons over the notice');
  assert.deepEqual(state({ panelOpen: true, conversationOpen: true }), { button: 'toggle', side: null });
  assert.deepEqual(state({ panelOpen: true, voiceOn: true }), { button: 'end-voice', side: null });
});

test('with voice on and the conversation closed, the voice bar offers to open it again; nowhere else', () => {
  assert.equal(layout({ voiceOn: true }).reopen, true, 'the button ends voice then, so this is the way back');
  assert.equal(layout({ voiceOn: true, conversationOpen: true }).reopen, false);
  assert.equal(layout({ voiceOn: true, hasSession: false }).reopen, false, 'no conversation to open yet');
  assert.equal(layout({ voiceOn: true, panelOpen: true }).reopen, false);
  assert.equal(layout().reopen, false, 'without voice the button itself opens it');
  assert.equal(layout({ ended: true }).reopen, false);
  assert.equal(layout({ conversationOpen: true }).reopen, false);
});

test('the open-chat button is labelled and names its shortcut', () => {
  setLanguage('ko');
  const html = renderToStaticMarkup(createElement(OpenChatButton, { onOpen() {} }));
  assert.match(html, /^<button[^>]*aria-label="마스터 채팅 열기"/);
  assert.match(html, /title="마스터 채팅 열기 \(Shift\+M\)"/);
  assert.match(html, /aria-keyshortcuts="Shift\+M"/);
  setLanguage('en');
  assert.match(renderToStaticMarkup(createElement(OpenChatButton, { onOpen() {} })), /aria-label="Open master chat"/);
  setLanguage('ko');
});

test('what is heard follows its latest words only while it is scrolled to its end', () => {
  assert.equal(atEnd({ scrollTop: 100, scrollHeight: 160, clientHeight: 60 }), true);
  assert.equal(atEnd({ scrollTop: 95, scrollHeight: 160, clientHeight: 60 }), true, 'a few pixels short still follows');
  assert.equal(atEnd({ scrollTop: 40, scrollHeight: 160, clientHeight: 60 }), false, 'scrolled up to read earlier words');
  assert.equal(atEnd({ scrollTop: 0, scrollHeight: 60, clientHeight: 60 }), true);
});

const controls = (view: VoiceView | null, change: Partial<VoiceControls> = {}): VoiceControls => ({
  view, ended: null, status: { session: 's', today: { dollars: 0.12, sttSeconds: 30, ttsChars: 400 } } as unknown as VoiceControls['status'],
  start() {}, stop() {}, listen() {}, mute() {}, skip() {}, replayMissed() {}, dismissMissed() {}, finish() {}, discard() {}, dismiss() {}, ...change,
});
const render = (voice: VoiceControls) => renderToStaticMarkup(createElement(VoiceBar, { voice }));

test('the voice bar mutes and unmutes the microphone, and has no button to turn voice off', () => {
  setLanguage('ko');
  const listening = render(controls({ listening: true, capturing: false }));
  assert.match(listening, /마이크 뮤트/);
  assert.doesNotMatch(listening, /음성 끄기|듣기 끄기/);
  assert.match(listening, /오늘 \$0\.12/, 'today\'s use shows while voice is on');
  const muted = render(controls({ listening: false, capturing: false, muted: true }));
  assert.match(muted, /뮤트 해제/);
  assert.match(muted, /마이크 뮤트됨/);
  assert.doesNotMatch(muted, /음성 끄기/);
  assert.match(render(controls({ listening: false, capturing: false })), /다시 듣기/, 'listening that stopped by itself is not called muted');
});

test('speech being written down shows with a caret, in a taller box', () => {
  setLanguage('ko');
  const html = render(controls({ listening: true, capturing: true, heard: '긴 말 '.repeat(80) }));
  assert.match(html, /master-voice-caret/);
  assert.match(html, /master-voice live speaking long/);
  assert.doesNotMatch(render(controls({ listening: true, capturing: false, heard: '들은 말' })), /master-voice-caret/);
});

test('where the master\'s panel covers the button, its voice bar ends voice itself', () => {
  setLanguage('ko');
  assert.match(render(controls({ listening: true, capturing: false }, { end() {} })), /음성 대화 끝내기/);
  assert.doesNotMatch(render(controls({ listening: true, capturing: false })), /음성 대화 끝내기/);
});

test('an unsent draft keeps the taller box', () => {
  setLanguage('ko');
  assert.match(render(controls({ listening: true, capturing: false, draft: '보내지 않은 말' })), /master-voice live  long/);
});

test('an answer not read aloud is told of beside the voice, with hearing it again unless there is nothing to hear', () => {
  setLanguage('ko');
  const replayed: string[] = [];
  const status = (missed: NonNullable<VoiceControls['status']>['missed']) => ({ status: { session: 's', today: { dollars: 0, sttSeconds: 0, ttsChars: 0 }, limitDollars: 0, listening: true, limited: false, missed } as VoiceControls['status'], replayMissed: (entry: string) => replayed.push(entry) });
  const cut = render(controls({ listening: true, capturing: false }, status({ entry: 'e1', reason: 'failed', heard: true, text: '확인이 필요한 작업이 여럿 있어요.' })));
  assert.match(cut, /답을 끝까지 읽지 못했어요 · 재생이 끊겼어요/);
  assert.match(cut, /답 다시 듣기/);
  assert.match(render(controls({ listening: true, capturing: false }, status({ entry: 'e2', reason: 'blocked', text: '답' }))), /답을 소리로 읽지 못했어요 · 브라우저가 소리 재생을 막았어요/);
  const empty = render(controls({ listening: true, capturing: false }, status({ entry: 'e3', reason: 'empty', text: '---' })));
  assert.match(empty, /읽을 내용이 없어 소리로 읽지 않았어요/);
  assert.doesNotMatch(empty, /답 다시 듣기/);
  assert.doesNotMatch(render(controls({ listening: true, capturing: false, playing: { kind: 'answer', text: '다른 답' } }, status({ entry: 'e1', reason: 'failed', text: '답' }))), /읽지 못했어요/, 'not while something plays');
  assert.equal(missedText({ entry: 'e', reason: 'away', text: '' }, (ko: string) => ko), '답을 소리로 읽지 못했어요 · 음성이 켜진 페이지가 없었어요');
});

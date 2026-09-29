import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dockLayout } from '../../client/src/master/dock-layout.js';
import { atEnd, VoiceBar, type VoiceControls } from '../../client/src/master/VoiceBar.js';
import { setLanguage } from '../../client/src/i18n/i18n.js';
import type { VoiceView } from '../../client/src/master/voice-client.js';

const state = (change: Partial<Parameters<typeof dockLayout>[0]> = {}) => dockLayout({ conversationOpen: false, voiceOn: false, ended: false, panelOpen: false, ...change });

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

test('what is heard follows its latest words only while it is scrolled to its end', () => {
  assert.equal(atEnd({ scrollTop: 100, scrollHeight: 160, clientHeight: 60 }), true);
  assert.equal(atEnd({ scrollTop: 95, scrollHeight: 160, clientHeight: 60 }), true, 'a few pixels short still follows');
  assert.equal(atEnd({ scrollTop: 40, scrollHeight: 160, clientHeight: 60 }), false, 'scrolled up to read earlier words');
  assert.equal(atEnd({ scrollTop: 0, scrollHeight: 60, clientHeight: 60 }), true);
});

const controls = (view: VoiceView | null, change: Partial<VoiceControls> = {}): VoiceControls => ({
  view, ended: null, status: { session: 's', today: { dollars: 0.12, sttSeconds: 30, ttsChars: 400 } } as unknown as VoiceControls['status'],
  start() {}, stop() {}, listen() {}, mute() {}, skip() {}, replay() {}, finish() {}, discard() {}, dismiss() {}, ...change,
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

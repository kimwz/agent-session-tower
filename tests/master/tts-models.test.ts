import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MASTER_SETTINGS, DEFAULT_MASTER_VOICE, MASTER_TTS_MODELS } from '../../shared/master.js';
import { mergeSettings } from '../../server/master/settings.js';
import { ttsDollarsPerChar, ttsModel } from '../../server/master/tts-models.js';
import { speakable, voiced, voicedChunkPairs, voicedPartPairs } from '../../server/master/voice-text.js';

test('Eleven v4 Turbo is the default, read through Text to Dialogue, with tags, at v3 conversational\'s price', () => {
  assert.equal(DEFAULT_MASTER_VOICE.model, 'eleven_v4_turbo');
  assert.equal(MASTER_TTS_MODELS[0], DEFAULT_MASTER_VOICE.model);
  assert.deepEqual(ttsModel('eleven_v4_turbo'), { tags: true, dollarsPerChar: 0.05 / 1000, request: 'dialogue' });
  assert.equal(ttsDollarsPerChar('eleven_v4_turbo'), ttsDollarsPerChar('eleven_v3_conversational'));
  // The models before it keep their request, tags and price.
  assert.deepEqual(ttsModel('eleven_v3_conversational'), { tags: true, dollarsPerChar: 0.05 / 1000, request: 'speech' });
  assert.deepEqual(ttsModel('eleven_v3'), { tags: true, dollarsPerChar: 0.1 / 1000, request: 'speech' });
  assert.deepEqual(ttsModel('eleven_flash_v2_5'), { tags: false, dollarsPerChar: 0.05 / 1000, request: 'speech' });
  // A model an old usage record names, or none: the lower price, no tags.
  assert.deepEqual(ttsModel('eleven_multilingual_v2'), { tags: false, dollarsPerChar: 0.05 / 1000, request: 'speech' });
  assert.equal(ttsDollarsPerChar(''), 0.05 / 1000);
  assert.equal(ttsModel('toString').tags, false, 'only the models themselves');
});

test('Eleven v4 Turbo is told the tone as v3 was, short Korean included, and reads brackets in the text as words', () => {
  const model = 'eleven_v4_turbo';
  assert.equal(voiced('네.', model, 'ack'), '[cheerfully] 네.');
  assert.equal(voiced('알겠어요.', model, 'answer'), '[cheerfully] 알겠어요.');
  assert.equal(voiced('배포까지 끝났어요!', model, 'report'), '[excited] 배포까지 끝났어요!');
  assert.equal(voiced('테스트가 실패했어요.', model, 'report'), '테스트가 실패했어요.');
  assert.equal(voiced('세션을 닫습니다.', model, 'notice'), '세션을 닫습니다.');
  assert.equal(voiced('[WIP] 브랜치 두 개예요.', model, 'answer'), '[cheerfully] (WIP) 브랜치 두 개예요.');
});

test('every part sent to Text to Dialogue stays within the 2,000 characters a request is reliable up to', () => {
  const answer = Array.from({ length: 400 }, (_, index) => `${index + 1}번째 문장은, 쉼표와 띄어쓰기 없이도${'아주'.repeat(index % 7 === 0 ? 400 : 3)} 길게 이어질 수 있습니다.`).join(' ');
  for (const parts of [voicedPartPairs(speakable(answer), 'eleven_v4_turbo', 'answer'), voicedChunkPairs(speakable(answer), 'eleven_v4_turbo', '[cheerfully]')]) {
    assert.ok(parts.length > 1);
    const longest = Math.max(...parts.map(part => part.speech.length));
    assert.ok(longest <= 2_000, `longest part ${longest}`);
  }
});

test('the settings take Eleven v4 Turbo, and models saved before it still load as they were', () => {
  const chosen = mergeSettings(DEFAULT_MASTER_SETTINGS, { voice: { model: 'eleven_v4_turbo' } });
  assert.equal(chosen.voice.model, 'eleven_v4_turbo');
  for (const model of ['eleven_v3_conversational', 'eleven_v3', 'eleven_flash_v2_5']) {
    const saved = mergeSettings(DEFAULT_MASTER_SETTINGS, { voice: { ...DEFAULT_MASTER_VOICE, voiceId: 'NaQdbkW5gNZD8wfwXeTV', model } }, true);
    assert.equal(saved.voice.model, model);
    assert.equal(saved.voice.voiceId, 'NaQdbkW5gNZD8wfwXeTV');
  }
  // Changing only the model keeps the chosen voice.
  const owner = mergeSettings(DEFAULT_MASTER_SETTINGS, { voice: { ...DEFAULT_MASTER_VOICE, voiceId: 'NaQdbkW5gNZD8wfwXeTV', model: 'eleven_v3_conversational', playbackRate: 1.2 } }, true);
  assert.deepEqual(mergeSettings(owner, { voice: { model: 'eleven_v4_turbo' } }).voice, { ...owner.voice, model: 'eleven_v4_turbo' });
  assert.throws(() => mergeSettings(DEFAULT_MASTER_SETTINGS, { voice: { model: 'eleven_v4' } }), { kind: 'invalid' }, 'only the models offered');
});

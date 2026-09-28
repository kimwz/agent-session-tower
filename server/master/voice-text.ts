/** Short things the master says at once, recorded the first time they are needed and played from then on. */
export const VOICE_ACKS = ['네, 확인해 볼게요.', '네, 알아볼게요.', '잠시만요, 볼게요.'] as const;
/** Said, without ending what is being said, when the owner pauses long in the middle of it. */
export const VOICE_NUDGE = '계속 말씀하세요, 듣고 있어요.';
/** Said once when a spoken request takes a while. */
export const VOICE_WORKING = '아직 하고 있어요. 끝나면 말씀드릴게요.';

/**
 * What speech-to-text is known to write for noise or silence rather than for anything said, compared without spaces
 * or punctuation.
 */
const NOISE = ['감사합니다', '고맙습니다', '시청해주셔서감사합니다', '구독과좋아요부탁드립니다', '좋아요와구독부탁드립니다', '구독좋아요알림설정부탁드립니다'];

/** Whether a transcript is noise, not a request: under two characters once bracketed sounds go, or a known phantom. */
export function isNoise(text: string): boolean {
  const spoken = text.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const bare = spoken.replace(/[\s.,!?~…·'"“”‘’-]+/g, '').toLowerCase();
  return bare.length < 2 || NOISE.includes(bare);
}

/**
 * ElevenLabs v3 audio tags that set how a sentence is read, never read aloud themselves. `[excited]` is one of
 * ElevenLabs' documented tags; `[cheerfully]` is a descriptive one, which v3 also follows. Measured on the owner's
 * voice with eleven_v3_conversational: `[excited]` raised the pitch about 1.6 semitones and read a little faster.
 */
export const VOICE_TONES = { bright: '[cheerfully]', excited: '[excited]' } as const;
/** Models that follow audio tags; any other model would read a tag out as words. */
const TAGGED_MODELS = new Set(['eleven_v3', 'eleven_v3_conversational']);
/** Failures, warnings, apologies, loss, health: said in the voice's own calm tone, never cheerfully. */
const SERIOUS = /실패|오류|에러|못\s?했|못\s?합|못\s?해|안\s?돼|안\s?됩|문제|장애|위험|경고|주의|보안|유출|비밀|삭제|지웠|지울|되돌릴|취소|중단|멈췄|멈춰|막혔|거부|충돌|손실|사고|긴급|죄송|미안|사과|아프|병원|사망|슬프|걱정|우려|확인이 필요|error|fail|denied/i;
/** Clear good news, which may sound a little excited. */
const GOOD_NEWS = /완료|끝났|끝냈|마쳤|성공|해결|통과|배포했|배포됐|올렸|반영됐|됐어요|됐습니다|축하|좋은 소식|잘 됐|잘 돼/;

/**
 * The text sent to speech for something the master says: a tone tag in front, for models that follow tags. A
 * sentence before an irreversible change, a failure, and anything serious keep the plain voice; clear good news
 * sounds excited; the rest is bright. Brackets already in the text become parentheses so they are read, not taken
 * as directions. The tag is only in what is synthesized: what the page shows and the conversation keep the text.
 */
export function voiced(text: string, model: string, kind: 'answer' | 'report' | 'error' | 'notice' | 'ack'): string {
  if (!TAGGED_MODELS.has(model)) return text;
  const plain = text.replace(/\[/g, '(').replace(/\]/g, ')');
  if (kind === 'notice' || kind === 'error' || SERIOUS.test(plain)) return plain;
  return `${kind !== 'ack' && GOOD_NEWS.test(plain) ? VOICE_TONES.excited : VOICE_TONES.bright} ${plain}`;
}

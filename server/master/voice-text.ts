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

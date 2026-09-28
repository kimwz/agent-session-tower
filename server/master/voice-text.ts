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
 * The tone tag for something the master says, for models that follow tags: none before an irreversible change, for
 * a failure, or for anything serious; excited for clear good news; bright otherwise. Judged on the whole text.
 */
function tone(plain: string, model: string, kind: VoiceKind): string {
  if (!TAGGED_MODELS.has(model) || kind === 'notice' || kind === 'error' || SERIOUS.test(plain)) return '';
  return kind !== 'ack' && GOOD_NEWS.test(plain) ? VOICE_TONES.excited : VOICE_TONES.bright;
}
type VoiceKind = 'answer' | 'report' | 'error' | 'notice' | 'ack';
/** Brackets already in the text become parentheses on tagged models, so they are read, not taken as directions. */
const untagged = (text: string, model: string) => TAGGED_MODELS.has(model) ? text.replace(/\[/g, '(').replace(/\]/g, ')') : text;

/**
 * The text sent to speech for something the master says: a tone tag in front, for models that follow tags. The tag
 * sets how it is read, never how much of it is read, and is only in what is synthesized: what the page shows and the
 * conversation keep the text.
 */
export function voiced(text: string, model: string, kind: VoiceKind): string {
  const plain = untagged(text, model);
  const tag = tone(plain, model, kind);
  return tag ? `${tag} ${plain}` : plain;
}

/** Said at the end when an answer is too long to read whole: what was read ends at a sentence. */
export const VOICE_REST = '나머지는 화면에 있어요.';
/** At most this much of an answer is read aloud, about ten minutes. */
export const READ_CHARS = 5_000;
/** The first part is short so its sound starts soon; the rest go in parts of whole sentences up to this long. */
const FIRST_PART = 120;
const PART = 500;

/**
 * An answer as it is heard: all of it, in order, without markdown. Each line and list item becomes a sentence, a
 * table's cells are read across, a link is read by its words; code, bare addresses and pictographs, which cannot be
 * said, are pointed to or left out.
 */
export function speakable(text: string): string {
  const lines = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s)>]+>?/g, '링크')
    .replace(/<\/?[a-zA-Z][\w-]*(\s[^<>]*)?\/?>/g, ' ')
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .split('\n');
  const said: string[] = [];
  // A code block is pointed to once. It opens with a line of three or more backticks or tildes (backticks not
  // repeated after them), and closes only with a line of the same mark, at least as long, and nothing else.
  let fence = '';
  for (const raw of lines) {
    if (fence) { if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(raw)) fence = ''; continue; }
    const open = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(raw);
    if (open) { fence = open[1]; said.push('코드는 화면에 있어요.'); continue; }
    // A table's divider row says nothing.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue;
    let line = raw.trim().replace(/^#{1,6}\s+/, '').replace(/^(>\s*)+/, '').replace(/^[-*+•]\s+/, '').replace(/^(\[[ xX]\])\s+/, '');
    // A table row starts with a bar or has several; a bar in a sentence is read as it is.
    if (line.startsWith('|') || (line.match(/\|/g)?.length ?? 0) >= 2) line = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()).filter(Boolean).join(', ');
    line = line.replace(/\*\*|__|~~|`/g, '').replace(/\*(?!\s?\d)|(?<!\d\s?)\*/g, '').replace(/(\w)_(?=\w)/g, '$1 ').replace(/_/g, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    said.push(/[.!?…。:;]["'”’)]*$/.test(line) ? line : `${line}.`);
  }
  return said.join(' ');
}

/** Sentences of spoken text, each with the space after it, so that joined they are the text again. */
function sentences(text: string): string[] {
  // A sentence ends at its mark and the space after it: "1.5" goes on, and a list's number stays with its item.
  const found = text.match(/[\s\S]*?(?:[.!?…。]+["'”’)]*(?:\s+|$)|$)/g)?.filter(Boolean) ?? [];
  const out: string[] = [];
  for (const item of found) {
    if (out.length && /^\s*\d{1,3}[.)]\s*$/.test(out[out.length - 1])) out[out.length - 1] += item;
    else out.push(item);
  }
  return out;
}
/** A sentence longer than a part is broken after a comma or a space, or cut only when it has neither. */
function pieces(sentence: string, limit: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    const comma = head.lastIndexOf(', ');
    const space = head.lastIndexOf(' ');
    const cut = comma > limit / 3 ? comma + 2 : space > limit / 3 ? space + 1 : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * What is sent to speech for an answer, part by part: whole sentences, in order, each part with the answer's tone
 * tag in front (a tag holds only within the text it is sent with). Nothing is repeated or dropped between parts.
 * Past `READ_CHARS` the reading ends at a sentence and says the rest is on the screen.
 */
export function voicedParts(text: string, model: string, kind: VoiceKind): string[] {
  const plain = untagged(text, model).trim();
  if (!plain) return [];
  const tag = tone(plain, model, kind);
  const parts: string[] = [];
  let part = '';
  let total = 0;
  let cut = false;
  for (const sentence of sentences(plain)) {
    // Past the limit, reading ends before the sentence that would pass it; only a first sentence longer than the
    // limit is read up to it, and then ends at a space.
    if (total + sentence.length > READ_CHARS && total > 0) { cut = true; break; }
    for (const piece of pieces(sentence, PART)) {
      if (total + piece.length > READ_CHARS) { cut = true; break; }
      total += piece.length;
      const limit = parts.length ? PART : FIRST_PART;
      if (part && part.length + piece.length > limit) { parts.push(part); part = ''; }
      part += piece;
    }
    if (cut) break;
  }
  if (cut) part += (part && !/\s$/.test(part) ? ' ' : '') + VOICE_REST;
  if (part.trim()) parts.push(part);
  return parts.map(item => item.trim()).filter(Boolean).map(item => tag ? `${tag} ${item}` : item);
}

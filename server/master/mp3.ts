/**
 * mp3 helpers for audio read aloud: no state, no other module. 128 kbps is what ElevenLabs makes.
 */

/** mp3 at 128 kbps: bytes of audio a second, for starting again partway (see `serveAudio`). */
export const MP3_BYTES_PER_SECOND = 16_000;

/**
 * An mp3 stream without the ID3 tag it starts with. The parts of a long answer are made one after another into one
 * stream, and only the first part's tag may stand at its start.
 */
export async function* withoutTag(stream: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let head = Buffer.alloc(0);
  let skip = -1;
  for await (const chunk of stream) {
    if (skip < 0) {
      head = Buffer.concat([head, chunk]);
      if (head.length < 10) continue;
      // An ID3v2 header: "ID3", version, flags (0x10: a footer follows), then the tag's size in 7-bit bytes.
      skip = head.subarray(0, 3).toString('latin1') === 'ID3'
        ? 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)) + (head[5] & 0x10 ? 10 : 0)
        : 0;
      const rest = head.subarray(Math.min(skip, head.length));
      skip = Math.max(0, skip - head.length);
      if (rest.length) yield rest;
      continue;
    }
    if (skip >= chunk.length) { skip -= chunk.length; continue; }
    const rest = skip ? chunk.subarray(skip) : chunk;
    skip = 0;
    yield rest;
  }
  if (skip < 0 && head.length) yield head;
}

/** How many bytes the ID3v2 tag an mp3 starts with takes (0 without one). */
export function id3Size(data: Buffer): number {
  if (data.length < 10 || data.subarray(0, 3).toString('latin1') !== 'ID3') return 0;
  return 10 + (((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)) + (data[5] & 0x10 ? 10 : 0);
}

/** The first MPEG-1 layer III frame at or after `from` (its header, and the next frame's when it is there), or the end. */
export function frameAt(data: Buffer, from: number): number {
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44_100, 48_000, 32_000];
  const length = (at: number) => {
    if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1] & 0xfe) !== 0xfa) return 0;
    const bitrate = BITRATES[data[at + 2] >> 4];
    const rate = RATES[(data[at + 2] >> 2) & 3];
    if (!bitrate || !rate) return 0;
    return Math.floor(144_000 * bitrate / rate) + ((data[at + 2] >> 1) & 1);
  };
  for (let at = Math.max(0, from); at + 4 <= data.length; at++) {
    const size = length(at);
    if (!size) continue;
    if (at + size + 4 > data.length || length(at + size)) return at;
  }
  return data.length;
}

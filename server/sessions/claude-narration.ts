/**
 * Claude's narration: short summaries the server writes of what Claude says between tool calls, in place of that prose.
 * They arrive as `thinking` blocks, and only the block kind in the signature tells them from Claude's own reasoning,
 * which Tower does not show. Claude Code's terminal shows them, marked "summary"; Tower shows them as the agent's words.
 *
 * The signature is base64 of a protobuf envelope whose field 2 holds a message whose field 1 holds a message whose
 * field 8 is the block kind: "narration" or "thinking". Claude Code reads it the same way (and lists such blocks in
 * stream-json frames as `narration_block_indexes`). Anything that does not decode to exactly "narration" is reasoning.
 */
const NARRATION = 'narration';

/** The text to show for a narration block, or undefined for any other block (reasoning, an empty summary). */
export function narrationText(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const { type, thinking, signature } = block as Record<string, unknown>;
  if (type !== 'thinking' || typeof thinking !== 'string' || !thinking.trim() || typeof signature !== 'string') return undefined;
  return blockKind(signature) === NARRATION ? thinking : undefined;
}

function blockKind(signature: string): string | undefined {
  // Signatures are a few kilobytes; a far larger value is not one.
  if (!signature || signature.length > 1_000_000) return undefined;
  const bytes = Buffer.from(signature, 'base64');
  // Node skips what is not base64; the server writes canonical padded base64, so anything else is not its signature.
  if (bytes.toString('base64') !== signature) return undefined;
  const envelope = field(bytes, 2);
  const header = envelope && field(envelope, 1);
  const kind = header && field(header, 8);
  return kind?.toString('utf8');
}

/**
 * The first length-delimited field `number` of a protobuf message, or undefined when it is missing or the message is
 * malformed anywhere, after it too: a signature that does not decode cleanly says nothing about its kind.
 */
function field(message: Buffer, number: number): Buffer | undefined {
  let found: Buffer | undefined;
  let offset = 0;
  while (offset < message.length) {
    const key = varint(message, offset);
    // Field numbers run from 1 to 2^29 - 1, so a key is at least 8 and at most 2^32 - 1.
    if (!key || key.value < 8 || key.value > 0xffffffff) return undefined;
    offset = key.next;
    const wire = key.value % 8;
    if (wire === 0) { const value = varint(message, offset); if (!value) return undefined; offset = value.next; }
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint(message, offset);
      if (!length || length.next + length.value > message.length) return undefined;
      if (!found && Math.floor(key.value / 8) === number) found = message.subarray(length.next, length.next + length.value);
      offset = length.next + length.value;
    } else return undefined;
    if (offset > message.length) return undefined;
  }
  return found;
}

function varint(bytes: Buffer, start: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let index = start, shift = 0; index < bytes.length && shift < 49; index++, shift += 7) {
    value += (bytes[index] & 0x7f) * 2 ** shift;
    if (bytes[index] < 0x80) return { value, next: index + 1 };
  }
  return undefined;
}

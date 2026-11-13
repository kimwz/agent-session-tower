/**
 * A thinking block signature shaped as Claude's server writes it: base64 of 08 04 | 12 <envelope> where the envelope
 * starts with 0a <header> holding 08 13 18 02 38 01 42 <kind>, then the opaque payload (12 <bytes>).
 * The shape is taken from a real Claude Code 2.1.323 transcript; the payload here is filler.
 */
export function thinkingSignature(kind: string, payload = Buffer.alloc(40, 7)): string {
  const header = Buffer.concat([Buffer.from([0x08, 0x13, 0x18, 0x02, 0x38, 0x01, 0x42]), varint(kind.length), Buffer.from(kind)]);
  const envelope = Buffer.concat([Buffer.from([0x0a]), varint(header.length), header, Buffer.from([0x12]), varint(payload.length), payload]);
  return Buffer.concat([Buffer.from([0x08, 0x04, 0x12]), varint(envelope.length), envelope]).toString('base64');
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 127) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
  bytes.push(value);
  return Buffer.from(bytes);
}

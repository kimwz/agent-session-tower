import assert from 'node:assert/strict';
import test from 'node:test';
import { narrationText } from '../../../server/sessions/claude-narration.js';
import { thinkingSignature } from '../../helpers/claude-signature.ts';

test('a thinking block is narration only when its signature says so', () => {
  assert.equal(narrationText({ type: 'thinking', thinking: 'Waiting for both workers.', signature: thinkingSignature('narration') }), 'Waiting for both workers.');
  // The server's real envelopes are a kilobyte or more, so their lengths take several varint bytes.
  assert.equal(narrationText({ type: 'thinking', thinking: 'Long one.', signature: thinkingSignature('narration', Buffer.alloc(1200, 3)) }), 'Long one.');
  assert.equal(Buffer.from(thinkingSignature('narration', Buffer.alloc(1200, 3)), 'base64').subarray(0, 24).toString('hex'), '080412c6090a1108131802380142096e6172726174696f6e');
  assert.equal(narrationText({ type: 'thinking', thinking: 'Private reasoning.', signature: thinkingSignature('thinking') }), undefined);
});

test('anything that does not decode to narration is left out', () => {
  const narration = thinkingSignature('narration');
  for (const block of [
    { type: 'thinking', thinking: '   ', signature: narration },
    { type: 'thinking', thinking: 'No signature' },
    { type: 'thinking', thinking: 'Not base64', signature: 'not base64!' },
    { type: 'thinking', thinking: 'Cut short', signature: narration.slice(0, 32) },
    { type: 'thinking', thinking: 'Garbage', signature: Buffer.from('narration narration').toString('base64') },
    { type: 'thinking', thinking: 'Other kind', signature: thinkingSignature('narrationx') },
    // A well-formed kind followed by a broken field, at the top and inside the envelope.
    { type: 'thinking', thinking: 'Broken tail', signature: Buffer.concat([Buffer.from(narration, 'base64'), Buffer.from([0x1a, 0x02, 0xaa])]).toString('base64') },
    { type: 'thinking', thinking: 'Broken inner tail', signature: brokenEnvelope() },
    // Node would skip the stray character and decode the rest.
    { type: 'thinking', thinking: 'Not canonical base64', signature: thinkingSignature('narration', Buffer.alloc(41, 7)) + 'A' },
    { type: 'thinking', thinking: 'Unpadded', signature: thinkingSignature('narration', Buffer.alloc(42, 7)).replace(/=+$/, '') },
    // A field number above the protobuf maximum (2^29 - 1) after a well-formed kind.
    { type: 'thinking', thinking: 'Field number too large', signature: Buffer.concat([Buffer.from(narration, 'base64'), Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10, 0x00])]).toString('base64') },
    { type: 'redacted_thinking', data: 'x', signature: narration },
    { type: 'text', text: 'Plain text', signature: narration },
    null, 'narration',
  ]) assert.equal(narrationText(block), undefined, JSON.stringify(block));
});

/** A narration header followed, inside the envelope, by a field whose length runs past the envelope's end. */
function brokenEnvelope(): string {
  const header = Buffer.concat([Buffer.from([0x08, 0x13, 0x18, 0x02, 0x38, 0x01, 0x42, 9]), Buffer.from('narration')]);
  const envelope = Buffer.concat([Buffer.from([0x0a, header.length]), header, Buffer.from([0x12, 0x05, 0x01])]);
  return Buffer.concat([Buffer.from([0x08, 0x04, 0x12, envelope.length]), envelope]).toString('base64');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunApproval } from '../shared/types.js';
import { mcpFormUnsupportedReason, validateApprovalResponse } from '../shared/approval-interactions.js';

const base: RunApproval = { id: 'pending', toolName: 'interaction', input: {} };
const questions: RunApproval = { ...base, interaction: { type: 'questions', questions: [
  { id: 'choice', header: 'Scope', question: 'Choose', isOther: false, isSecret: false, options: [{ label: 'Local', description: 'Local only' }] },
  { id: 'secret', header: 'Key', question: 'Key', isOther: true, isSecret: true, options: null },
] } };
const validAnswers = { answers: { choice: { answers: ['Local'] }, secret: { answers: ['never-log-this'] } } };
const form = (schema: Record<string, unknown>): RunApproval => ({ ...base, interaction: { type: 'mcp-form', serverName: 'fixture', schema } });
const content = (content: Record<string, unknown> | null) => ({ action: 'accept', content });

test('question replies require the original IDs, valid choices, complete answers and exact shape', () => {
  const result = validateApprovalResponse(questions, validAnswers);
  assert.deepEqual(result, validAnswers); assert.notEqual(result, validAnswers);
  for (const reply of [
    'allow', {}, { answers: [] }, { answers: validAnswers.answers, extra: true },
    { answers: { ...validAnswers.answers, extra: { answers: ['unexpected'] } } },
    { answers: { choice: { answers: ['Local'] } } },
    { answers: { ...validAnswers.answers, choice: { answers: ['unlisted'] } } },
    { answers: { ...validAnswers.answers, choice: { answers: ['Local'], extra: true } } },
    { answers: { ...validAnswers.answers, secret: { answers: [''] } } },
    { answers: { ...validAnswers.answers, secret: { answers: [123] } } },
  ]) assert.throws(() => validateApprovalResponse(questions, reply), error => (error as any).statusCode === 400 && !String(error).includes('never-log-this'));
  assert.equal(validateApprovalResponse(questions, 'deny'), 'deny');
  assert.deepEqual(validateApprovalResponse(questions, { answers: {} }), { answers: {} });
});

test('question IDs that resemble object prototypes remain exact own keys', () => {
  const approval: RunApproval = { ...base, interaction: { type: 'questions', questions: [{ id: '__proto__', header: '', question: 'text', isOther: false, isSecret: false, options: null }] } };
  const response = JSON.parse('{"answers":{"__proto__":{"answers":["answer"]}}}');
  assert.deepEqual(validateApprovalResponse(approval, response), response);
  assert.throws(() => validateApprovalResponse(approval, { answers: { constructor: { answers: ['answer'] } } }), { statusCode: 400 });
});

test('MCP standard primitive forms enforce required fields, types, bounds and unknown keys', () => {
  const schema = { type: 'object', properties: {
    name: { type: 'string', minLength: 2, maxLength: 5 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    fraction: { type: 'number', minimum: 0, maximum: 1 },
    confirmed: { type: 'boolean' },
    optional: { type: 'string' },
  }, required: ['name', 'count', 'fraction', 'confirmed'] };
  const approval = form(schema), valid = { name: 'valid', count: 2, fraction: 0.5, confirmed: false };
  assert.equal(mcpFormUnsupportedReason(schema), undefined);
  assert.deepEqual(validateApprovalResponse(approval, content(valid)), content(valid));
  for (const value of [{ ...valid, name: 'x' }, { ...valid, name: 'too long' }, { ...valid, count: 1.5 }, { ...valid, count: 4 }, { ...valid, count: '2' }, { ...valid, fraction: NaN }, { ...valid, fraction: Infinity }, { ...valid, fraction: -1 }, { ...valid, confirmed: 'false' }, { ...valid, unexpected: true }, { name: 'valid' }]) assert.throws(() => validateApprovalResponse(approval, content(value)), { statusCode: 400 });
  for (const action of ['decline', 'cancel']) {
    assert.deepEqual(validateApprovalResponse(approval, { action, content: null }), { action, content: null });
    assert.throws(() => validateApprovalResponse(approval, { action, content: valid }), { statusCode: 400 });
  }
  for (const value of ['allow', { action: 'accept' }, { action: 'accept', content: valid, extra: true }, { action: 'accept', content: null }, { action: 'invalid', content: null }]) assert.throws(() => validateApprovalResponse(approval, value), { statusCode: 400 });
});

test('MCP enum variants and multiselect schemas accept only declared values', () => {
  const schema = { type: 'object', properties: {
    plain: { type: 'string', enum: ['a', 'b'] },
    legacy: { type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'] },
    titled: { type: 'string', oneOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] },
    multiple: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a', 'b'] } },
    titledMultiple: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] } },
  }, required: ['plain', 'legacy', 'titled', 'multiple', 'titledMultiple'] };
  const approval = form(schema), valid = { plain: 'a', legacy: 'a', titled: 'b', multiple: ['a'], titledMultiple: ['a', 'b'] };
  assert.equal(mcpFormUnsupportedReason(schema), undefined);
  assert.deepEqual(validateApprovalResponse(approval, content(valid)), content(valid));
  for (const invalid of [{ ...valid, plain: 'c' }, { ...valid, legacy: 'A' }, { ...valid, titled: 'B' }, { ...valid, multiple: [] }, { ...valid, multiple: ['a', 'a'] }, { ...valid, titledMultiple: ['c'] }, { ...valid, multiple: 'a' }]) assert.throws(() => validateApprovalResponse(approval, content(invalid)), { statusCode: 400 });
});

test('MCP formats validate dates, email, URI and RFC3339 date-time without copying answer values into errors', () => {
  for (const [format, valid, invalid] of [
    ['email', 'person@example.com', 'invalid-email'], ['uri', 'https://example.com/path', 'not a URI'],
    ['date', '2024-02-29', '2025-02-29'], ['date-time', '2026-09-17T01:02:03+09:00', '2026-09-17'],
  ]) {
    const approval = form({ type: 'object', properties: { field: { type: 'string', format } }, required: ['field'] });
    assert.deepEqual(validateApprovalResponse(approval, content({ field: valid })), content({ field: valid }));
    assert.throws(() => validateApprovalResponse(approval, content({ field: invalid })), error => (error as any).statusCode === 400 && !String(error).includes(invalid));
  }
});

test('unsupported generic schemas remain decline/cancel capable and can never grant unvalidated nested fields', () => {
  for (const schema of [
    { type: 'object', properties: { nested: { type: 'object', properties: { secret: { type: 'string' } } } } },
    { type: 'object', properties: { text: { type: 'string', pattern: '^x$' } } },
    { type: 'object', properties: { count: { type: 'integer', multipleOf: 2 } } },
    { type: 'object', properties: { text: { $ref: '#/defs/text' } } },
    { type: 'object', properties: {}, anyOf: [{ required: ['other'] }] },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'object', properties: { text: { type: 'string', oneOf: [{ const: 'x', title: 'X', pattern: 'x' }] } } },
  ]) {
    const approval = form(schema);
    assert.ok(mcpFormUnsupportedReason(schema));
    assert.throws(() => validateApprovalResponse(approval, content({})), { statusCode: 400 });
    assert.deepEqual(validateApprovalResponse(approval, { action: 'cancel', content: null }), { action: 'cancel', content: null });
  }
});

test('MCP URL interactions only accept native actions with null content', () => {
  const approval: RunApproval = { ...base, interaction: { type: 'mcp-url', serverName: 'fixture', url: 'https://example.com' } };
  for (const action of ['accept', 'decline', 'cancel']) {
    assert.deepEqual(validateApprovalResponse(approval, { action, content: null }), { action, content: null });
    assert.throws(() => validateApprovalResponse(approval, { action, content: { token: 'never-log-this' } }), error => (error as any).statusCode === 400 && !String(error).includes('never-log-this'));
  }
});

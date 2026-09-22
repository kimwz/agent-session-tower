import type { RunApproval, RunApprovalResponse } from './types.js';

type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const only = (value: ObjectValue, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const invalid = (detail: string): never => { throw Object.assign(new Error(detail), { statusCode: 400 }); };
const bound = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const unique = (values: unknown[]) => new Set(values).size === values.length;
const enumOptions = (value: unknown): value is Array<{ const: string; title: string }> => Array.isArray(value) && value.length > 0 && value.every(option => object(option) && only(option, ['const', 'title']) && typeof option.const === 'string' && typeof option.title === 'string') && unique(value.map(option => option.const));

/** Only schemas whose constraints we can enforce may produce an accepted response. */
export function mcpFormUnsupportedReason(schema: Record<string, unknown>): string | undefined {
  if (schema.type !== 'object' || !object(schema.properties) || !only(schema, ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties']) || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) return 'This form schema is not supported. Decline or cancel it and continue in the native app.';
  if (schema.required !== undefined && (!strings(schema.required) || !unique(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties as object, key)))) return 'The form has invalid required fields.';
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!object(field)) return `Unsupported schema for ${name}.`;
    const common = ['type', 'title', 'description', 'default'];
    if (['title', 'description'].some(key => field[key] !== undefined && typeof field[key] !== 'string')) return `Invalid label for ${name}.`;
    if (field.type === 'string') {
      if (!only(field, [...common, 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf']) || ['minLength', 'maxLength'].some(key => field[key] !== undefined && !bound(field[key])) || field.minLength > field.maxLength) return `Unsupported string constraints for ${name}.`;
      if (field.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(field.format)) return `Unsupported format for ${name}.`;
      if (field.enum !== undefined && (!strings(field.enum) || !field.enum.length || !unique(field.enum))) return `Invalid choices for ${name}.`;
      if (field.enumNames !== undefined && (!strings(field.enumNames) || !Array.isArray(field.enum) || field.enumNames.length !== field.enum.length)) return `Invalid choice labels for ${name}.`;
      if (field.oneOf !== undefined && (!enumOptions(field.oneOf) || field.enum !== undefined)) return `Invalid choices for ${name}.`;
    } else if (field.type === 'number' || field.type === 'integer') {
      if (!only(field, [...common, 'minimum', 'maximum']) || ['minimum', 'maximum'].some(key => field[key] !== undefined && (typeof field[key] !== 'number' || !Number.isFinite(field[key]))) || field.minimum > field.maximum) return `Unsupported number constraints for ${name}.`;
    } else if (field.type === 'boolean') {
      if (!only(field, common)) return `Unsupported boolean constraints for ${name}.`;
    } else if (field.type === 'array') {
      if (!only(field, [...common, 'items', 'minItems', 'maxItems']) || !object(field.items) || ['minItems', 'maxItems'].some(key => field[key] !== undefined && !bound(field[key])) || field.minItems > field.maxItems) return `Unsupported list constraints for ${name}.`;
      const items = field.items;
      if (!(only(items, ['type', 'enum']) && items.type === 'string' && strings(items.enum) && items.enum.length && unique(items.enum)) && !(only(items, ['anyOf']) && enumOptions(items.anyOf))) return `Unsupported list choices for ${name}.`;
    } else return `Unsupported field type for ${name}.`;
  }
}

function validFormat(value: string, format: string): boolean {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (format === 'uri') { try { new URL(value); return true; } catch { return false; } }
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return false;
  return format === 'date' ? value === day : /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateForm(schema: Record<string, unknown>, content: ObjectValue): void {
  const reason = mcpFormUnsupportedReason(schema);
  if (reason) invalid(reason);
  const properties = schema.properties as Record<string, ObjectValue>;
  for (const name of Object.keys(content)) if (!Object.hasOwn(properties, name)) invalid(`Unexpected form field: ${name}.`);
  for (const name of (schema.required as string[] | undefined) || []) if (!Object.hasOwn(content, name)) invalid(`Answer the required field: ${name}.`);
  for (const [name, value] of Object.entries(content)) {
    const field = properties[name];
    if (field.type === 'string') {
      if (typeof value !== 'string') invalid(`Enter text for ${name}.`);
      const text = value as string;
      if ((field.minLength !== undefined && [...text].length < field.minLength) || (field.maxLength !== undefined && [...text].length > field.maxLength)) invalid(`The length for ${name} is outside the allowed range.`);
      if (field.format && !validFormat(text, field.format)) invalid(`Enter a valid ${field.format} for ${name}.`);
      if ((field.enum && !field.enum.includes(text)) || (field.oneOf && !field.oneOf.some((option: ObjectValue) => option.const === text))) invalid(`Choose a listed value for ${name}.`);
    } else if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value)) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) invalid(`Enter a valid ${field.type} within the allowed range for ${name}.`);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') invalid(`Choose true or false for ${name}.`);
    } else {
      const allowed = field.items.enum || field.items.anyOf.map((option: ObjectValue) => option.const);
      if (!strings(value) || !unique(value) || value.some(item => !allowed.includes(item)) || (field.minItems !== undefined && value.length < field.minItems) || (field.maxItems !== undefined && value.length > field.maxItems)) invalid(`Choose valid listed values for ${name}.`);
    }
  }
}

/** Validate against the retained original request, never client-supplied request metadata. */
export function validateApprovalResponse(approval: RunApproval, response: unknown): RunApprovalResponse {
  const interaction = approval.interaction;
  if (response === 'deny') return response;
  if (!interaction) {
    if (response !== 'allow') invalid('Choose allow or deny.');
    return 'allow';
  }
  if (!object(response)) invalid('Provide an answer for this interaction.');
  const value = response as ObjectValue;
  if (interaction.type === 'questions') {
    if (!only(value, ['answers']) || !object(value.answers)) invalid('Provide answers keyed by question ID.');
    const answers = value.answers as ObjectValue;
    const questions = interaction.questions;
    if (Object.keys(answers).some(id => !questions.some(question => question.id === id))) invalid('The response contains an unknown question.');
    if (interaction.requireAnswers || Object.keys(answers).length) {
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!object(answer) || !only(answer, ['answers']) || !strings(answer.answers) || !answer.answers.length || answer.answers.length > 32 || !unique(answer.answers) || answer.answers.some((text: string) => !text.trim() || text.length > 100_000)) invalid('Answer every question before submitting.');
        if (question.multiSelect === false && answer.answers.length !== 1) invalid('Choose one answer for this question.');
        if (question.options?.length && !question.isOther && answer.answers.some((text: string) => !question.options!.some(option => option.label === text))) invalid('Choose one of the listed answers.');
      }
    }
  } else {
    if (!only(value, ['action', 'content']) || !['accept', 'decline', 'cancel'].includes(value.action) || !Object.hasOwn(value, 'content')) invalid('Choose accept, decline, or cancel and provide form content.');
    if (value.action !== 'accept' || interaction.type === 'mcp-url') {
      if (value.content !== null) invalid('This response must not include form content.');
    } else {
      if (!object(value.content)) invalid('Provide an object containing the form answers.');
      validateForm(interaction.schema, value.content as ObjectValue);
    }
  }
  return structuredClone(response) as RunApprovalResponse;
}

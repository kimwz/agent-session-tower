/** Models are argv/RPC values, never command fragments or provider configuration. */
export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(value);
}

export function requestedModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!validModelId(value)) throw Object.assign(new Error('Invalid model. Choose a valid provider model.'), { statusCode: 400 });
  return value;
}

import { MAX_SECRET_BYTES } from '../../shared/secrets.js';
/** Parse literals only: variable expansion and command interpolation are never evaluated. */
export function parseDotenv(content: string): Record<string, string> {
  if (Buffer.byteLength(content) > MAX_SECRET_BYTES || content.includes('\0')) throw new Error('Invalid dotenv size or content');
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fields: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset); const lineEnd = end < 0 ? text.length : end;
    const line = text.slice(offset, lineEnd); offset = lineEnd + 1;
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid dotenv assignment');
    const name = match[1]; let value = match[2];
    if (Object.hasOwn(fields, name)) throw new Error('Duplicate dotenv key');
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0]; let source = value.slice(1); let position = 0; let close = -1;
      for (;;) {
        for (; position < source.length; position++) { if (source[position] === quote) { let escapes = 0; for (let before = position - 1; before >= 0 && source[before] === '\\'; before--) escapes++; if (quote === "'" || escapes % 2 === 0) { close = position; break; } } }
        if (close >= 0) break;
        if (offset > text.length) throw new Error('Unclosed dotenv quote');
        const next = text.indexOf('\n', offset); const nextEnd = next < 0 ? text.length : next;
        source += '\n' + text.slice(offset, nextEnd); offset = nextEnd + 1;
      }
      if (!/^\s*(?:#.*)?$/.test(source.slice(close + 1))) throw new Error('Invalid dotenv suffix');
      value = source.slice(0, close);
      if (quote === '"') value = value.replace(/\\(n|r|t|"|\\)/g, (_, char: string) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[char]!);
    } else value = value.replace(/\s+#.*$/, '').trimEnd();
    fields[name] = value;
    if (Object.keys(fields).length > 2048) throw new Error('Too many dotenv fields');
  }
  return fields;
}

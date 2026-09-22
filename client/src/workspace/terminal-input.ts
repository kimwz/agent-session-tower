/** Preserve Unicode characters and order within the server's 16 KiB input limit. */
export function terminalInputChunks(data: string, limit = 16 * 1024): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of data) {
    const size = encoder.encode(character).length;
    if (bytes + size > limit && chunk) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

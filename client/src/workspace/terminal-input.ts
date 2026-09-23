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

// Replies xterm.js writes on the program's behalf: device attributes, status and cursor
// reports, mode reports, window reports, and OSC/DCS query answers.
const TERMINAL_REPORT = /^(?:\x1b\[[?>=]?[\d;]*[cnR]|\x1b\[\??[\d;]*\$y|\x1b\[[\d;]*t|\x1b\][\d;]*;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

/** True for automatic terminal replies, never for text or keys a person typed. */
export function isTerminalReport(data: string): boolean { return TERMINAL_REPORT.test(data); }

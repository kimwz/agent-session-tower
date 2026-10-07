/**
 * Files the workspace shows or plays instead of editing. The type comes from the name alone: the server sends it with
 * `nosniff` and a sandbox policy, so bytes that are not really this media only fail to play, never run as a page.
 * SVG is text and stays in the editor.
 */
export type WorkspaceMediaKind = 'image' | 'video' | 'audio';
export interface WorkspaceMedia { kind: WorkspaceMediaKind; type: string }

const MEDIA: Record<string, WorkspaceMedia> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  avif: { kind: 'image', type: 'image/avif' },
  bmp: { kind: 'image', type: 'image/bmp' },
  mp4: { kind: 'video', type: 'video/mp4' },
  m4v: { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
  mov: { kind: 'video', type: 'video/quicktime' },
  ogv: { kind: 'video', type: 'video/ogg' },
  mp3: { kind: 'audio', type: 'audio/mpeg' },
  m4a: { kind: 'audio', type: 'audio/mp4' },
  aac: { kind: 'audio', type: 'audio/aac' },
  wav: { kind: 'audio', type: 'audio/wav' },
  ogg: { kind: 'audio', type: 'audio/ogg' },
  oga: { kind: 'audio', type: 'audio/ogg' },
  opus: { kind: 'audio', type: 'audio/ogg' },
  flac: { kind: 'audio', type: 'audio/flac' },
};
const TYPES = new Set(Object.values(MEDIA).map(media => media.type));

/** The media a workspace file name stands for, or undefined for a file the text editor opens. */
export function workspaceMedia(path: string): WorkspaceMedia | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && Object.hasOwn(MEDIA, name.slice(dot + 1).toLowerCase()) ? MEDIA[name.slice(dot + 1).toLowerCase()] : undefined;
}

/** Whether `type` (without parameters) is one the workspace sends media as. */
export const isWorkspaceMediaType = (type: string): boolean => TYPES.has(type.toLowerCase());

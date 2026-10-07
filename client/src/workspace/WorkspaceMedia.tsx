import { useEffect, useRef } from 'react';
import type { WorkspaceMedia as Media } from '../../../shared/workspace-media';
import { translate as t } from '../i18n/i18n';
import { workspacePath } from '../remote/scope';

/**
 * Why a media file did not load: the server's own refusal (a missing or unshared file, or a joined computer whose Tower
 * cannot play media yet), or, when the file is served, a format this browser cannot decode.
 */
async function failure(url: string, signal: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    if (response.ok) { void response.body?.cancel(); return t('이 브라우저가 재생할 수 없는 형식입니다.'); }
    // best-effort: a refusal that is not Tower's JSON (a proxy's page) is still named by its status below.
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    return typeof body.error === 'string' && body.error ? body.error : t('요청을 처리하지 못했습니다 ({0})', { 0: response.status });
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

/** Shows an image or plays a video or song from the workspace; a new `version` loads the file again. */
export function WorkspaceMedia({ cwd, path, media, version, onError }: { cwd: string; path: string; media: Media; version: number; onError: (message: string) => void }) {
  const src = workspacePath(cwd, '/api/workspace/media', { path, v: String(version) });
  const report = useRef(onError); report.current = onError;
  const probe = useRef<AbortController>(undefined);
  useEffect(() => () => probe.current?.abort(), []);
  const failed = () => {
    if (probe.current) return;
    const controller = probe.current = new AbortController();
    void failure(src, controller.signal).then(message => { if (!controller.signal.aborted) report.current(message); });
  };
  const name = path.slice(path.lastIndexOf('/') + 1);
  return <div className={`workspace-media is-${media.kind}`}>
    {media.kind === 'image' ? <img src={src} alt={name} decoding="async" onError={failed} />
      : media.kind === 'video' ? <video src={src} aria-label={name} controls playsInline preload="metadata" onError={failed} />
      : <audio src={src} aria-label={name} controls preload="metadata" onError={failed} />}
  </div>;
}

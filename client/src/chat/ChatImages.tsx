import { translate as t, useI18n } from '../i18n/i18n';
import { useState } from 'react';
import type { ChatMessage } from '../../../shared/types';

export function ChatImage({ image, alt }: { image: NonNullable<ChatMessage['images']>[number]; alt?: string }) {
  useI18n();
  const [failed, setFailed] = useState(false);
  const label = alt || image.name;
  return <a className="chat-image" href={image.url} target="_blank" rel="noreferrer noopener" title={label}>
    {failed ? <span className="attachment-label">{label} — {t("이미지 미리보기를 불러올 수 없습니다.")}</span>
      : <img src={image.url} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />}
  </a>;
}
export function ChatImages({ images }: { images: ChatMessage['images'] }) {
  return images?.length ? <div className="chat-images">{images.map(image => <ChatImage key={image.url} image={image} />)}</div> : null;
}

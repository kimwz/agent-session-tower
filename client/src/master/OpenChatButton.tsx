import { MessageSquare } from 'lucide-react';
import { useWords } from './strings';

/**
 * Opens the master's conversation while voice is on and it is closed, when the floating button ends voice instead.
 * Focus is left to the conversation it opens, never moved to that button, where Enter would end voice.
 */
export function OpenChatButton({ onOpen }: { onOpen: () => void }) {
  const words = useWords();
  const label = words('마스터 채팅 열기', 'Open master chat');
  return <button className="master-mic" onClick={onOpen} title={`${label} (Shift+M)`} aria-label={label} aria-keyshortcuts="Shift+M"><MessageSquare size={16} /></button>;
}

/** What the master's floating button does, and what shows beside it. */
export interface DockLayout {
  /** The button opens or closes the conversation, or ends voice while voice is on. */
  button: 'toggle' | 'end-voice';
  /**
   * Beside the button, at most one thing: the microphone and settings icons while the conversation is open, the live
   * voice bar while voice is on, or why voice ended when it did not end by the owner's hand.
   */
  side: 'tray' | 'voice' | 'ended' | null;
}

export function dockLayout({ conversationOpen, voiceOn, ended, panelOpen }: {
  conversationOpen: boolean; voiceOn: boolean; ended: boolean; panelOpen: boolean;
}): DockLayout {
  const button = voiceOn ? 'end-voice' : 'toggle';
  // The master's own panel covers the button's corner: nothing beside it then.
  if (panelOpen) return { button, side: null };
  if (voiceOn) return { button, side: 'voice' };
  if (ended) return { button, side: 'ended' };
  return { button, side: conversationOpen ? 'tray' : null };
}

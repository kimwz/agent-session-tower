/** What the master's floating button does, and what shows beside it. */
export interface DockLayout {
  /** The button opens or closes the conversation, or ends voice while voice is on. */
  button: 'toggle' | 'end-voice';
  /**
   * Beside the button, at most one thing: the microphone and settings icons while the conversation is open, the live
   * voice bar while voice is on, or why voice ended when it did not end by the owner's hand.
   */
  side: 'tray' | 'voice' | 'ended' | null;
  /**
   * Whether the voice bar offers to open the master's conversation, above its settings icon: only while voice is on
   * (the button then ends voice) and the master's conversation is closed here.
   */
  reopen: boolean;
}

export function dockLayout({ conversationOpen, voiceOn, ended, panelOpen, hasSession }: {
  conversationOpen: boolean; voiceOn: boolean; ended: boolean; panelOpen: boolean;
  /** Whether the master has a conversation to open yet. */
  hasSession: boolean;
}): DockLayout {
  const button = voiceOn ? 'end-voice' : 'toggle';
  // The master's own panel covers the button's corner: nothing beside it then.
  if (panelOpen) return { button, side: null, reopen: false };
  if (voiceOn) return { button, side: 'voice', reopen: hasSession && !conversationOpen };
  if (ended) return { button, side: 'ended', reopen: false };
  return { button, side: conversationOpen ? 'tray' : null, reopen: false };
}

import type { MasterDirectiveResult, MasterFilter, MasterScreenCommand } from '../../../shared/master';
import { setChatFontSize } from '../chat/chat-appearance';
import { setLanguage } from '../i18n/i18n';
import { scopedId } from '../remote/scope';
import { openSettings } from '../settings/settings-open';

/** What the master may do on the owner's screen: the page's own actions and setters, handed down. */
export interface MasterControls {
  selectSession(id: string | null): void;
  openNewSession(cwd?: string, draft?: { title: string; prompt: string }): void;
  openAutoPrompt(cwd?: string, node?: string): void;
  showHelp(): void;
  showSessions(): void;
  filter(filter: MasterFilter): void;
}

export interface ScreenAnswer { result: MasterDirectiveResult; note?: string }

/**
 * Does a screen command the way the owner would: through the page's own controls, and for the settings' sections
 * through the same opening the settings button uses.
 */
export function runScreenCommand(command: MasterScreenCommand, controls: MasterControls): ScreenAnswer {
  switch (command.kind) {
    case 'openSession': controls.selectSession(scopedId(command.node, command.sessionId)); break;
    case 'close': controls.selectSession(null); break;
    case 'filter': controls.filter(command.filter); break;
    case 'preference':
      if (command.language) setLanguage(command.language);
      if (command.chatFontSize) setChatFontSize(command.chatFontSize);
      break;
    case 'openPanel': {
      const cwd = command.cwd ? scopedId(command.node, command.cwd) : undefined;
      if (command.panel === 'sessions') controls.showSessions();
      else if (command.panel === 'help') controls.showHelp();
      else if (command.panel === 'newSession') controls.openNewSession(cwd, command.title || command.prompt ? { title: command.title ?? '', prompt: command.prompt ?? '' } : undefined);
      // Without a folder, Auto Prompt starts on the computer named, or on this one.
      else if (command.panel === 'autoPrompt') controls.openAutoPrompt(cwd, cwd ? undefined : command.node ?? '');
      // Every other panel is a section of the settings, opened as the owner's own settings button would.
      else if (!openSettings({ section: command.panel })) {
        return { result: 'unavailable', note: command.panel === 'account' ? 'Account management opens only on a page of this computer itself.' : 'That panel cannot be opened on this page right now.' };
      }
      break;
    }
    default: return { result: 'failed', note: 'This page does not know that command.' };
  }
  return { result: 'done' };
}

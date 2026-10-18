import { TowerError } from '../errors.js';

/**
 * The first messages a todo's empty issue chat offers as buttons: one click starts the issue master with that text,
 * as if it were typed and sent. The owner keeps them in the settings; until a list is saved these defaults show.
 */
export const DEFAULT_CHAT_PRESETS: readonly string[] = ['작업 시작 해줘', '설계 해줘', '조사 해줘'];
export const MAX_CHAT_PRESETS = 12;
export const MAX_CHAT_PRESET_LENGTH = 500;

/** The saved list as the owner sent it, trimmed; `null` goes back to the defaults. Anything else is refused whole. */
export function parseChatPresets(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_CHAT_PRESETS) throw new TowerError('invalid', `프리셋은 ${MAX_CHAT_PRESETS}개까지 저장할 수 있습니다.`);
  const presets = value.map(item => typeof item === 'string' ? item.trim() : '');
  if (presets.some(item => !item || item.length > MAX_CHAT_PRESET_LENGTH)) throw new TowerError('invalid', `프리셋은 1자 이상, ${MAX_CHAT_PRESET_LENGTH}자 이하여야 합니다.`);
  if (new Set(presets).size !== presets.length) throw new TowerError('invalid', '같은 프리셋이 두 번 있습니다.');
  return presets;
}

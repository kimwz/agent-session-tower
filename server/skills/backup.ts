import type { SkillAdvisorSettings, SkillBundle } from '../../shared/skills.js';

/** Tower's own skills as a backup keeps them; `SkillService.restore` writes them back exactly. */
export interface SkillBackup {
  bundle: SkillBundle;
  /** The owner's guidance, empty included. */
  guidance: string;
  settings: SkillAdvisorSettings;
}

/**
 * Skills are the owner's recurring ways of working, kept as standard `SKILL.md` folders that Claude Code and Codex
 * load by themselves. Tower lists and edits them, proposes new ones from the owner's sessions, and names the pinned
 * ones in the guidance every session on this computer reads.
 */
export type SkillScope = 'global' | 'project';
export type SkillProvider = 'claude' | 'codex';

export interface Skill {
  /** The skill folder's real path; the identity of a skill, however many links lead to it. */
  dir: string;
  name: string;
  description: string;
  scope: SkillScope;
  /** The project folder a project skill belongs to. */
  cwd?: string;
  /** Which agents find it by themselves. */
  providers: SkillProvider[];
  /** Named in Tower's guidance, so every session checks it before starting a task. */
  pinned: boolean;
  /** Installed by the `skills` command; a reinstall replaces edits made here. */
  external: boolean;
  /** Kept in Tower's own folder (`<state>/skills`), so it is backed up and moved with Tower. */
  managed: boolean;
  /** Hash of the SKILL.md this listing read; a save sends it back so a newer edit is never overwritten. */
  revision: string;
  /**
   * The same skill kept as separate folders, one per agent (an older install copied it instead of linking it). `dir`
   * is the one edited; the list shows it once. Absent when there is a single folder.
   */
  copies?: SkillCopy[];
  /** The copies' contents differ (usually each names its own agent), so they are not merged. */
  copiesDiffer?: boolean;
}
export interface SkillCopy { dir: string; providers: SkillProvider[] }
export interface SkillDetail extends Skill { body: string }

export interface SkillEvidence { sessionId: string; title: string; at: string }
export interface SkillProposal {
  id: string;
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  cwd?: string;
  /** Why the advisor thinks this is a recurring way of working. */
  reason: string;
  /** The owner asked for it outright ("always do …"), so one session is enough. */
  explicit: boolean;
  evidence: SkillEvidence[];
  status: 'open' | 'accepted' | 'dismissed';
  createdAt: string;
  updatedAt: string;
  /** The skill it became. */
  skillDir?: string;
}
/** How the owner worked in one session, as the advisor summed it up. */
export interface SkillNote { at: string; sessionId: string; title: string; cwd: string; note: string }

export type SkillAdvisorProvider = 'claude' | 'codex';
export const SKILL_ADVISOR_MODELS: Record<SkillAdvisorProvider, string> = { claude: 'sonnet', codex: 'gpt-5.6-terra' };
export interface SkillAdvisorSettings { enabled: boolean; provider: SkillAdvisorProvider }
export interface SkillAdvisorStatus {
  running: boolean;
  lastRunAt?: string;
  lastError?: string;
  backfill?: { running: boolean; at?: string; error?: string; proposals?: number };
}

/** The owner's own guidance, kept in Tower and given to every agent beside Tower's own text. */
export interface GuidanceOverview { owner: string; revision: string; tower: string; installed: boolean }

/** A backup of chosen skills and guidance, made by one Tower and read by another. */
export const SKILL_BUNDLE_FORMAT = 'agent-session-tower.skills';
export const MAX_SKILL_BUNDLE_BYTES = 20 * 1024 * 1024;
export interface SkillBundleFile { path: string; mode: number; base64: string }
export interface SkillBundleSkill { name: string; description: string; scope: SkillScope; project?: { cwd: string; title: string }; pinned: boolean; files: SkillBundleFile[] }
export interface SkillBundle { format: typeof SKILL_BUNDLE_FORMAT; version: 1; exportedAt: string; from: string; guidance?: string; skills: SkillBundleSkill[] }
/** What importing each item of a bundle would do here. */
export interface SkillImportItem {
  index: number;
  name: string;
  scope: SkillScope;
  /** The project folder it was in on the other computer. */
  fromCwd?: string;
  /** new: nothing by that name; managed: a Tower skill by that name (can be replaced); external: a skill Tower does not keep (skip only). */
  conflict: 'new' | 'managed' | 'external';
  /** For a project skill: this computer's folder with the same path, when Tower knows it. */
  cwd?: string;
  pinned: boolean;
  description: string;
}
export interface SkillImportPlan { items: SkillImportItem[]; guidance: boolean; exportedAt: string; from: string }
export interface SkillImportChoice { index: number; action: 'add' | 'replace' | 'skip'; cwd?: string }

export interface SkillOverview {
  skills: Skill[];
  /** Every skill kept in Tower's own folder, whatever project it belongs to: what a backup can hold. */
  stored: Skill[];
  guidance: GuidanceOverview;
  proposals: SkillProposal[];
  notes: SkillNote[];
  settings: SkillAdvisorSettings;
  advisor: SkillAdvisorStatus;
  /** The project the listing is for; its skills come with the global ones. */
  cwd?: string;
}
export interface SkillSummary { proposals: number }

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILL_BODY = 64 * 1024;
/** Proposals the owner is shown; the rest are still being watched for a second occurrence. */
export const EVIDENCE_TO_PROPOSE = 2;

export function proposalReady(proposal: SkillProposal): boolean {
  return proposal.status === 'open' && (proposal.explicit || new Set(proposal.evidence.map(item => item.sessionId)).size >= EVIDENCE_TO_PROPOSE);
}

/** Proposals that belong where the panel was opened: global ones, and a project's own where that project is open. */
export function proposalsFor(proposals: SkillProposal[], cwd?: string): SkillProposal[] {
  return proposals.filter(proposal => proposal.scope === 'global' || !cwd || proposal.cwd === cwd);
}

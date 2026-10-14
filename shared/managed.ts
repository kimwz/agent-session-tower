/**
 * Settings a controlling Tower keeps on a computer that follows it ("호스트 설정 따르기"). The controller is the
 * source; the computer applies what it receives and reports which revision it applied. Each section is owned by its
 * domain module, which exports it on the controller and applies it on the computer.
 */
export const MANAGED_SECTIONS = ['skills', 'models', 'permissions', 'decisions'] as const;
export type ManagedSection = typeof MANAGED_SECTIONS[number];

export interface ManagedPayload {
  /** sha256 of the canonical JSON of `sections`: the same settings always give the same revision. */
  revision: string;
  sections: Partial<Record<ManagedSection, unknown>>;
}

/** What a following computer applied last. A section that failed keeps its previous value there. */
export interface ManagedApplied {
  revision: string;
  appliedAt: string;
  errors?: Partial<Record<ManagedSection, string>>;
}

/** Where a controller stands with one following computer, for the computer's card. */
export interface ManagedSyncStatus {
  /** The revision the computer confirmed last, and when. */
  applied?: ManagedApplied;
  /** Why the last attempt did not go through; the computer keeps what it applied before. */
  error?: string;
  attemptedAt?: string;
}

/** A project folder on a following computer, with the repository it is a clone of. */
export interface ManagedFolder { cwd: string; remoteUrl?: string }

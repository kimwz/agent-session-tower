/**
 * Limits the trigger state shares across its modules. This file imports nothing, so state, once and audit can all use
 * it without importing each other at runtime.
 */
export const MAX_REVISIONS = 20;
export const MAX_TOMBSTONES = 20;
export const MAX_RETAINED_TRIGGERS = 200;
export const MAX_ONCE_RESERVATIONS = 2000;
export const MAX_AUDIT = 1000;
/** Runs one trigger may have recorded (in the last 30 days); past it, new runs are not accepted. */
export const MAX_FIRED_PER_TRIGGER = 20_000;

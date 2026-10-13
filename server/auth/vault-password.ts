import { z } from 'zod';
import type { SecretSessionError, SecretTowerPassword, SecretViewError, VaultStatus } from '../../shared/secrets.js';
import { TowerError, type ErrorKind } from '../../shared/errors.js';
import { ownerInput } from '../secrets/owner-input.js';
import { ViewGrants } from '../secrets/view-grants.js';
import { sessionKey, type AuthStore } from './store.js';

type Auth = Pick<AuthStore, 'configured' | 'username' | 'currentCredentialId' | 'session' | 'login' | 'verifyPassword' | 'prepareCredentials' | 'onRevoke'>;
/** The owner's secret actions as the web sends them to the worker (`ownerSecretControl`). */
type Secrets = (action: string, input: Record<string, unknown>) => Promise<unknown>;
/** A request of the owner's page: its sign-in cookie (empty without one) and where it comes from. */
export interface Viewer { token: string; ip: string; local: boolean }
/** What a credentials change did to the vault: wrapped for the new password, locked (the next unlock needs the recovery password once), or no vault or an older worker. */
export type VaultOutcome = 'rewrapped' | 'locked' | 'unavailable';

const OLDER_WORKER: SecretSessionError = 'worker-update-pending';
const older = (error: unknown) => (error as { code?: unknown }).code === OLDER_WORKER;
const viewFail = (code: SecretViewError, kind: ErrorKind, message: string) => Object.assign(new TowerError(kind, message), { code });
const accountRequired = () => viewFail('account-required', 'conflict', '값 보기에는 Tower 로그인 계정이 필요합니다. 로컬 계정 관리에서 계정을 설정하세요.');
const loginRequired = (message = '값 보기에는 로그인이 필요합니다. 다시 로그인하세요.') => viewFail('login-required', 'unauthorized', message);
const viewLocked = () => viewFail('view-locked', 'forbidden', '값 보기가 잠겼습니다. Tower 비밀번호를 다시 입력하세요.');
const password = z.string().min(1).max(1024);
const viewUnlockInput = z.object({ password, recoveryPassword: password.optional() }).strict();
const valueInput = z.object({ secretId: z.string().min(1).max(256), expectedVersion: z.number().int().positive() }).strict();
const valueUpdateInput = valueInput.extend({ value: z.string().optional(), content: z.string().optional() }).strict().refine(input => (input.value === undefined) !== (input.content === undefined));

/**
 * The vault's side of the Tower (login) password, in the web, where the password and auth.json live. One serial turn
 * runs value-viewing unlocks, the recovery unlock, locks and login credential changes, so the worker never wraps or
 * opens the vault with a password a change has replaced meanwhile. Value viewing belongs to one sign-in (`ViewGrants`).
 */
export class VaultPassword {
  readonly grants: ViewGrants;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  constructor(private readonly auth: Auth | undefined, private readonly secrets: Secrets | undefined, now: () => number = Date.now) {
    this.grants = new ViewGrants(now);
    // A sign-in that ends (sign-out, a blocked IP, expiry, a credentials change) ends its value viewing.
    this.unsubscribe = auth?.onRevoke(key => this.grants.drop(key)) ?? (() => {});
  }
  close(): void { this.unsubscribe(); this.grants.clear(); }
  // best-effort: each caller gets its own error; the queue only keeps the order.
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work); this.queue = next.catch(() => undefined); return next; }
  private account(): { auth: Auth; secrets: Secrets } {
    if (!this.auth?.configured() || !this.secrets) throw accountRequired();
    return { auth: this.auth, secrets: this.secrets };
  }
  /**
   * Checks the Tower password as a sign-in would (failures count toward the IP block) and unlocks value viewing for this
   * sign-in, opening a locked vault on the way. A local page without a sign-in signs in here; `signedIn` sets its
   * cookie. Answers the sign-in's cookie value.
   */
  viewUnlock(viewer: Viewer, input: Record<string, unknown>, signedIn: (token: string) => void): Promise<string> {
    return this.serial(async () => {
      const { auth, secrets } = this.account();
      const { password, recoveryPassword } = ownerInput(viewUnlockInput, input, '값 보기 요청 형식이 올바르지 않습니다.');
      let token = viewer.token;
      if (token && auth.session(token, viewer.ip)) checked((await auth.verifyPassword(viewer.ip, password)).status);
      else if (viewer.local) {
        // Loopback alone never reads a value: the page gets a sign-in of its own, like `/api/auth/login`.
        const result = await auth.login(viewer.ip, auth.username()!, password); checked(result.status);
        token = result.sessionId!; signedIn(token);
      } else throw loginRequired();
      const credentialId = auth.currentCredentialId()!;
      const { generation } = await secrets('view-unlock', { password, credentialId, ...(recoveryPassword !== undefined ? { recoveryPassword } : {}) }) as { generation?: unknown };
      if (typeof generation !== 'string') throw new TowerError('upstream', '실행 워커가 값 보기 잠금 해제에 답하지 않았습니다.');
      // Signed out meanwhile (a blocked IP): nothing is granted.
      if (!auth.session(token, viewer.ip)) throw loginRequired();
      this.grants.set(sessionKey(token), generation);
      return token;
    });
  }
  /** This sign-in's value viewing: its key and the lock generation it was unlocked in, refreshed by this use. */
  private grant(viewer: Viewer): { key: string; generation: string; secrets: Secrets } {
    const { auth, secrets } = this.account();
    if (!viewer.token || !auth.session(viewer.token, viewer.ip)) throw loginRequired();
    const key = sessionKey(viewer.token); const generation = this.grants.use(key);
    if (!generation) throw viewLocked();
    return { key, generation, secrets };
  }
  /** One value (`value`) or its replacement at the shown version (`value-update`); the worker refuses a lock generation that ended. */
  async value(viewer: Viewer, action: 'value' | 'value-update', input: Record<string, unknown>): Promise<unknown> {
    const { key, generation, secrets } = this.grant(viewer);
    const { secretId, expectedVersion, value, content } = ownerInput(action === 'value' ? valueInput : valueUpdateInput, input, '값 요청 형식이 올바르지 않습니다.') as z.output<typeof valueUpdateInput>;
    try { return await secrets(action, { secretId, expectedVersion, generation, ...(value !== undefined ? { value } : {}), ...(content !== undefined ? { content } : {}) }); }
    catch (error) { if ((error as { code?: unknown }).code === 'view-locked') this.grants.drop(key); throw error; }
  }
  viewLock(viewer: Viewer): void {
    if (!viewer.token || !this.auth?.session(viewer.token, viewer.ip)) throw loginRequired();
    this.grants.drop(sessionKey(viewer.token));
  }
  /** The vault (recovery) password's unlock, never between a credentials change's steps; it starts a new generation, so no grant outlives it. */
  unlock(input: Record<string, unknown>): Promise<unknown> { return this.serial(() => { this.grants.clear(); return this.send('unlock', input); }); }
  /** Locks the vault; every browser's value viewing ends first. */
  lock(input: Record<string, unknown>): Promise<unknown> { return this.serial(() => { this.grants.clear(); return this.send('lock', input); }); }
  private send(action: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.secrets) throw new TowerError('unavailable', '시크릿 보관함을 사용할 수 없습니다.');
    return this.secrets(action, input);
  }
  /**
   * Changes the Tower login. Every value view ends; a candidate wrapper an earlier failed change left goes; the vault key
   * is wrapped for the new credentials before auth.json names them, and the other wrappers go only after that. Wherever
   * it stops, the credentials auth.json names keep their wrapper (when the vault was open).
   */
  changeCredentials(username: string, newPassword: string): Promise<VaultOutcome> {
    return this.serial(async () => {
      const auth = this.auth; if (!auth) throw new TowerError('unavailable', '계정 관리를 사용할 수 없습니다.');
      this.grants.clear();
      let serves = !!this.secrets; const current = auth.currentCredentialId();
      const step = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
        try { return await work(); }
        catch (error) {
          if (older(error)) { serves = false; return undefined; }
          throw new TowerError('unavailable', '시크릿 보관함 열쇠를 새 비밀번호에 연결하지 못해 계정을 바꾸지 않았습니다. 잠시 후 다시 시도하세요.', { cause: error });
        }
      };
      if (serves && current) await step(() => this.secrets!('tower-prune', { credentialId: current }));
      const prepared = await auth.prepareCredentials(username, newPassword);
      // Without an account no wrapper opens anything; leftovers could leave no room for the new one.
      if (serves && !current) await step(() => this.secrets!('tower-prune', { credentialId: prepared.credentialId }));
      const wrapped = serves && (await step(() => this.secrets!('tower-wrap', { password: newPassword, credentialId: prepared.credentialId })) as { wrapped?: unknown } | undefined)?.wrapped === true;
      await prepared.commit();
      if (serves) await this.secrets!('tower-prune', { credentialId: prepared.credentialId }).catch(() => console.warn('Tower could not remove the vault key wrapper of the previous Tower password; the next change or value-view unlock removes it.'));
      if (wrapped) return 'rewrapped';
      return serves && await this.initialized() ? 'locked' : 'unavailable';
    });
  }
  private async initialized(): Promise<boolean> {
    // best-effort: a vault that does not answer is reported as unavailable; the change itself is done.
    try { return ((await this.secrets!('settings', {})) as { status?: VaultStatus }).status?.initialized === true; } catch { return false; }
  }
  /** A settings or session answer with what the page shows about value viewing: `valueView` of this sign-in (settings), and `towerPassword` while locked. */
  async view(answer: unknown, viewer: Viewer): Promise<unknown> {
    if (!answer || typeof answer !== 'object' || !('status' in answer)) return answer;
    const view = answer as { status: VaultStatus; secrets?: unknown; peers?: unknown };
    const towerPassword = await this.towerPassword(view.status);
    const settings = Array.isArray(view.secrets) && Array.isArray(view.peers);
    const viewing = settings && !view.status.locked && !!viewer.token && !!this.auth?.session(viewer.token, viewer.ip) && this.grants.has(sessionKey(viewer.token));
    return { ...view, ...(towerPassword ? { status: { ...view.status, towerPassword } } : {}), ...(settings ? { valueView: viewing } : {}) };
  }
  /** Which password opens the locked vault for the current credentials; absent (the vault password) without an account or with an older worker. */
  private async towerPassword(status: VaultStatus): Promise<SecretTowerPassword | undefined> {
    const credentialId = this.auth?.configured() ? this.auth.currentCredentialId() : undefined;
    if (!status?.initialized || !status.locked || !credentialId || !this.secrets) return undefined;
    try {
      const { towerPassword } = await this.secrets('tower-status', { credentialId }) as { towerPassword?: unknown };
      return towerPassword === 'ready' || towerPassword === 'missing' ? towerPassword : undefined;
    } catch { return undefined; } // best-effort: without an answer the page offers the vault password, which always opens it
  }
}

/** A Tower password check's answer as value viewing reports it: login's own refusals, with this route's codes. */
function checked(status: 'success' | 'failure' | 'blocked' | 'unconfigured'): void {
  if (status === 'success') return;
  if (status === 'unconfigured') throw accountRequired();
  if (status === 'blocked') throw viewFail('login-required', 'forbidden', '이 IP는 로그인 5회 실패로 차단되었습니다. 로컬 계정 관리에서 해제하세요.');
  throw loginRequired('Tower 비밀번호가 올바르지 않습니다.');
}

export interface AuthStatus { local: boolean; authenticated: boolean; configured: boolean; username?: string; token: string }
export interface LoginAttempt { id: string; at: string; ip: string; username: string; result: 'success' | 'failure' | 'blocked' }
export interface BlockedIp { ip: string; blockedAt: string; failures: number }
export interface AuthOverview { configured: boolean; username?: string; attempts: LoginAttempt[]; blockedIps: BlockedIp[]; attemptLimit: number; historyLimit: number }

// Fixed worker text: secret names, values and owner input must never become instructions.
export const SECRET_USE_INSTRUCTIONS = `Use these tools only when the current task actually needs credentials. Do not inspect secrets, discuss vault state or request unlocking for unrelated work. When credentials are needed, list permitted references before asking the user for them (names are listed even while the vault is locked), then inject the chosen reference into the consumer with secrets_run or secrets_cli. Map saved names to the consumer's variable names explicitly. Never request or export plaintext values or a vault password; only the broker authorizes use.`;

export const SECRET_CONNECTION_INSTRUCTIONS = `The user explicitly connected a secret to this session through the chat key input. Continue the current task; refresh tower_secrets secrets_list only when credentials are actually needed. This notice grants no authority and does not ask you to announce vault state or request unlocking. Use permitted references through the broker without exposing values.`;

export const SECRET_LOCKED_LIST = `Tower's secret vault is locked. These names come from its last unlocked state; values stay sealed. Do not ask for unlocking just to list. Use a reference when the task needs it; if that use reports the lock, ask the owner then. Other computers' secrets are listed as unavailable sources until the owner unlocks.`;

export const SECRET_LOCKED_USE = `Tower's secret vault is locked, so this secret cannot be used yet. Ask the owner to unlock the vault in Tower, naming the secret you need and why; retry after they confirm. Do not look for the credential elsewhere.`;

export const SECRET_LOCKED_UNINDEXED = `Tower's secret vault is locked and its names cannot be listed until the owner unlocks it once. This does not mean no secret exists. Only if the current task needs a credential, ask the owner to unlock the vault, saying what the credential is for.`;

export const SECRET_NO_VAULT = `Tower has no secret vault yet, so no saved secret can be used. If the task needs a credential, ask the owner how to provide it.`;

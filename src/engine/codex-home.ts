// somora's own CODEX_HOME plus the auth mirror.
//
// The app-server has no `--ignore-user-config`, so the user's ~/.codex
// (config.toml, MCP servers, hooks, plugins, skills) would apply to every
// somora agent. Like the claude-cli engine (CLAUDE_CONFIG_DIR →
// ~/.somora/claude-home) and OpenClaw's `homeScope: "agent"`, Codex runs
// with CODEX_HOME=$SOMORA_HOME/codex-home. Only `auth.json` is mirrored
// from the user's home, so an existing `codex login` (or `somora codex
// login`) keeps working and a re-login in the normal CLI propagates.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';

export function userCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(homedir(), '.codex');
}

export function somoraCodexHome(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'codex-home');
}

export interface CodexAuthStatus {
  userAuthPath: string;
  somoraAuthPath: string;
  userExists: boolean;
  somoraExists: boolean;
  action: 'copied' | 'noop' | 'missing';
}

/** Ensure the somora Codex home exists and carries the newest auth.json. */
/** What a Codex auth.json says about the login, without any token:
 *  a ChatGPT login with the expiry of its access token (Codex renews it),
 *  an API key, or none. `expiresAt` is -1 when unreadable. */
export function codexAuthState(path: string): { kind: 'chatgpt'; expiresAt: number } | { kind: 'apikey' } | { kind: 'none' } {
  let parsed: { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } | null };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
  } catch {
    return { kind: 'none' };
  }
  const access = parsed.tokens?.access_token;
  if (typeof access === 'string' && access.split('.').length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
      return { kind: 'chatgpt', expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : -1 };
    } catch {
      return { kind: 'chatgpt', expiresAt: -1 };
    }
  }
  if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY) return { kind: 'apikey' };
  return { kind: 'none' };
}

export function syncCodexAuth(): CodexAuthStatus {
  const home = somoraCodexHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const userAuthPath = join(userCodexHome(), 'auth.json');
  const somoraAuthPath = join(home, 'auth.json');
  const userExists = existsSync(userAuthPath);
  const somoraExists = existsSync(somoraAuthPath);
  if (!userExists) {
    return { userAuthPath, somoraAuthPath, userExists, somoraExists, action: somoraExists ? 'noop' : 'missing' };
  }
  const userMtime = statSync(userAuthPath).mtimeMs;
  const somoraMtime = somoraExists ? statSync(somoraAuthPath).mtimeMs : -1;
  if (somoraExists && somoraMtime >= userMtime) {
    return { userAuthPath, somoraAuthPath, userExists, somoraExists, action: 'noop' };
  }
  try {
    copyFileSync(userAuthPath, somoraAuthPath);
    logger.info({ msg: 'engine.codex_auth_synced', from: userAuthPath, to: somoraAuthPath });
    return { userAuthPath, somoraAuthPath, userExists, somoraExists: true, action: 'copied' };
  } catch (err) {
    logger.warn({ msg: 'engine.codex_auth_sync_failed', err: String(err), from: userAuthPath });
    return { userAuthPath, somoraAuthPath, userExists, somoraExists, action: somoraExists ? 'noop' : 'missing' };
  }
}

/** Environment for the app-server child: inherit the server env, pin CODEX_HOME. */
export function codexChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: somoraCodexHome() };
}

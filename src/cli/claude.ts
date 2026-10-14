// `somora claude [args...]` — the Claude Code that somora runs, and the
// login it shares with ~/.claude (src/server/claude-credential-sync.ts).
// The same shape as `somora codex` and `somora grok`:
//
//   somora claude login    log in with the Claude subscription (the
//                          bundled Claude Code, or your own when installed)
//   somora claude logout   log out of ~/.claude (`claude auth logout`)
//   somora claude status   read-only view of both credential stores
//   somora claude sync     one-shot reconcile (what the running server's
//                          watcher does continuously)
//   somora claude <args>   anything else goes to that Claude Code
//
// `somora auth …` (the name until 2026-10-14) still works and says so.
//
// Deliberately logger-free and side-effect-free on `status`: the config
// file is read raw (js-yaml, no schema validation, no default-config
// bootstrap) just for the sharedUserCredentials gate.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { claudeBinaryForLogin } from './claude-bin.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../config/yaml.ts';
import {
  configureClaudeCredentialSync,
  credentialSyncStatus,
  reconcileClaudeCredentials,
} from '../server/claude-credential-sync.ts';

function sharedCredentialsEnabled(): boolean {
  const somoraHome = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  try {
    const raw = readFileSync(join(somoraHome, 'config.yaml'), 'utf8');
    const parsed = parseYaml(raw) as { claudeCli?: { sharedUserCredentials?: unknown } } | null;
    const v = parsed?.claudeCli?.sharedUserCredentials;
    return typeof v === 'boolean' ? v : true; // schema default
  } catch {
    return true;
  }
}

function fmtTs(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function claudeVersion(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? null) : null;
}

function usage(): string {
  const bin = claudeBinaryForLogin();
  const version = bin ? claudeVersion(bin.path) : null;
  const label = !bin ? 'not found' : bin.bundled ? `bundled Claude Code ${version ?? '?'}` : `${bin.path}${version ? ` ${version}` : ''}`;
  const somoraHome = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  const s = credentialSyncStatus();
  const exp = s.somoraExpiresAt ?? s.userExpiresAt;
  const login = !s.somoraExists && !s.userExists ? 'none — run `somora claude login`' : exp && exp > Date.now() ? `valid until ${fmtTs(exp).slice(0, 16)} UTC (renewed by Claude Code)` : 'expired — run `somora claude login`';
  return [
    `somora claude — Claude Code (${label})`,
    '',
    'Usage: somora claude <claude args...>',
    '  somora claude login               sign in with your Claude subscription (shows a link, you paste the code back)',
    '  somora claude logout              sign out of your Claude home; somora keeps its own copy until the next login',
    '  somora claude status              both login stores: age, expiry, in step or not',
    '  somora claude sync                bring the two stores in step now',
    '  somora claude --version',
    '',
    `Claude home (yours):  ${join(homedir(), '.claude')}`,
    `Claude home (somora): ${process.env.CLAUDE_CONFIG_DIR ?? join(somoraHome, 'claude-home')}  (login kept in step with yours)`,
    `Login:                ${login}`,
    '',
  ].join('\n');
}

export function runClaudeCli(args: string[]): number {
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(usage());
    return 0;
  }
  // Everything but somora's own four goes to Claude Code as it is, like
  // `somora codex …` and `somora grok …` do.
  if (!['login', 'logout', 'status', 'sync'].includes(cmd)) {
    const bin = claudeBinaryForLogin();
    if (!bin) {
      process.stderr.write('no Claude Code binary found — the bundled one is missing; reinstall somora, or install Claude Code: curl -fsSL https://claude.ai/install.sh | bash\n');
      return 1;
    }
    const r = spawnSync(bin.path, args, { stdio: 'inherit' });
    if (r.error) {
      process.stderr.write(`somora claude: ${r.error.message}\n`);
      return 1;
    }
    return r.status ?? 1;
  }

  const enabled = sharedCredentialsEnabled();
  configureClaudeCredentialSync({
    enabled,
    log: {
      info: (d) => process.stdout.write(`${JSON.stringify(d)}\n`),
      warn: (d) => process.stderr.write(`${JSON.stringify(d)}\n`),
    },
  });

  if (cmd === 'login') {
    const bin = claudeBinaryForLogin();
    if (!bin) {
      process.stderr.write('no Claude Code binary found — the bundled one is missing; reinstall somora, or install Claude Code: curl -fsSL https://claude.ai/install.sh | bash\n');
      return 1;
    }
    process.stdout.write(`Claude Code ${bin.bundled ? '(bundled with somora)' : `at ${bin.path}`} — it shows a link: open it in any browser, approve, paste the code back here.\n`);
    const r = spawnSync(bin.path, ['auth', 'login'], { stdio: 'inherit' });
    if (r.status !== 0) return r.status ?? 1;
    if (enabled) {
      const result = reconcileClaudeCredentials();
      if (result === 'unavailable') return 1;
    }
    process.stdout.write('logged in. somora uses this login for the claude-cli engine.\n');
    return 0;
  }

  if (cmd === 'logout') {
    const bin = claudeBinaryForLogin();
    if (!bin) {
      process.stderr.write('no Claude Code binary found — the bundled one is missing; reinstall somora.\n');
      return 1;
    }
    const r = spawnSync(bin.path, ['auth', 'logout'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stdout.write('signed out of your Claude home. somora keeps its own copy of the login until you log in again (`somora claude status` shows both).\n');
    }
    return r.status ?? 1;
  }

  if (cmd === 'status') {
    const s = credentialSyncStatus();
    const now = Date.now();
    const side = (label: string, exists: boolean, mtime: number | null, exp: number | null): void => {
      process.stdout.write(`${label}\n`);
      if (!exists) {
        process.stdout.write('    (missing)\n');
        return;
      }
      const expState =
        exp === null ? 'unparseable' : exp > now ? `valid until ${fmtTs(exp)}` : `EXPIRED ${fmtTs(exp)}`;
      process.stdout.write(`    modified  ${fmtTs(mtime)}\n`);
      process.stdout.write(`    oauth     ${expState}\n`);
    };
    side(`  user   ${s.userPath}`, s.userExists, s.userMtimeMs, s.userExpiresAt);
    side(`  somora ${s.somoraPath}${s.somoraIsSymlink ? '  (symlink)' : ''}`, s.somoraExists, s.somoraMtimeMs, s.somoraExpiresAt);
    process.stdout.write(`  sharing   ${enabled ? 'enabled (claudeCli.sharedUserCredentials)' : 'DISABLED via config'}\n`);
    if (s.userExists && s.somoraExists) {
      if (s.identical) {
        process.stdout.write('  state     in sync — both sides share one OAuth chain\n');
      } else {
        const winner =
          (s.userExpiresAt ?? 0) === (s.somoraExpiresAt ?? 0)
            ? 'undecided (mtime tie-break)'
            : (s.userExpiresAt ?? 0) > (s.somoraExpiresAt ?? 0)
              ? 'user side'
              : 'somora side';
        process.stdout.write(`  state     DIVERGED — newest chain: ${winner}. Run \`somora claude sync\` (or let the running server's watcher heal it).\n`);
      }
    }
    return 0;
  }

  if (cmd === 'sync') {
    if (!enabled) {
      process.stderr.write(
        'claudeCli.sharedUserCredentials is disabled in config.yaml — somora runs on separate credentials by choice; refusing to sync.\n',
      );
      return 1;
    }
    const result = reconcileClaudeCredentials();
    const explain: Record<string, string> = {
      noop: 'already in sync (or nothing to sync)',
      pulled: 'user-side login copied onto the somora side',
      pushed: 'somora-side login copied back into ~/.claude',
      unavailable: 'sync failed — see warning above',
    };
    process.stdout.write(`${result}: ${explain[result] ?? result}\n`);
    return result === 'unavailable' ? 1 : 0;
  }

  return 1;
}

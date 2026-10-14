// `somora codex [args...]` — run the bundled Codex CLI.
//
// Codex is a pinned dependency of somora (design
// private/codex-app-server-design.md §2), so there need not be a global
// `codex` on the host. `somora codex login` signs in to the user's normal
// Codex home (~/.codex, or $CODEX_HOME); the engine mirrors that auth.json
// into somora's own home on every turn.

import { spawnSync } from 'node:child_process';
import { codexAppServerArgv, resolveCodexLaunch } from '../engine/codex-bin.ts';
import { codexAuthState, syncCodexAuth, somoraCodexHome, userCodexHome } from '../engine/codex-home.ts';
import { join } from 'node:path';

export async function runCodexCli(args: string[]): Promise<number> {
  const launch = resolveCodexLaunch();
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    // The login lives in your Codex home; somora mirrors it.
    const auth = codexAuthState(join(userCodexHome(), 'auth.json'));
    const login =
      auth.kind === 'none'
        ? 'none — run `somora codex login`'
        : auth.kind === 'apikey'
          ? 'API key'
          : auth.expiresAt > Date.now()
            ? `valid until ${new Date(auth.expiresAt).toISOString().replace('T', ' ').slice(0, 16)} UTC (renewed by Codex)`
            : auth.expiresAt > 0
              ? 'expired — Codex renews it on the next turn; if that fails, run `somora codex login`'
              : 'signed in (expiry unreadable)';
    process.stdout.write(
      [
        `somora codex — bundled Codex CLI (${launch.source === 'bundled' ? `@openai/codex ${launch.version ?? '?'}` : `override ${launch.command}`})`,
        '',
        'Usage: somora codex <codex args...>',
        '  somora codex login              sign in (ChatGPT) — stored in your Codex home, mirrored to somora',
        '  somora codex logout',
        '  somora codex debug models       model catalog as this Codex sees it',
        '  somora codex features list      feature flags of the bundled version',
        '  somora codex --version',
        '',
        `Codex home (yours):  ${userCodexHome()}`,
        `Codex home (somora): ${somoraCodexHome()}  (login mirrored from yours)`,
        `Login:               ${login}`,
        `App server:          ${[launch.command, ...codexAppServerArgv(launch)].join(' ')}`,
        '',
      ].join('\n'),
    );
    return 0;
  }
  const result = spawnSync(launch.command, [...launch.args, ...args], { stdio: 'inherit' });
  const status = syncCodexAuth();
  if (args[0] === 'login' && status.action === 'copied') {
    process.stdout.write(`somora: Codex login mirrored to ${status.somoraAuthPath}\n`);
  }
  return result.status ?? 1;
}

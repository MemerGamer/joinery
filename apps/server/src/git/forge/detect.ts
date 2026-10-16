/** Which forge an origin host is, decided once at registration and stored on the repo. */
import { localToken } from './cli.ts';
import type { ForgeKind } from '@joinery/core';

/**
 * `github.com` is GitHub; `gitlab.com` and any host with "gitlab" in its name
 * is GitLab. Any other host (self-hosted GitHub Enterprise, a custom GitLab
 * domain) is decided from local CLI login state, never the network (the host may be
 * behind a VPN that's off): a `glab` token for the host means GitLab, else a
 * `gh` token means GitHub, else `'none'`. Never throws; a missing CLI just
 * has no token.
 */
export async function detectForge(host: string, cwd: string): Promise<ForgeKind> {
  const h = host.toLowerCase();
  if (h === 'github.com') return 'github';
  if (h === 'gitlab.com' || h.includes('gitlab')) return 'gitlab';
  if (await localToken('glab', h, cwd)) return 'gitlab';
  if (await localToken('gh', h, cwd)) return 'github';
  return 'none';
}

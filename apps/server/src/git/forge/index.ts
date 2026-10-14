/** Public surface of the forge layer: the `Forge` seam and the per-repo picker. */
import type { Repo } from '@joinery/core';
import { githubForge } from './github.ts';
import { gitlabForge } from './gitlab.ts';
import { noForge } from './none.ts';
import type { Forge } from './types.ts';

export type {
  Forge,
  ForgeOptions,
  ListOpenPullsResult,
  MergedPrCommits,
  PullSearchHit,
  PullSummary,
  ResolvedPr,
} from './types.ts';

/**
 * The forge for `repo`, from its origin's host. `github.com` is GitHub;
 * `gitlab.com` and any host with "gitlab" in its name (self-hosted) is GitLab;
 * any other host, or no remote at all, is the unsupported forge. A row from
 * before hosts were stored (`remoteHost` null) with an owner/name is treated as
 * GitHub. No repo (`undefined`) is the unsupported forge too.
 */
export function forgeFor(repo: Pick<Repo, 'remoteHost' | 'remoteOwner' | 'remoteName'> | undefined): Forge {
  if (repo === undefined || repo.remoteOwner === null || repo.remoteName === null) return noForge;
  if (repo.remoteHost === null || repo.remoteHost === 'github.com') return githubForge;
  return repo.remoteHost.includes('gitlab') ? gitlabForge : noForge;
}

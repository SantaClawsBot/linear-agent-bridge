// === GitHub Org Repo Resolver ===
// Auto-fetches repos from a GitHub org and uses Linear's
// issueRepositorySuggestions to pick the right one for each issue.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi, PluginConfig } from "../types.js";
import { callLinear } from "../linear-client.js";
import { REPO_SUGGESTIONS_QUERY } from "../graphql/queries.js";

const execFile = promisify(execFileCb);

interface OrgRepo {
  hostname: string;
  fullName: string;
  cloneUrl: string;
  /** Local directory if already cloned */
  dir?: string;
}

interface CachedOrgRepos {
  repos: OrgRepo[];
  fetchedAt: number;
}

const MIN_CONFIDENCE = 0.5;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cache: CachedOrgRepos | null = null;

function reposCacheDir(): string {
  // Default to a repos directory next to the workspace
  return join(process.env.HOME ?? "/tmp", ".openclaw/repos");
}

/**
 * Fetch all repos from a GitHub org via `gh api`.
 * Returns an array of { hostname, fullName, cloneUrl }.
 */
async function fetchOrgRepos(org: string): Promise<OrgRepo[]> {
  const { stdout } = await execFile("gh", [
    "api",
    `orgs/${org}/repos`,
    "--paginate",
    "--jq",
    // eslint-disable-next-line no-template-curly-in-string
    '.[] | { hostname: "github.com", fullName: .full_name, cloneUrl: .clone_url }',
  ], {
    timeout: 30_000,
    env: { ...process.env },
  });

  const lines = stdout.trim().split("\n").filter(Boolean);
  const repos: OrgRepo[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as OrgRepo;
      if (parsed.hostname && parsed.fullName) {
        repos.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return repos;
}

/**
 * Get the list of repos for the configured GitHub org.
 * Results are cached for CACHE_TTL_MS.
 */
async function getOrgRepos(org: string): Promise<OrgRepo[]> {
  if (cache && cache.repos.length > 0 && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.repos;
  }
  const repos = await fetchOrgRepos(org);
  cache = { repos, fetchedAt: Date.now() };
  return repos;
}

/**
 * Resolve the best matching repo for an issue using Linear's
 * issueRepositorySuggestions API.
 * Returns the repo object or null if no match above MIN_CONFIDENCE.
 */
async function suggestRepo(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
  sessionId: string,
  candidates: OrgRepo[],
): Promise<OrgRepo | null> {
  if (candidates.length === 0) return null;

  const result = await callLinear(api, cfg, "issueRepositorySuggestions", {
    query: REPO_SUGGESTIONS_QUERY,
    variables: {
      issueId,
      agentSessionId: sessionId,
      candidateRepositories: candidates.map((r) => ({
        hostname: r.hostname,
        repositoryFullName: r.fullName,
      })),
    },
  });

  if (!result.ok || !result.data) return null;

  const suggestions = ((result.data.issueRepositorySuggestions as Record<string, unknown>)?.suggestions ?? []) as Array<{
    repositoryFullName: string;
    hostname: string;
    confidence: number;
  }>;

  for (const s of suggestions) {
    if (s.confidence >= MIN_CONFIDENCE) {
      const match = candidates.find(
        (r) => r.fullName === s.repositoryFullName && r.hostname === s.hostname,
      );
      if (match) return match;
    }
  }
  return null;
}

/**
 * Ensure a repo is cloned locally. Returns the directory path.
 * If already cloned (via dir), returns that. Otherwise clones into
 * the repos cache directory.
 */
function ensureCloned(repo: OrgRepo, baseDir: string): string {
  if (repo.dir && existsSync(repo.dir)) {
    return repo.dir;
  }
  // Derive a local path: ~/.openclaw/repos/<org>/<repo-name>
  const parts = repo.fullName.split("/");
  const dir = join(baseDir, parts[0], parts[1]);
  if (existsSync(dir)) {
    return dir;
  }
  return dir; // caller should clone; we return the target dir
}

/**
 * Main entry point: resolve the working directory for an issue.
 * Falls back to the static resolveRepo result if no org is configured
 * or if suggestions don't match.
 */
export async function resolveRepoWithOrg(
  api: OpenClawPluginApi,
  cfg: PluginConfig,
  issueId: string,
  sessionId: string,
  staticRepo: string,
  team: string,
  proj: string,
): Promise<{ dir: string; suggested: boolean; repoName?: string }> {
  // If no githubOrg configured, return the static mapping
  if (!cfg.githubOrg) {
    return { dir: staticRepo, suggested: false };
  }

  // If static mapping already resolved a dir, use it
  if (staticRepo) {
    return { dir: staticRepo, suggested: false };
  }

  // Fetch org repos
  let repos: OrgRepo[];
  try {
    repos = await getOrgRepos(cfg.githubOrg);
  } catch (err) {
    api.logger.warn?.(
      `linear: failed to fetch org repos for ${cfg.githubOrg}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { dir: staticRepo, suggested: false };
  }

  if (repos.length === 0) {
    return { dir: staticRepo, suggested: false };
  }

  // Ask Linear for suggestions
  if (!issueId || !sessionId) {
    return { dir: staticRepo, suggested: false };
  }

  const match = await suggestRepo(api, cfg, issueId, sessionId, repos);
  if (!match) {
    api.logger.info?.(
      `linear: no repo suggestion above ${MIN_CONFIDENCE * 100}% confidence for issue ${issueId.slice(0, 8)}...`,
    );
    return { dir: staticRepo, suggested: false };
  }

  api.logger.info?.(
    `linear: repo suggestion matched ${match.fullName} for issue ${issueId.slice(0, 8)}...`,
  );

  const baseDir = reposCacheDir();
  const dir = ensureCloned(match, baseDir);

  // Auto-clone if the directory doesn't exist yet
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
      const { execFile: ef } = await import("node:child_process");
      const { promisify: p } = await import("node:util");
      const pe = p(ef);
      await pe("git", ["clone", "--depth", "1", match.cloneUrl, dir], {
        timeout: 60_000,
      });
      api.logger.info?.(`linear: cloned ${match.fullName} to ${dir}`);
    } catch (err) {
      api.logger.warn?.(
        `linear: failed to clone ${match.fullName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { dir: staticRepo, suggested: false };
    }
  }

  return { dir, suggested: true, repoName: match.fullName };
}

/** Invalidate the org repos cache (for testing or manual refresh) */
export function invalidateRepoCache(): void {
  cache = null;
}

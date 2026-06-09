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
  archived: boolean;
  pushedAt: string;
  /** Local directory if already cloned */
  dir?: string;
}

/** Default max age for repos to include (days since last push). */
const DEFAULT_MAX_AGE_DAYS = 365;
/** Max candidates to send to Linear's suggestion API. */
const MAX_CANDIDATES = 50;
/** Minimum confidence threshold to accept a suggestion. */
const MIN_CONFIDENCE = 0.5;
/** Cache TTL for org repo list. */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedOrgRepos {
  repos: OrgRepo[];
  fetchedAt: number;
}

let cache: CachedOrgRepos | null = null;

function reposCacheDir(): string {
  return join(process.env.HOME ?? "/tmp", ".openclaw/repos");
}

/**
 * Fetch repos from a GitHub org via `gh api`, filtering out:
 * - Archived repos
 * - Repos with no pushes (empty templates)
 * - Repos not pushed to within maxAgeDays
 *
 * Returns repos sorted by most recent push (newest first).
 */
async function fetchOrgRepos(org: string, maxAgeDays: number): Promise<OrgRepo[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffIso = cutoff.toISOString();

  const { stdout } = await execFile("gh", [
    "api",
    `orgs/${org}/repos`,
    "--paginate",
    "--jq",
    '.[] | { hostname: "github.com", fullName: .full_name, cloneUrl: .clone_url, archived: .archived, pushedAt: .pushed_at }',
  ], {
    timeout: 30_000,
    env: { ...process.env },
  });

  const lines = stdout.trim().split("\n").filter(Boolean);
  const repos: OrgRepo[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as OrgRepo;
      if (parsed.archived || !parsed.pushedAt) continue;
      if (parsed.pushedAt < cutoffIso) continue;
      if (parsed.hostname && parsed.fullName) {
        repos.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }

  // Sort by most recently pushed
  repos.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  return repos;
}

/**
 * Get the list of repos for the configured GitHub org.
 * Results are cached for CACHE_TTL_MS.
 */
async function getOrgRepos(org: string, maxAgeDays: number): Promise<OrgRepo[]> {
  if (cache && cache.repos.length > 0 && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.repos;
  }
  const repos = await fetchOrgRepos(org, maxAgeDays);
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
      candidateRepositories: candidates.slice(0, MAX_CANDIDATES).map((r) => ({
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
 */
function ensureCloned(repo: OrgRepo, baseDir: string): string {
  if (repo.dir && existsSync(repo.dir)) {
    return repo.dir;
  }
  const parts = repo.fullName.split("/");
  const dir = join(baseDir, parts[0], parts[1]);
  return dir;
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
  if (!cfg.githubOrg) {
    return { dir: staticRepo, suggested: false };
  }

  // If static mapping already resolved a dir, use it
  if (staticRepo) {
    return { dir: staticRepo, suggested: false };
  }

  const maxAgeDays = typeof cfg.githubRepoMaxAgeDays === "number" && cfg.githubRepoMaxAgeDays > 0
    ? cfg.githubRepoMaxAgeDays
    : DEFAULT_MAX_AGE_DAYS;

  // Fetch org repos (filtered)
  let repos: OrgRepo[];
  try {
    repos = await getOrgRepos(cfg.githubOrg, maxAgeDays);
  } catch (err) {
    api.logger.warn?.(
      `linear: failed to fetch org repos for ${cfg.githubOrg}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { dir: staticRepo, suggested: false };
  }

  if (repos.length === 0) {
    api.logger.info?.(`linear: no active repos found for org ${cfg.githubOrg} (max age: ${maxAgeDays}d)`);
    return { dir: staticRepo, suggested: false };
  }

  // Apply optional name pattern filter
  let candidates = repos;
  if (cfg.githubRepoFilter) {
    const pattern = cfg.githubRepoFilter;
    candidates = repos.filter((r) => {
      const name = r.fullName.split("/")[1] ?? r.fullName;
      return name.includes(pattern);
    });
    if (candidates.length === 0) {
      api.logger.info?.(`linear: githubRepoFilter "${pattern}" matched zero repos, falling back`);
      candidates = repos;
    }
  }

  api.logger.info?.(
    `linear: ${candidates.length} candidate repos for ${cfg.githubOrg} (of ${repos.length} total)`,
  );

  // Ask Linear for suggestions
  if (!issueId || !sessionId) {
    return { dir: staticRepo, suggested: false };
  }

  const match = await suggestRepo(api, cfg, issueId, sessionId, candidates);
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
      mkdirSync(join(dir, ".."), { recursive: true });
      const { execFile: ef } = await import("node:child_process");
      const { promisify: p } = await import("node:util");
      const pe = p(ef);
      await pe("git", ["clone", "--depth", "1", match.cloneUrl, dir], {
        timeout: 120_000,
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

import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import { postActivity } from "../webhook/handler.js";
import { SESSION_UPDATE_MUTATION } from "../graphql/mutations.js";
import { readString, readObject, sendJson } from "../util.js";
import type { OpenClawPluginApi } from "../types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Run a git command in the given directory */
async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
}

/** Run gh CLI command in the given directory */
async function gh(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, {
    cwd,
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
}

/** Sanitize a string for use as a git branch name */
function sanitizeBranchPart(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
}

/**
 * Resolve the effective working directory for an issue.
 *
 * If a worktree exists for this issue identifier under <repoDir>/.openclaw-worktrees/<id>-<slug>,
 * return it. Otherwise return the base repoDir (legacy behaviour).
 *
 * The worktree is created by pr/branch if worktree isolation is available.
 */
function resolveWorktreeDir(
  repoDir: string,
  issueIdentifier: string,
  issueTitle: string,
): string {
  const slug = sanitizeBranchPart(issueTitle);
  const id = issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const worktreeName = `${id}-${slug}`;
  const worktreesRoot = path.join(repoDir, ".openclaw-worktrees");
  const candidate = path.join(worktreesRoot, worktreeName);
  try {
    if (fs.existsSync(path.join(candidate, ".git"))) {
      return candidate;
    }
  } catch {
    // ignore
  }
  return repoDir;
}

/**
 * Get the effective working directory for an issue session.
 * Uses worktree isolation if available, falls back to the base repo dir.
 */
function getEffectiveDir(context: { repoDir: string; issueIdentifier: string; issueTitle: string }): string {
  return resolveWorktreeDir(context.repoDir, context.issueIdentifier, context.issueTitle);
}

// POST /pr/branch — create an isolated worktree + branch for the issue
registerApiHandler(
  "/pr/branch",
  async ({ api, cfg, context, body, res }) => {
    const repoDir = context.repoDir;
    if (!repoDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }

    // Allow caller to specify branch name, or auto-generate
    let branch = readString(body.branch as string);
    if (!branch) {
      const prefix = cfg.branchPrefix ?? "linear";
      const id = context.issueIdentifier
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-");
      const slug = sanitizeBranchPart(context.issueTitle);
      branch = `${prefix}/${id}-${slug}`;
    }

    const baseBranch = readString(body.base as string);
    const worktreeName = `${context.issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${sanitizeBranchPart(context.issueTitle)}`;
    const worktreesRoot = path.join(repoDir, ".openclaw-worktrees");
    const worktreeDir = path.join(worktreesRoot, worktreeName);

    try {
      // Fetch latest
      await git(["fetch", "origin"], repoDir).catch(() => {});

      // Determine the starting ref
      const startRef = baseBranch ? `origin/${baseBranch}` : "HEAD";

      // Check if worktree already exists
      const worktreeExists = fs.existsSync(path.join(worktreeDir, ".git"));

      if (worktreeExists) {
        // Reuse existing worktree — just make sure we're on the right branch
        api.logger.info?.(`linear pr/branch: reusing existing worktree at ${worktreeDir}`);
        try {
          await git(["checkout", branch], worktreeDir);
        } catch {
          // Branch might not exist yet — create it
          await git(["checkout", "-b", branch, startRef], worktreeDir);
        }
        sendJson(res, 200, { ok: true, branch, worktree: worktreeDir });
        return;
      }

      // Try git worktree add (requires git 2.5+)
      try {
        // Ensure worktrees directory exists
        fs.mkdirSync(worktreesRoot, { recursive: true });

        // Create branch from startRef in the main repo
        try {
          await git(["branch", branch, startRef], repoDir);
        } catch (branchErr) {
          // Branch might already exist — that's fine
          const errMsg = branchErr instanceof Error ? branchErr.message : String(branchErr);
          if (!errMsg.includes("already exists")) throw branchErr;
        }

        // Create worktree for this branch
        await git(["worktree", "add", worktreeDir, branch], repoDir);

        api.logger.info?.(`linear pr/branch: created worktree at ${worktreeDir} for branch ${branch}`);
        sendJson(res, 200, { ok: true, branch, worktree: worktreeDir });
      } catch (worktreeErr) {
        // Worktree failed — fall back to in-place checkout
        const errMsg = worktreeErr instanceof Error ? worktreeErr.message : String(worktreeErr);
        api.logger.info?.(`linear pr/branch: worktree failed (${errMsg}), falling back to in-place checkout`);
        await git(["checkout", "-b", branch, startRef], repoDir);
        sendJson(res, 200, { ok: true, branch, worktree: null });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.warn?.(`linear pr/branch failed: ${msg}`);
      sendJson(res, 500, { ok: false, error: `git branch failed: ${msg}` });
    }
  },
);

// POST /pr/create — create a pull request via gh CLI
registerApiHandler(
  "/pr/create",
  async ({ api, cfg, context, body, res }) => {
    const effectiveDir = context.repoDir ? getEffectiveDir(context) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }

    const title =
      readString(body.title as string) ||
      `${context.issueIdentifier} ${context.issueTitle}`;
    const bodyText =
      readString(body.body as string) ||
      `Closes ${context.issueUrl}`;
    const baseBranch = readString(body.base as string) ?? "main";
    const draft = body.draft === true;
    const labels = Array.isArray(body.labels) ? body.labels : [];
    const reviewers = Array.isArray(body.reviewers) ? body.reviewers : [];

    // Push current branch first
    try {
      const { stdout: currentBranch } = await git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        effectiveDir,
      );
      const branch = currentBranch.trim();
      if (!branch || branch === "HEAD") {
        sendJson(res, 400, {
          ok: false,
          error: "Not on a branch. Call pr/branch first.",
        });
        return;
      }

      await git(["push", "-u", "origin", branch], effectiveDir);

      // Build gh pr create command
      const ghArgs = [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        bodyText,
        "--base",
        baseBranch,
      ];
      if (draft) ghArgs.push("--draft");
      for (const label of labels) {
        if (typeof label === "string") {
          ghArgs.push("--label", label);
        }
      }
      for (const reviewer of reviewers) {
        if (typeof reviewer === "string") {
          ghArgs.push("--reviewer", reviewer);
        }
      }

      const { stdout } = await gh(ghArgs, effectiveDir);
      const prUrl = stdout.trim().split("\n").pop() || stdout.trim();

      // Extract PR number from URL
      const prMatch = prUrl.match(/\/pull\/(\d+)$/);
      const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;

      // Post PR URL to Linear session if configured
      if (cfg.prReportToLinear !== false && context.sessionId) {
        // Post as external URL on session
        await callLinear(api, cfg, "agentSessionUpdate(prUrl)", {
          query: SESSION_UPDATE_MUTATION,
          variables: {
            id: context.sessionId,
            input: {
              addedExternalUrls: [
                { label: "Pull Request", url: prUrl },
              ],
            },
          },
        }).catch(() => {});

        // Post as activity
        await postActivity(
          api,
          cfg,
          context.sessionId,
          {
            type: "action",
            action: "opened",
            parameter: "pull request",
            result: `[${title}](${prUrl})`,
          },
        ).catch(() => {});
      }

      // Clean up the worktree after successful PR creation
      await cleanupWorktree(api, context.repoDir, context.issueIdentifier, context.issueTitle, branch);

      sendJson(res, 200, {
        ok: true,
        prUrl,
        prNumber,
        branch,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      api.logger.warn?.(`linear pr/create failed: ${msg}`);
      sendJson(res, 500, { ok: false, error: `PR creation failed: ${msg}` });
    }
  },
);

// POST /pr/commit — stage all changes and commit
registerApiHandler(
  "/pr/commit",
  async ({ api, context, body, res }) => {
    const effectiveDir = context.repoDir ? getEffectiveDir(context) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }

    const message =
      readString(body.message as string) ||
      `${context.issueIdentifier}: ${context.issueTitle}`;
    const all = body.all !== false; // default to true
    const allowEmpty = body.allowEmpty === true;

    try {
      if (all) {
        await git(["add", "-A"], effectiveDir);
      } else if (Array.isArray(body.files)) {
        for (const f of body.files) {
          if (typeof f === "string") await git(["add", f], effectiveDir);
        }
      }

      const commitArgs = ["commit", "-m", message];
      if (allowEmpty) commitArgs.push("--allow-empty");
      await git(commitArgs, effectiveDir);

      const { stdout: short } = await git(
        ["rev-parse", "--short", "HEAD"],
        effectiveDir,
      );

      sendJson(res, 200, { ok: true, commit: short.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `git commit failed: ${msg}` });
    }
  },
);

// POST /pr/status — show git status of the effective working directory
registerApiHandler(
  "/pr/status",
  async ({ context, res }) => {
    const effectiveDir = context.repoDir ? getEffectiveDir(context) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }

    try {
      const { stdout: status } = await git(
        ["status", "--porcelain=v1"],
        effectiveDir,
      );
      const { stdout: branch } = await git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        effectiveDir,
      );
      const { stdout: log } = await git(
        ["log", "--oneline", "-5"],
        effectiveDir,
      );

      const isWorktree = effectiveDir !== context.repoDir;
      sendJson(res, 200, {
        ok: true,
        branch: branch.trim(),
        dirty: status.trim().split("\n").filter(Boolean).length,
        status: status.trim(),
        recentCommits: log.trim(),
        worktree: isWorktree ? effectiveDir : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `git status failed: ${msg}` });
    }
  },
);

// POST /pr/cleanup — manually clean up a worktree for this issue
registerApiHandler(
  "/pr/cleanup",
  async ({ api, context, res }) => {
    if (!context.repoDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }
    try {
      await cleanupWorktree(api, context.repoDir, context.issueIdentifier, context.issueTitle);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `Worktree cleanup failed: ${msg}` });
    }
  },
);

/**
 * Remove a worktree after PR is created or on explicit cleanup.
 * Safe to call even if no worktree exists.
 */
async function cleanupWorktree(
  api: OpenClawPluginApi,
  repoDir: string,
  issueIdentifier: string,
  issueTitle: string,
  branch?: string,
): Promise<void> {
  const worktreeName = `${issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${sanitizeBranchPart(issueTitle)}`;
  const worktreeDir = path.join(repoDir, ".openclaw-worktrees", worktreeName);

  if (!fs.existsSync(path.join(worktreeDir, ".git"))) return;

  try {
    // Remove the worktree from the main repo
    await git(["worktree", "remove", worktreeDir, "--force"], repoDir);
    api.logger.info?.(`linear pr: cleaned up worktree ${worktreeDir}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.warn?.(`linear pr: worktree cleanup failed (${msg}), attempting manual removal`);
    // Best-effort manual removal
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
      // Prune worktree metadata
      await git(["worktree", "prune"], repoDir).catch(() => {});
    } catch {
      // Give up silently
    }
  }
}

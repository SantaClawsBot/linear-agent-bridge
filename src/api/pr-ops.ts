import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import { postActivity } from "../webhook/handler.js";
import { SESSION_UPDATE_MUTATION } from "../graphql/mutations.js";
import { readString, readObject, sendJson } from "../util.js";

/**
 * Resolve the working directory for a PR action.
 * Priority: explicit `dir` in body → context.repoDir.
 * This lets the agent work in arbitrary repos (e.g. freshly cloned)
 * instead of being locked to the session's configured repoDir.
 */
function resolveDir(
  body: Record<string, unknown>,
  context: { repoDir: string },
): string {
  const dir = readString(body.dir as string);
  return dir || context.repoDir;
}
import { formatConventionalTitle } from "../agent/repo-conventions.js";
import { addSessionPR, getSessionPRs } from "../agent/pr-tracker.js";
import type { OpenClawPluginApi } from "../types.js";
import { execFile, spawn } from "node:child_process";
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
export function getEffectiveDir(context: { repoDir: string; issueIdentifier: string; issueTitle: string }): string {
  return resolveWorktreeDir(context.repoDir, context.issueIdentifier, context.issueTitle);
}

// POST /pr/branch — create an isolated worktree + branch for the issue
registerApiHandler(
  "/pr/branch",
  async ({ api, cfg, context, body, res }) => {
    const repoDir = resolveDir(body, context);
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
      // Fetch latest from origin
      await git(["fetch", "origin"], repoDir).catch(() => {});

      // Determine the starting ref — default to origin/main, not stale HEAD
      const startRef = baseBranch ? `origin/${baseBranch}` : "origin/main";

      // Check if worktree already exists
      const worktreeExists = fs.existsSync(path.join(worktreeDir, ".git"));

      if (worktreeExists) {
        // Reuse existing worktree — pull latest from origin and rebase
        api.logger.info?.(`linear pr/branch: reusing existing worktree at ${worktreeDir}`);
        try {
          await git(["fetch", "origin"], worktreeDir).catch(() => {});
          await git(["checkout", branch], worktreeDir);
          // Rebase onto latest origin/main to pick up upstream changes
          await git(["rebase", startRef], worktreeDir).catch(() => {
            api.logger.info?.(`linear pr/branch: rebase failed, continuing on current branch`);
          });
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
    const repoDir = resolveDir(body, context);
    const overrideContext = { ...context, repoDir };
    const effectiveDir = repoDir ? getEffectiveDir(overrideContext) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue. Pass { dir: \"/path/to/repo\" } or configure defaultDir/repoByTeam/repoByProject." });
      return;
    }

    const title =
      readString(body.title as string) ||
      formatConventionalTitle(overrideContext.issueIdentifier, overrideContext.issueTitle, effectiveDir) ||
      `${overrideContext.issueIdentifier} ${overrideContext.issueTitle}`;
    // Build PR body with optional cross-references to sibling PRs
    const existingPRs = context.sessionId ? getSessionPRs(context.sessionId) : [];
    const explicitBody = readString(body.body as string);
    const closeRef = `Closes ${context.issueUrl}`;
    let bodyText: string;
    if (explicitBody) {
      bodyText = explicitBody;
    } else if (existingPRs.length > 0) {
      // Multi-repo: cross-link sibling PRs
      const siblingLinks = existingPRs
        .map(p => `- ${p.title}: ${p.prUrl}`)
        .join("\n");
      bodyText = `${closeRef}\n\n**Related PRs:**\n${siblingLinks}`;
    } else {
      bodyText = closeRef;
    }
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

      // Auto-review before pushing
      if (cfg.prAutoReview !== false) {
        if (context.sessionId) {
          await postActivity(api, cfg, context.sessionId, {
            type: "thought",
            body: "Running pre-push PR review...",
          }, { ephemeral: true }).catch(() => {});
        }

        const reviewResult = await runClaudePrReview(effectiveDir, {
          aspects: ["code", "errors", "types"],
        });

        if (reviewResult.ok && reviewResult.output) {
          const o = reviewResult.output.toLowerCase();
          const hasIssues =
            (o.includes("critical") && !o.includes("0 critical") && !o.includes("no critical")) ||
            (o.includes("important") && !o.includes("0 important") && !o.includes("no important")) ||
            o.includes("must fix") || o.includes("should fix");

          if (context.sessionId) {
            await postActivity(api, cfg, context.sessionId, {
              type: "action",
              action: hasIssues ? "reviewed" : "reviewed",
              parameter: "pre-push review",
              result: hasIssues
                ? `Review found issues:\n\n${reviewResult.output.slice(0, 1500)}`
                : `No critical or important issues found`,
            }).catch(() => {});
          }

          if (hasIssues) {
            sendJson(res, 200, {
              ok: false,
              blocked: true,
              reason: "PR review found issues that should be fixed before pushing",
              review: reviewResult.output,
              branch,
            });
            return;
          }
        }
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

      // Record PR in session tracker for cross-referencing
      if (context.sessionId) {
        addSessionPR(context.sessionId, {
          repoName: effectiveDir.split("/").pop() || effectiveDir,
          prUrl,
          prNumber,
          branch,
          title,
        });
      }

      // Clean up the worktree after successful PR creation
      await cleanupWorktree(api, repoDir, overrideContext.issueIdentifier, overrideContext.issueTitle, branch);

      // Auto-post a PR-created action activity (not activity/response — that ends the session)
      if (cfg.prReportToLinear !== false && context.sessionId) {
        const allPRs = getSessionPRs(context.sessionId);
        const isMultiRepo = allPRs.length > 1;
        const respBody = isMultiRepo
          ? `${allPRs.length} PRs created:\n${allPRs.map(p => `- [${p.title}](${p.prUrl}) (${p.repoName})`).join("\n")}`
          : `PR created: [${title}](${prUrl})`;
        await postActivity(api, cfg, context.sessionId, {
          type: "action",
          action: "pr-created",
          parameter: isMultiRepo ? `${allPRs.length} PRs` : `PR #${prNumber}`,
          result: respBody,
        }).catch((e) =>
          api.logger.warn?.(`linear: failed to post PR activity: ${e instanceof Error ? e.message : String(e)}`),
        );
        // Do NOT post activity/response or markResponsePosted here — that ends the session.
        // The handler posts the final activity/response when the agent run completes.
      }

      const allSessionPRs = context.sessionId ? getSessionPRs(context.sessionId) : [];
      sendJson(res, 200, {
        ok: true,
        prUrl,
        prNumber,
        branch,
        sessionPRs: allSessionPRs.length > 1 ? allSessionPRs : undefined,
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
    const repoDir = resolveDir(body, context);
    const effectiveDir = repoDir ? getEffectiveDir({ repoDir, issueIdentifier: context.issueIdentifier, issueTitle: context.issueTitle }) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: 'No repo directory configured. Pass { dir: "/path/to/repo" } or configure defaultDir.' });
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
  async ({ context, body, res }) => {
    const repoDir = resolveDir(body, context);
    const effectiveDir = repoDir ? getEffectiveDir({ repoDir, issueIdentifier: context.issueIdentifier, issueTitle: context.issueTitle }) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: 'No repo directory configured. Pass { dir: "/path/to/repo" } or configure defaultDir.' });
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
  async ({ api, context, body, res }) => {
    const repoDir = resolveDir(body, context);
    if (!repoDir) {
      sendJson(res, 400, { ok: false, error: 'No repo directory configured. Pass { dir: "/path/to/repo" } or configure defaultDir.' });
      return;
    }
    try {
      await cleanupWorktree(api, repoDir, context.issueIdentifier, context.issueTitle);
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

// Auto-detect and link PRs to Linear issue after agent run
export async function autolinkPRToIssue(
  api: OpenClawPluginApi,
  cfg: import("../types.js").PluginConfig,
  context: {
    sessionId: string;
    issueId: string;
    issueIdentifier: string;
    issueTitle: string;
    repoDir: string;
  },
): Promise<void> {
  const { repoDir, issueIdentifier, issueTitle } = context;
  if (!repoDir) return;

  try {
    // Check for worktree or in-repo branches matching the issue
    const slug = issueIdentifier.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    const titleSlug = issueTitle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 48);
    const branchPattern = `${slug}`;

    // List recent PRs and find one matching our branch
    const { stdout } = await gh(
      ["pr", "list", "--state", "open", "--json", "number,url,headRefName,title", "--limit", "10"],
      repoDir,
    ).catch(() => ({ stdout: "[]", stderr: "" }));

    const prs = JSON.parse(stdout || "[]") as Array<{
      number: number;
      url: string;
      headRefName: string;
      title: string;
    }>;

    // Find a PR whose branch name contains the issue identifier slug
    const matchingPR = prs.find(
      (pr) =>
        pr.headRefName.toLowerCase().includes(branchPattern) ||
        pr.title.toLowerCase().includes(issueIdentifier.toLowerCase()),
    );

    if (!matchingPR) return;

    api.logger.info?.(
      `linear: auto-linking PR #${matchingPR.number} (${matchingPR.url}) to session=${context.sessionId?.slice(0, 8)}...`,
    );

    // Link as external URL on the session
    await callLinear(api, cfg, "agentSessionUpdate(prUrl)", {
      query: SESSION_UPDATE_MUTATION,
      variables: {
        id: context.sessionId,
        input: {
          addedExternalUrls: [{ label: `PR #${matchingPR.number}`, url: matchingPR.url }],
        },
      },
    }).catch(() => {});

    // Post as activity
    await postActivity(api, cfg, context.sessionId, {
      type: "action",
      action: "opened",
      parameter: "pull request",
      result: `[${matchingPR.title}](${matchingPR.url})`,
    }).catch(() => {});
  } catch (err) {
    // Non-critical — don't fail the whole handler
    const msg = err instanceof Error ? err.message : String(err);
    api.logger.info?.(`linear: auto-link PR skipped: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// PR Review via Claude CLI (pr-review-toolkit:review-pr)
// ---------------------------------------------------------------------------

/**
 * Run Claude Code PR review in the given repo directory.
 * Works on local git diff — no PR needs to exist.
 * Returns the full review output text synchronously so the caller can act on it.
 */
export async function runClaudePrReview(
  repoDir: string,
  options?: { aspects?: string[]; timeoutMs?: number },
): Promise<{ ok: boolean; output: string; error?: string }> {
  const aspects = options?.aspects?.length ? options.aspects.join(" ") : "";
  const prompt = `/pr-review-toolkit:review-pr ${aspects}`.trim();
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 min default

  return new Promise((resolve) => {
    const args = [
      "-p",
      "--permission-mode", "bypassPermissions",
      "--output-format", "text",
      "--no-session-persistence",
      "--model", "gpt-5.3-codex-spark",
      "--append-system-prompt", "Be concise. Output a compact summary: list only critical and important issues with file:line. Skip suggestions, tips, strengths, and boilerplate. Use bullet points, not prose.",
      prompt,
    ];

    const child = spawn("claude", args, {
      cwd: repoDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8").trim();
      const errOutput = Buffer.concat(errChunks).toString("utf8").trim();

      if (code === 0 && output) {
        resolve({ ok: true, output });
      } else {
        resolve({
          ok: false,
          output: output || "(no output)",
          error: errOutput || `claude exited with code ${code}`,
        });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, output: "", error: err.message });
    });
  });
}

/**
 * POST /pr/review — synchronous PR review via Claude Code.
 *
 * Reviews the local diff (committed changes on the current branch vs base).
 * No PR needs to exist yet — this is for pre-push review cycles.
 *
 * The agent calls this, gets the review back in the JSON response,
 * then decides whether to fix issues, commit, and re-review.
 *
 * Recommended workflow:
 *   1. pr/branch  →  create branch
 *   2. exec      →  write code
 *   3. pr/commit →  stage + commit
 *   4. pr/review →  get review (repeat 2-4 until clean)
 *   5. pr/create →  push + open PR
 */
registerApiHandler(
  "/pr/review",
  async ({ api, cfg, context, body, res }) => {
    const repoDir = resolveDir(body, context);
    const effectiveDir = repoDir ? getEffectiveDir({ repoDir, issueIdentifier: context.issueIdentifier, issueTitle: context.issueTitle }) : "";
    if (!effectiveDir) {
      sendJson(res, 400, { ok: false, error: 'No repo directory configured. Pass { dir: "/path/to/repo" } or configure defaultDir.' });
      return;
    }

    const rawAspects = Array.isArray(body.aspects)
      ? body.aspects.filter((a): a is string => typeof a === "string")
      : [];
    const maxRounds = typeof body.maxRounds === "number" && body.maxRounds > 0
      ? Math.min(body.maxRounds, 5)
      : 1;

    // Let Linear know a review is running (ephemeral — replaced by next activity)
    if (context.sessionId) {
      postActivity(api, cfg, context.sessionId, {
        type: "thought",
        body: `🔍 Running PR review...`,
      }, { ephemeral: true }).catch(() => {});
    }

    // Run review rounds
    const reviews: Array<{ round: number; ok: boolean; output: string; error?: string }> = [];

    for (let round = 1; round <= maxRounds; round++) {
      const result = await runClaudePrReview(effectiveDir, { aspects: rawAspects });
      reviews.push({ round, ...result });

      if (!result.ok) break;

      // Heuristic: if review doesn't flag critical/important issues, consider it clean
      const o = result.output.toLowerCase();
      const hasIssues =
        (o.includes("critical") && !o.includes("0 critical") && !o.includes("no critical")) ||
        (o.includes("important") && !o.includes("0 important") && !o.includes("no important")) ||
        o.includes("must fix") || o.includes("should fix");

      if (!hasIssues) break;
    }

    const lastReview = reviews[reviews.length - 1];
    const allPassed = reviews.every((r) => r.ok);

    // Brief status to Linear — agent gets the full text in the response
    if (context.sessionId && lastReview) {
      await postActivity(api, cfg, context.sessionId, {
        type: "action",
        action: allPassed ? "reviewed" : "review-failed",
        parameter: `local diff (${reviews.length} round${reviews.length > 1 ? "s" : ""})`,
        result: allPassed ? "✅ Code review passed" : `⚠️ Review found issues — see agent log`,
      }).catch(() => {});
    }

    // Compact review text back to the agent — truncate to avoid context overflow
    const MAX_REVIEW_CHARS = 8_000;
    const compactReviews = reviews.map((r) => {
      let output = r.output;
      if (output.length > MAX_REVIEW_CHARS) {
        // Keep the beginning (summary) and tail (action plan)
        const head = output.slice(0, MAX_REVIEW_CHARS * 0.7);
        const tail = output.slice(-MAX_REVIEW_CHARS * 0.3);
        output = `${head}\n\n... (truncated ${output.length - MAX_REVIEW_CHARS} chars) ...\n\n${tail}`;
      }
      return {
        round: r.round,
        ok: r.ok,
        ...(r.error ? { error: r.error } : {}),
        output,
      };
    });

    sendJson(res, 200, {
      ok: allPassed,
      rounds: reviews.length,
      reviews: compactReviews,
    });
  },
);

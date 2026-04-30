import { registerApiHandler } from "./router.js";
import { callLinear } from "../linear-client.js";
import { postActivity } from "../webhook/handler.js";
import { SESSION_UPDATE_MUTATION } from "../graphql/mutations.js";
import { readString, readObject, sendJson } from "../util.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Run a git command in the repo directory */
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

/** Run gh CLI command in the repo directory */
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

// POST /pr/branch — create and checkout a new branch for the issue
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

    try {
      // Fetch latest
      await git(["fetch", "origin"], repoDir).catch(() => {});

      // Create branch from base (or current HEAD)
      const startRef = baseBranch ? `origin/${baseBranch}` : "HEAD";
      await git(["checkout", "-b", branch, startRef], repoDir);

      sendJson(res, 200, { ok: true, branch });
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
    const repoDir = context.repoDir;
    if (!repoDir) {
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
        repoDir,
      );
      const branch = currentBranch.trim();
      if (!branch || branch === "HEAD") {
        sendJson(res, 400, {
          ok: false,
          error: "Not on a branch. Call pr/branch first.",
        });
        return;
      }

      await git(["push", "-u", "origin", branch], repoDir);

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

      const { stdout } = await gh(ghArgs, repoDir);
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
    const repoDir = context.repoDir;
    if (!repoDir) {
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
        await git(["add", "-A"], repoDir);
      } else if (Array.isArray(body.files)) {
        for (const f of body.files) {
          if (typeof f === "string") await git(["add", f], repoDir);
        }
      }

      const commitArgs = ["commit", "-m", message];
      if (allowEmpty) commitArgs.push("--allow-empty");
      await git(commitArgs, repoDir);

      const { stdout: short } = await git(
        ["rev-parse", "--short", "HEAD"],
        repoDir,
      );

      sendJson(res, 200, { ok: true, commit: short.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `git commit failed: ${msg}` });
    }
  },
);

// POST /pr/status — show git status of the repo
registerApiHandler(
  "/pr/status",
  async ({ context, res }) => {
    const repoDir = context.repoDir;
    if (!repoDir) {
      sendJson(res, 400, { ok: false, error: "No repo directory configured for this issue" });
      return;
    }

    try {
      const { stdout: status } = await git(
        ["status", "--porcelain=v1"],
        repoDir,
      );
      const { stdout: branch } = await git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        repoDir,
      );
      const { stdout: log } = await git(
        ["log", "--oneline", "-5"],
        repoDir,
      );

      sendJson(res, 200, {
        ok: true,
        branch: branch.trim(),
        dirty: status.trim().split("\n").filter(Boolean).length,
        status: status.trim(),
        recentCommits: log.trim(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `git status failed: ${msg}` });
    }
  },
);

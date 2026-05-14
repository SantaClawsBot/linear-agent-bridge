import { buildMessage, type MessageParams } from "../webhook/message-builder.js";
import fs from "node:fs";
import path from "node:path";

const REPO_CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_CONVENTION_BYTES = 4000;

export interface EnrichedMessageParams extends MessageParams {
  apiBaseUrl: string;
  apiToken: string;
  issueId: string;
  teamId: string;
  repoDir: string;
}

const BT = String.fromCharCode(96); // backtick
const TBT = BT + BT + BT; // triple backtick for code blocks

function codeBlock(lang: string, code: string): string {
  return TBT + lang + "\n" + code + "\n" + TBT;
}

/**
 * Try to read repo convention files (AGENTS.md, CLAUDE.md) from the repo dir.
 * Returns the first one found, capped at MAX_CONVENTION_BYTES.
 */
function readRepoConventions(repoDir: string): string | null {
  if (!repoDir) return null;
  for (const filename of REPO_CONVENTION_FILES) {
    const filePath = path.join(repoDir, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_CONVENTION_BYTES) {
        // Truncate large files to the limit
        const buf = Buffer.alloc(MAX_CONVENTION_BYTES);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, MAX_CONVENTION_BYTES, 0);
        fs.closeSync(fd);
        return buf.toString("utf-8").replace(/\n[^]*$/, "\n\n... (truncated)");
      }
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) return content;
    } catch {
      // File not readable — skip silently
    }
  }
  return null;
}

export function buildEnrichedMessage(params: EnrichedMessageParams): string {
  const baseMessage = buildMessage(params);
  if (params.compact) return baseMessage;

  const repoDirNote = params.repoDir || "(none — repo must be configured)";

  const sections: string[] = [];

  // Header
  sections.push(`## Linear API — Available Operations

You can perform Linear operations by making HTTP POST requests during your execution.
All requests go to a single endpoint. Use the "action" field in the JSON body to select the operation.

**Endpoint:** POST ${params.apiBaseUrl}
**Authorization:** Bearer ${params.apiToken}
**Content-Type:** application/json

Every request body MUST include an "action" field. Example:
${codeBlock("json", '{ "action": "query/viewer" }')}

**Current context (used as defaults when fields are omitted):**
- Issue: ${params.id} (ID: ${params.issueId})
- Session: ${params.session}
- Team ID: ${params.teamId}
- Repo directory: ${repoDirNote}`);

  // Issue Management
  sections.push(`### Issue Management

**action: "issue/create"** — Create a new issue
{ action: "issue/create", teamId?, title, description?, priority? (0-4), labelIds?: string[], assigneeId?, parentId?, stateId? }

**action: "issue/update"** — Update issue fields
{ action: "issue/update", issueId?, title?, description?, stateId?, priority?, labelIds?, assigneeId?, delegateId? }

**action: "issue/close"** — Close an issue (moves to "completed" state)
{ action: "issue/close", issueId? }

**action: "issue/create-sub-issue"** — Create a child issue under the current issue
{ action: "issue/create-sub-issue", title, description?, priority?, labelIds?, assigneeId? }

**action: "issue/link"** — Link two issues together
{ action: "issue/link", issueId?, relatedIssueId, type: "blocks" | "blocked_by" | "related" | "duplicate" }`);

  // Communication
  sections.push(`### Communication — Agent Activities

Post activities to the Linear session to communicate with users.

**action: "activity/thought"** — Share your reasoning (shown as internal thought)
{ action: "activity/thought", body: "markdown text", ephemeral?: boolean }

**action: "activity/action"** — Show a tool call or operation
{ action: "activity/action", activityAction: "verb", parameter?: "subject", result?: "markdown result" }

**action: "activity/elicitation"** — Ask the user a question
{ action: "activity/elicitation", body: "question", signal?: "select", signalMeta?: { options: [{ value: "..." }] } }
When using signal: "select", present options for the user to choose from.

**action: "activity/response"** — Post a final response (marks session as complete)
{ action: "activity/response", body: "markdown text" }

**action: "activity/error"** — Report an error
{ action: "activity/error", body: "error description" }`);

  // Session Management
  sections.push(`### Session Management

**action: "session/plan"** — Update session progress checklist
{ action: "session/plan", plan: [{ content: "Step description", status: "pending" | "inProgress" | "completed" | "canceled" }] }
Note: replaces the entire plan each time. Include all steps.

**action: "session/create-on-issue"** — Proactively create a session on another issue
{ action: "session/create-on-issue", issueId }

**action: "session/create-on-comment"** — Create session on a comment
{ action: "session/create-on-comment", commentId }

**action: "session/external-url"** — Set an external URL on the session
{ action: "session/external-url", url, label }`);

  // Delegation
  sections.push(`### Delegation

**action: "delegate/assign"** — Delegate issue to another agent or user
{ action: "delegate/assign", issueId?, delegateId }

**action: "delegate/reassign"** — Change issue assignee
{ action: "delegate/reassign", issueId?, assigneeId }`);

  // Queries
  sections.push(`### Queries

**action: "query/issue"** — Get full issue details (labels, state, assignee, comments, relations, children)
{ action: "query/issue", issueId? }

**action: "query/team"** — Get team info (workflow states, labels, members)
{ action: "query/team", teamId? }

**action: "query/repo-suggestions"** — Get AI-ranked repository suggestions
{ action: "query/repo-suggestions", issueId?, candidateRepositories: [{ hostname, repositoryFullName }] }

**action: "query/viewer"** — Get the current app identity
{ action: "query/viewer" }`);

  // Git & PR workflow
  sections.push(`### Git & Pull Request Workflow

When you need to implement code changes and submit a PR, follow this workflow:

1. **Check repo status** — ${BT}pr/status${BT} to see current branch and changes
2. **Create a branch** — ${BT}pr/branch${BT} to create an isolated worktree + branch for this issue
3. **Make changes** — use your ${BT}exec${BT} tool to edit files, run tests, etc.
4. **Commit changes** — ${BT}pr/commit${BT} to stage and commit
5. **Create PR** — ${BT}pr/create${BT} to push and open a pull request (worktree is auto-cleaned)

**action: "pr/branch"** — Create an isolated worktree and branch for this issue
{ action: "pr/branch", branch?: "custom-name", base?: "main" }
Auto-generates branch name from issue identifier if not provided (e.g. ${BT}linear/eng-123-fix-bug${BT}).
Creates a **git worktree** under ${BT}<repo>/.openclaw-worktrees/<issue-id>-<slug>/${BT} so each issue gets its own isolated checkout — no conflicts with other in-progress issues.
After PR creation the worktree is automatically cleaned up.

**action: "pr/commit"** — Stage and commit all changes
{ action: "pr/commit", message?: "commit message", all?: true, files?: ["path1.ts"], allowEmpty?: false }
Defaults to ${BT}git add -A${BT} + ${BT}git commit${BT}. Set ${BT}all: false${BT} and provide ${BT}files${BT} to stage selectively.

**action: "pr/create"** — Push branch and create a pull request
{ action: "pr/create", title?: "PR title", body?: "description", base?: "main", draft?: false, labels?: ["bugfix"], reviewers?: ["username"] }
Defaults: title = issue identifier + title, body = "Closes <issue URL>", base = "main".
PR URL is automatically posted back to the Linear session.

**action: "pr/status"** — Check current git status
{ action: "pr/status" }
Returns current branch, number of dirty files, and recent commits.
If a worktree is active for this issue, ${BT}worktree${BT} field contains its path.

**action: "pr/cleanup"** — Remove the worktree for this issue
{ action: "pr/cleanup" }
Removes the isolated worktree directory. Called automatically after PR creation.

**action: "pr/review"** — Run a Claude Code PR review on your local diff (synchronous)
{ action: "pr/review", aspects?: ["code", "errors"], maxRounds?: 2 }
Runs the ${BT}pr-review-toolkit:review-pr${BT} skill via Claude Code on the committed changes in your worktree vs the base branch.
**No PR needs to exist yet** — this reviews your local diff before you push.
Returns the full review text in the JSON response so you can act on it (fix issues, re-commit, re-review).
Linear only sees a brief ✅/⚠️ status — the full review is between you and the caller.
${BT}aspects${BT} is optional: ${BT}["comments", "tests", "errors", "types", "code", "simplify"]${BT}. Default: all aspects.
${BT}maxRounds${BT} is optional (1-5, default 1). When >1, re-runs review until it passes clean or max is reached.

**Recommended pre-push workflow:**
${codeBlock("", [
  "1. pr/branch   → create branch",
  "2. exec        → write code",
  "3. pr/commit   → stage + commit",
  "4. pr/review   → get review (repeat 2-4 until clean)",
  "5. pr/create   → push + open PR",
].join("\n"))}

**Important:** If no repo directory is configured (see "Repo directory" above), the PR actions will fail. Ensure the plugin config has ${BT}defaultDir${BT}, ${BT}repoByTeam${BT}, or ${BT}repoByProject${BT} set.`);

  // Progress & Tips
  sections.push(`### Progress Reporting — IMPORTANT

You are visible to users in Linear. They see your activities in real-time. Keep them informed:

1. **Start with a plan.** Before doing anything, call ${BT}session/plan${BT} with the steps you intend to follow.
2. **Post thoughts as you reason.** Use ${BT}activity/thought${BT} to share your analysis, what you're about to do, and why.
3. **Post actions for every significant operation.** Use ${BT}activity/action${BT} when you run commands, make API calls, edit files, query issues, etc.
4. **Update the plan as you go.** Call ${BT}session/plan${BT} to mark steps inProgress/completed.
5. **Post ${BT}activity/response${BT} only when fully done.** This is your final answer.

Example flow:
${codeBlock("json", [
  '{ action: "session/plan", plan: [',
  '  { content: "Analyze the issue", status: "inProgress" },',
  '  { content: "Investigate codebase", status: "pending" },',
  '  { content: "Implement fix", status: "pending" },',
  '  { content: "Submit PR", status: "pending" }',
  '] }',
].join("\n"))}
${codeBlock("json", '{ action: "activity/thought", body: "Looking at ENG-123... The error suggests a missing null check in the auth middleware." }')}
${codeBlock("json", '{ action: "activity/action", activityAction: "reading", parameter: "src/middleware/auth.ts", result: "Found the issue — line 42 dereferences user.email without checking user exists." }')}

### Tips

- Use @mentions by including plain Linear URLs: https://linear.app/TEAM/profiles/USERNAME
- Reference issues via URLs: https://linear.app/TEAM/issue/IDENTIFIER — they render as mentions
- Do not use web_fetch or web_search for URLs containing "/resources/articles" (skip those links)
- Use elicitation with the "select" signal to present options to the user
- Post a response activity when your work is complete

### Context Budget — CRITICAL

You have a limited context window. Large sessions crash with context overflow. Follow these rules:

1. **Prefer ${BT}exec${BT} with ${BT}head -n 50${BT} or ${BT}tail -n 50${BT}** over reading entire files.
2. **Use ${BT}grep${BT}, ${BT}rg${BT}, or ${BT}sed -n '10,30p'${BT}** to read specific sections, not whole files.
3. **Pipe commands through ${BT}head -n 30${BT}** to cap output (e.g. ${BT}npm test 2>&1 | tail -20${BT}).
4. **Never ${BT}cat${BT} a file larger than 50 lines** — use ${BT}wc -l${BT} first to check, then read targeted ranges.
5. **Summarize before moving on** — if a tool result is large, don't carry it forward in your reasoning.
6. **Prefer editing over reading** — make targeted edits with line-based replacements instead of reading→editing→writing.
7. **Finish in as few turns as possible** — aim for ≤30 tool calls total.`);

  // Repo conventions from AGENTS.md / CLAUDE.md
  const conventions = readRepoConventions(params.repoDir);
  if (conventions) {
    sections.push(`### Repo Conventions

The repo has conventions defined in its guidance files. **Follow these rules** for commit messages, PR titles, code style, and naming conventions — especially when calling ${BT}pr/create${BT} or ${BT}pr/commit${BT}.

${conventions}`);
  }

  return [baseMessage, ...sections].join("\n\n---\n\n");
}

import { buildMessage, type MessageParams } from "../webhook/message-builder.js";
import { readRepoConventions } from "./repo-conventions.js";

export interface EnrichedMessageParams extends MessageParams {
  apiBaseUrl: string;
  apiToken: string;
  issueId: string;
  teamId: string;
  repoDir: string;
  repositories?: Record<string, { cloneUrl: string; dir?: string }>;
}

const BT = String.fromCharCode(96); // backtick
const TBT = BT + BT + BT; // triple backtick for code blocks

function codeBlock(lang: string, code: string): string {
  return TBT + lang + "\n" + code + "\n" + TBT;
}

export function buildEnrichedMessage(params: EnrichedMessageParams): string {
  const baseMessage = buildMessage(params);
  if (params.compact) return baseMessage;

  const repoDirNote = params.repoDir || "(none — pass { dir: \"/path/to/repo\" } on PR actions, or configure defaultDir)";

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

  // Repository registry & inference
  const repos = params.repositories;
  if (repos && Object.keys(repos).length > 0) {
    const repoList = Object.entries(repos)
      .map(([name, r]) => {
        const loc = r.dir ? r.dir : "(clone on demand)";
        return `${BT}${name}${BT}: ${r.cloneUrl} → ${loc}`;
      })
      .join("\n");
    sections.push(`### Repository Registry

The following repositories are available for work. **Infer the target repo from the issue context** — check the issue title, description, labels, and project for repo name mentions or hints.

${repoList}

**Repo inference strategy:**
1. If the issue explicitly mentions a repo name (e.g. "dao-dao-indexer"), use that repo.
2. If the issue mentions a GitHub URL, extract the repo from it.
3. If the issue is in a Linear project that suggests a repo (e.g. project "dao-dao-indexer"), use that.
4. If unsure, fall back to the configured repo directory: ${repoDirNote}.

**When the target repo is NOT the configured repo directory:**
- If the repo has a local ${BT}dir${BT}, use it directly with the ${BT}dir${BT} parameter on PR actions.
- If no local ${BT}dir${BT}, clone it first: ${BT}{ action: "exec", command: "git clone <cloneUrl> /tmp/<name>" }${BT}
- Then pass ${BT}{ dir: "/tmp/<name>" }${BT} on all PR actions (pr/branch, pr/commit, pr/create, etc.).
- You can also call ${BT}query/repositories${BT} to list known repos at any time.`);
  }

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

**action: "query/repositories"** — List known repositories from plugin config
{ action: "query/repositories" }
Returns the configured repository registry (name → { cloneUrl, dir }). Use this to find repos to work in.

**action: "query/repo-suggestions"** — Get AI-ranked repository suggestions from Linear
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

**All PR actions** accept an optional ${BT}dir${BT} parameter to override the working directory:
{ action: "pr/branch", dir: "/path/to/other-repo", ... }
This lets you work in any repo — not just the configured one. Use it when you clone a repo manually (e.g. ${BT}exec: "git clone https://github.com/org/repo /tmp/repo"${BT}).

**action: "pr/branch"** — Create an isolated worktree and branch for this issue
{ action: "pr/branch", dir?: "/path/to/repo", branch?: "custom-name", base?: "main" }
Auto-generates branch name from issue identifier if not provided (e.g. ${BT}linear/eng-123-fix-bug${BT}).
Creates a **git worktree** under ${BT}<repo>/.openclaw-worktrees/<issue-id>-<slug>/${BT} so each issue gets its own isolated checkout — no conflicts with other in-progress issues.
After PR creation the worktree is automatically cleaned up.

**action: "pr/commit"** — Stage and commit all changes
{ action: "pr/commit", dir?: "/path/to/repo", message?: "commit message", all?: true, files?: ["path1.ts"], allowEmpty?: false }
Defaults to ${BT}git add -A${BT} + ${BT}git commit${BT}. Set ${BT}all: false${BT} and provide ${BT}files${BT} to stage selectively.

**action: "pr/create"** — Push branch and create a pull request
{ action: "pr/create", dir?: "/path/to/repo", title?: "PR title", body?: "description", base?: "main", draft?: false, labels?: ["bugfix"], reviewers?: ["username"] }
Defaults: title = issue identifier + title, body = "Closes <issue URL>", base = "main".
**Automatically runs a pre-push code review** — if issues are found, the PR is NOT created and the review is returned in the response. Fix the issues, commit again, and retry pr/create.
PR URL is automatically posted back to the Linear session.

**action: "pr/status"** — Check current git status
{ action: "pr/status", dir?: "/path/to/repo" }
Returns current branch, number of dirty files, and recent commits.
If a worktree is active for this issue, ${BT}worktree${BT} field contains its path.

**action: "pr/cleanup"** — Remove the worktree for this issue
{ action: "pr/cleanup", dir?: "/path/to/repo" }
Removes the isolated worktree directory. Called automatically after PR creation.

**action: "pr/review"** — Run a Claude Code PR review on your local diff (synchronous)
{ action: "pr/review", dir?: "/path/to/repo", aspects?: ["code", "errors"], maxRounds?: 2 }
Runs the ${BT}pr-review-toolkit:review-pr${BT} skill via Claude Code on the committed changes in your worktree vs the base branch.
**No PR needs to exist yet** — this reviews your local diff before you push.
Returns the full review text in the JSON response so you can act on it (fix issues, re-commit, re-review).
Linear only sees a brief ✅/⚠️ status — the full review is between you and the caller.
${BT}aspects${BT} is optional: ${BT}["comments", "tests", "errors", "types", "code", "simplify"]${BT}. Default: all aspects.
${BT}maxRounds${BT} is optional (1-5, default 1). When >1, re-runs review until it passes clean or max is reached.

**Recommended pre-push workflow (single repo):**
${codeBlock("", [
  "1. pr/branch   → create branch",
  "2. exec        → write code",
  "3. pr/commit   → stage + commit",
  "4. pr/review   → get review (repeat 2-4 until clean)",
  "5. pr/create   → push + open PR",
].join("\n"))}

**Multi-repo coordination:** When an issue requires changes across multiple repositories:
${codeBlock("", [
  "1. Plan all repos upfront (session/plan with per-repo steps)",
  "2. For each repo:",
  "   a. Clone if needed (exec: git clone <url> /tmp/<name>)",
  "   b. pr/branch   { dir: \"/tmp/<name>\" }",
  "   c. exec        → write code in that repo",
  "   d. pr/commit   { dir: \"/tmp/<name>\" }",
  "   e. pr/review   { dir: \"/tmp/<name>\" }",
  "   f. pr/create   { dir: \"/tmp/<name>\" }",
  "3. PRs are automatically cross-linked — each PR body references sibling PRs",
  "4. The final pr/create response lists all session PRs",
].join("\n"))}

When you create multiple PRs, the session tracks all of them. Each subsequent ${BT}pr/create${BT} automatically adds cross-references to earlier PRs in its body, and the response includes a ${BT}sessionPRs${BT} array with all PRs opened so far.

**Important:** PR actions default to the configured repo directory (see "Repo directory" above). If none is configured, or if you need to work in a different repo, pass ${BT}dir: "/path/to/repo"${BT} in the action body. For example, clone a repo with ${BT}exec${BT}, then use ${BT}{ action: "pr/branch", dir: "/tmp/cloned-repo" }${BT} to work in it.`);

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

import { buildMessage, type MessageParams } from "../webhook/message-builder.js";

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
2. **Create a branch** — ${BT}pr/branch${BT} to create an isolated branch for this issue
3. **Make changes** — use your ${BT}exec${BT} tool to edit files, run tests, etc.
4. **Commit changes** — ${BT}pr/commit${BT} to stage and commit
5. **Create PR** — ${BT}pr/create${BT} to push and open a pull request

**action: "pr/branch"** — Create a new branch for this issue
{ action: "pr/branch", branch?: "custom-name", base?: "main" }
Auto-generates branch name from issue identifier if not provided (e.g. ${BT}linear/eng-123-fix-bug${BT}).

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

**Important:** If no repo directory is configured (see "Repo directory" above), the PR actions will fail. Ensure the plugin config has ${BT}defaultDir${BT}, ${BT}repoByTeam${BT}, or ${BT}repoByProject${BT} set.`);

  // Tips
  sections.push(`### Tips

- Use @mentions by including plain Linear URLs: https://linear.app/TEAM/profiles/USERNAME
- Reference issues via URLs: https://linear.app/TEAM/issue/IDENTIFIER — they render as mentions
- Do not use web_fetch or web_search for URLs containing "/resources/articles" (skip those links)
- Post thoughts and actions to show progress during long-running tasks
- Update the session plan as you complete steps
- Use elicitation with the "select" signal to present options to the user
- Post a response activity when your work is complete`);

  return [baseMessage, ...sections].join("\n\n---\n\n");
}

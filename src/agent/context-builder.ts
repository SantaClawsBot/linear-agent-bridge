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

  const repoDirNote = params.repoDir || "(none — configure defaultDir)";

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

**action: \"activity/response\"** — Post a final response. ONLY use this when you are completely done and ready to hand back to the user — it ends the session and Linear will no longer show you as working.
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

**action: "query/viewer"** — Get the current app identity
{ action: "query/viewer" }`);

  // Git & PR guidance (agent uses exec + gh CLI directly)
  sections.push(`### Git & Pull Requests

Use ${BT}exec${BT} to run git and ${BT}gh${BT} CLI commands directly. No special API actions needed.

**Example workflow:**
${codeBlock("", [
  "1. git checkout -b linear/ENG-123-fix-bug",
  "2. Edit files (use your editing tools)",
  "3. git add -A && git commit -m 'fix: resolve null check in auth'",
  "4. git push -u origin linear/ENG-123-fix-bug",
  "5. gh pr create --title 'ENG-123: Fix null check' --body 'Closes <issue-url>'",
].join("\n"))}

The repo directory is: ${repoDirNote}`);

  // Progress & Tips
  sections.push(`### Progress Reporting — IMPORTANT

You are visible to users in Linear. They see your activities in real-time. Keep them informed:

1. **Start with a plan.** Before doing anything, call ${BT}session/plan${BT} with the steps you intend to follow.
2. **Post thoughts as you reason.** Use ${BT}activity/thought${BT} to share your analysis, what you're about to do, and why.
3. **Post actions for every significant operation.** Use ${BT}activity/action${BT} when you run commands, make API calls, edit files, query issues, etc.
4. **Update the plan as you go.** Call ${BT}session/plan${BT} to mark steps inProgress/completed.
5. **Post ${BT}activity/response${BT} ONLY when fully done.** This ends the session.

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
- Post a response activity ONLY when your work is complete — it ends the session

### Context Budget — CRITICAL

You have a limited context window. Large sessions crash with context overflow. Follow these rules:

1. **Prefer ${BT}exec${BT} with ${BT}head -n 50${BT} or ${BT}tail -n 50${BT}** over reading entire files.
2. **Use ${BT}grep${BT}, ${BT}rg${BT}, or ${BT}sed -n '10,30p'${BT}** to read specific sections, not whole files.
3. **Pipe commands through ${BT}head -n 30${BT}** to cap output (e.g. ${BT}npm test 2>&1 | tail -20${BT}).
4. **Never ${BT}cat${BT} a file larger than 50 lines** — use ${BT}wc -l${BT} first to check, then read targeted ranges.
5. **Summarize before moving on** — if a tool result is large, don't carry it forward in your reasoning.
6. **Prefer editing over reading** — make targeted edits with line-based replacements instead of reading→editing→writing.
7. **Finish in as few turns as possible** — aim for ≤30 tool calls total.`);

  return [baseMessage, ...sections].join("\n\n---\n\n");
}

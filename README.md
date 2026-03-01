# linear-agent-bridge

An [OpenClaw](https://github.com/nicepkg/openclaw) plugin that turns Linear's Agent Sessions into fully autonomous AI agent runs. When someone @mentions or delegates an issue to your agent in Linear, this plugin receives the webhook, spins up an OpenClaw agent, and gives it a rich set of tools to manage issues, communicate progress, delegate work, and close tasks — all without leaving Linear.

## Table of Contents

- [How It Works](#how-it-works)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Linear App Setup](#linear-app-setup)
- [Plugin Configuration](#plugin-configuration)
- [Webhook Setup](#webhook-setup)
- [Use Cases](#use-cases)
- [Agent API Reference](#agent-api-reference)
  - [Issue Management](#issue-management)
  - [Communication (Activities)](#communication-activities)
  - [Session Management](#session-management)
  - [Delegation](#delegation)
  - [Queries](#queries)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## How It Works

```
                  ┌──────────┐
                  │  Linear  │
                  │ Workspace│
                  └────┬─────┘
                       │  Webhook (AgentSession / Comment)
                       ▼
              ┌────────────────┐
              │  This Plugin   │
              │                │
              │ 1. Verify HMAC │
              │ 2. Resolve     │
              │    session ID  │
              │ 3. Build       │
              │    enriched    │
              │    prompt      │
              │ 4. Issue       │
              │    per-session │
              │    API token   │
              └───────┬────────┘
                      │  callGateway({ method: "agent", ... })
                      ▼
              ┌────────────────┐
              │ OpenClaw Agent │
              │                │
              │  Reads issue,  │◄──── POST /plugins/linear/api
              │  writes code,  │      (bearer token auth)
              │  posts updates │────► Linear GraphQL API
              │  to Linear     │
              └────────────────┘
```

1. A user @mentions the agent or delegates an issue in Linear
2. Linear sends a webhook to this plugin
3. The plugin verifies the HMAC signature, resolves the agent session, and builds an enriched prompt containing the issue context and a full API reference
4. An OpenClaw agent is launched with that prompt and a short-lived bearer token
5. During execution, the agent calls back to the plugin's API proxy to post thoughts, update plans, create sub-issues, delegate, query data, and post final responses
6. When the agent finishes, the token is revoked and the response is posted to Linear

## Features

- **Full Linear Agent Protocol** — implements `created`, `prompted`, `stop` signal, agent plans, activities (thought/action/elicitation/response/error), proactive sessions
- **Rich Agent API** — during execution the agent can manage issues, post activities, update session plans, delegate work, query issue/team details, and more
- **Session Deduplication** — prevents duplicate agent runs when Linear sends both AgentSession and Comment webhooks for the same event
- **Close Intent Detection** — recognizes natural-language close commands in English and Russian ("close this task", "закрой задачу") and fast-paths them without a full agent run
- **Per-Session Security** — each agent run gets a unique cryptographic bearer token scoped to its session; revoked on completion
- **Issue Policies** — automatically moves issues to "started" state and delegates to the app user on session creation
- **Multi-Repo Routing** — maps Linear teams and projects to specific repository directories
- **Elicitation with Select** — the agent can present clickable option lists to users via the `select` signal
- **External URL Linking** — attaches external links (e.g. CI dashboard, PR) to the Linear session
- **Auto-Detection of Base URL** — works behind Tailscale or any reverse proxy; captures the public URL from the first webhook `Host` header

## Prerequisites

- **Node.js** >= 18
- A running **OpenClaw gateway** instance
- A **Linear workspace** with admin access (to install an OAuth application)
- A publicly reachable URL for webhooks (Tailscale, ngrok, cloud deploy, etc.)

## Installation

```bash
# From npm (when published)
npm install linear-agent-bridge

# Or clone and build from source
git clone https://github.com/tokezooo/linear-agent-bridge.git
cd linear-agent-bridge
npm install
npm run build
```

The plugin registers itself with OpenClaw via the `openclaw` field in `package.json`:

```json
{
  "openclaw": {
    "extensions": ["./dist/index.js"]
  }
}
```

## Linear App Setup

### 1. Create a Linear Application

1. Go to **Linear Settings** > **API** > **Applications** > [Create new](https://linear.app/settings/api/applications/new)
2. Set a recognizable name (this is how users will see the agent in mentions and filters)
3. Enable **Webhooks**
4. Under webhook events, select **Agent session events**
5. Set the webhook URL to: `https://<your-host>/plugins/linear/linear`

### 2. OAuth Installation

Install the app into your workspace using the OAuth flow with `actor=app`:

```
https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=YOUR_REDIRECT&response_type=code&scope=read,write,issues:create,comments:create,app:assignable,app:mentionable&actor=app
```

Key scopes:
| Scope | Purpose |
|-------|---------|
| `read`, `write` | Core issue/comment access |
| `issues:create` | Create issues and sub-issues |
| `comments:create` | Post comments |
| `app:assignable` | Allow delegation to the agent |
| `app:mentionable` | Allow @mentioning the agent |

### 3. Token Exchange (low human-in-the-loop mode)

After the user authorizes your app, Linear redirects with `?code=...`.
This plugin can accept the code, exchange it, and persist tokens automatically:

- `GET /plugins/linear/oauth/callback?code=...` (browser redirect target)
- `POST /plugins/linear/oauth/exchange` with JSON `{ "code": "..." }`

The token set is stored in `linearTokenStorePath` (default `~/.openclaw/workspace/.pi/linear-oauth.json`) with restrictive file permissions, and refresh is attempted automatically when the access token expires.

### 4. Get the Webhook Signing Secret

In your Linear application settings, copy the **Webhook signing secret**. This is used for HMAC-SHA256 signature verification of incoming webhooks.

## Plugin Configuration

Configure the plugin in your OpenClaw config under the plugin's section. All options are defined in `openclaw.plugin.json`.

### Required

| Option | Type | Description |
|--------|------|-------------|
| `linearWebhookSecret` | `string` | Webhook signing secret for HMAC verification |

Authentication requires **one** of these modes:

- Static token mode: set `linearApiKey`
- OAuth automation mode: set `linearOauthClientId`, `linearOauthClientSecret`, `linearOauthRedirectUri`

### Recommended

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `devAgentId` | `string` | `"dev"` | OpenClaw agent ID to handle Linear issues |
| `defaultDir` | `string` | — | Default repository directory for agent work |

### Issue Policies

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `delegateOnCreate` | `boolean` | `true` | Auto-delegate issues to the app user when a session is created |
| `startOnCreate` | `boolean` | `true` | Move issues to "started" workflow state on session creation |

### Multi-Repo Routing

| Option | Type | Description |
|--------|------|-------------|
| `repoByTeam` | `object` | Map Linear team keys to repository directories. Example: `{ "ENG": "/home/code/backend", "WEB": "/home/code/frontend" }` |
| `repoByProject` | `object` | Map Linear project keys to repository directories. Takes precedence over `repoByTeam` |

### Agent API

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enableAgentApi` | `boolean` | `true` | Enable the API proxy that agents call during execution |
| `apiBaseUrl` | `string` | auto-detected | Override the auto-detected base URL for agent API callbacks |
| `linearTokenStorePath` | `string` | `~/.openclaw/workspace/.pi/linear-oauth.json` | Workspace-local OAuth token store path (written with `0600`) |

### External URLs

| Option | Type | Description |
|--------|------|-------------|
| `externalUrlBase` | `string` | URL template for session links. Supports `{session}` and `{issue}` placeholders. Example: `https://dash.example.com/sessions/{session}` |
| `externalUrlLabel` | `string` | Label for external links (default: `"OpenClaw session"`) |

### Notifications

| Option | Type | Description |
|--------|------|-------------|
| `notifyChannel` | `string` | Channel for delivery notifications (e.g. `"discord"`) |
| `notifyTo` | `string` | Target for notifications (e.g. `"channel:123456"`) |
| `notifyAccountId` | `string` | Account ID for notifications |

### Example Configuration

```json
{
  "linearWebhookSecret": "whsec_...",
  "linearOauthClientId": "...",
  "linearOauthClientSecret": "...",
  "linearOauthRedirectUri": "https://your-host/plugins/linear/oauth/callback",
  "linearTokenStorePath": "/home/ubuntu/.openclaw/workspace/.pi/linear-oauth.json",
  "devAgentId": "dev",
  "defaultDir": "/home/projects/main-repo",
  "repoByTeam": {
    "ENG": "/home/projects/backend",
    "WEB": "/home/projects/frontend"
  },
  "delegateOnCreate": true,
  "startOnCreate": true,
  "enableAgentApi": true,
  "externalUrlBase": "https://dash.example.com/sessions/{session}"
}
```

## Webhook Setup

The plugin registers a POST endpoint at `/plugins/linear/linear`.

### Security

- **HMAC-SHA256 Signature Verification** — every incoming webhook is verified against the `linearWebhookSecret` using the `linear-signature` header
- **Stale Webhook Rejection** — webhooks older than 60 seconds are rejected
- **Immediate 202 Response** — webhook processing happens asynchronously after responding to Linear

### What Gets Processed

| Event Type | Action | Result |
|------------|--------|--------|
| AgentSession `created` | New session | Full agent run with enriched prompt |
| AgentSession `prompted` | Follow-up message | Agent continues with new context |
| Comment (on agent thread) | Follow-up | Resolved to session, triggers `prompted` |
| Signal `stop` | Halt | Agent posts stop confirmation, no run |
| Close intent ("close task") | Fast-path | Issue closed directly, no agent run |

### What Gets Filtered

- `PermissionChange` and `OAuthApp` events (logged only)
- `AppUserNotification` events
- Self-authored comments (prevents feedback loops)
- System echo messages (e.g. "Starting work on...", "Agent run failed:")
- Empty prompts
- Duplicate events within the dedup window (5 seconds)

## Use Cases

### 1. Autonomous Issue Resolution

Delegate an issue to the agent in Linear. The agent receives the full issue context (title, description, labels, comments), writes code, creates sub-issues for subtasks, posts progress updates, and closes the issue when done.

### 2. Interactive Code Review

@mention the agent in a comment asking for review. The agent reads the issue context, examines the linked code, and posts structured feedback as a response activity.

### 3. Multi-Agent Delegation

The agent can delegate sub-tasks to other agents or reassign issues to human team members:

```json
{ "action": "delegate/assign", "issueId": "...", "delegateId": "other-agent-id" }
```

### 4. Issue Triage and Breakdown

Ask the agent to break down a large issue. It creates sub-issues with appropriate priorities and links them to the parent:

```json
{ "action": "issue/create-sub-issue", "title": "Implement auth middleware", "priority": 1 }
```

### 5. Progress Tracking

The agent shows real-time progress via session plans — structured checklists visible in the Linear UI:

```json
{
  "action": "session/plan",
  "plan": [
    { "content": "Analyze issue requirements", "status": "completed" },
    { "content": "Implement solution", "status": "inProgress" },
    { "content": "Write tests", "status": "pending" },
    { "content": "Post summary", "status": "pending" }
  ]
}
```

### 6. User Elicitation

The agent can ask the user to choose between options using the `select` signal:

```json
{
  "action": "activity/elicitation",
  "body": "Which approach should I take?",
  "signal": "select",
  "signalMeta": {
    "options": [
      { "value": "Refactor the existing module" },
      { "value": "Write a new implementation from scratch" }
    ]
  }
}
```

### 7. Proactive Sessions

The agent can create new sessions on other issues or comments without being explicitly delegated:

```json
{ "action": "session/create-on-issue", "issueId": "issue-uuid" }
```

## Agent API Reference

During execution, the agent makes HTTP POST requests to a single endpoint. All requests use bearer token authentication and a JSON body with an `action` field.

**Endpoint:** `POST <apiBaseUrl>`
**Auth:** `Authorization: Bearer <per-session-token>`
**Content-Type:** `application/json`

Every request body **must** include an `action` field.

### Issue Management

#### `issue/create` — Create a New Issue

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamId` | `string` | No (defaults to current) | Team to create issue in |
| `title` | `string` | **Yes** | Issue title |
| `description` | `string` | No | Issue description (Markdown) |
| `priority` | `number` | No | Priority 0-4 (0 = no priority, 1 = urgent, 4 = low) |
| `labelIds` | `string[]` | No | Label IDs to attach |
| `assigneeId` | `string` | No | Assignee user ID |
| `parentId` | `string` | No | Parent issue ID (creates sub-issue) |
| `stateId` | `string` | No | Initial workflow state |

#### `issue/update` — Update Issue Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue to update |
| `title` | `string` | No | New title |
| `description` | `string` | No | New description |
| `stateId` | `string` | No | New workflow state |
| `priority` | `number` | No | New priority |
| `labelIds` | `string[]` | No | Replace labels |
| `assigneeId` | `string` | No | New assignee |
| `delegateId` | `string` | No | New delegate |

#### `issue/close` — Close an Issue

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue to close |

Resolves the team's "completed" workflow state and transitions the issue. Returns `alreadyClosed: true` if the issue is already completed or canceled.

#### `issue/create-sub-issue` — Create a Child Issue

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | **Yes** | Sub-issue title |
| `parentId` | `string` | No (defaults to current) | Parent issue |
| `description` | `string` | No | Description |
| `priority` | `number` | No | Priority 0-4 |
| `labelIds` | `string[]` | No | Labels |
| `assigneeId` | `string` | No | Assignee |

#### `issue/link` — Link Two Issues

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Source issue |
| `relatedIssueId` | `string` | **Yes** | Target issue |
| `type` | `string` | **Yes** | One of: `blocks`, `blocked_by`, `related`, `duplicate` |

### Communication (Activities)

Activities are how the agent communicates with users in the Linear session UI.

#### `activity/thought` — Share Reasoning

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | `string` | **Yes** | Markdown text |
| `ephemeral` | `boolean` | No | If `true`, shown temporarily and replaced by next activity |

#### `activity/action` — Show a Tool Call

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `activityAction` | `string` | **Yes** | Action verb (e.g. "Searching", "Building") |
| `parameter` | `string` | No | Subject of the action |
| `result` | `string` | No | Result (Markdown) |

#### `activity/elicitation` — Ask the User a Question

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | `string` | **Yes** | Question text |
| `signal` | `string` | No | Set to `"select"` to show option buttons |
| `signalMeta` | `object` | No | `{ options: [{ value: "..." }] }` — list of choices |

#### `activity/response` — Post Final Response

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | `string` | **Yes** | Final response (Markdown) |

Marks the session as having a posted response. The handler will skip auto-posting the agent's text output.

#### `activity/error` — Report an Error

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `body` | `string` | **Yes** | Error description |

### Session Management

#### `session/plan` — Update Progress Checklist

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `plan` | `array` | **Yes** | Array of plan steps |

Each step: `{ content: "Step description", status: "pending" | "inProgress" | "completed" | "canceled" }`

**Note:** Replaces the entire plan each time. Always include all steps.

#### `session/create-on-issue` — Create Session on Another Issue

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | **Yes** | Issue to create session on |

#### `session/create-on-comment` — Create Session on a Comment

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `commentId` | `string` | **Yes** | Comment to create session on |

#### `session/external-url` — Set External URL

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | **Yes** | URL to attach |
| `label` | `string` | No | Link label (default: `"Link"`) |

### Delegation

#### `delegate/assign` — Delegate to Agent or User

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue to delegate |
| `delegateId` | `string` | **Yes** | Target agent or user ID |

#### `delegate/reassign` — Change Assignee

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue to reassign |
| `assigneeId` | `string` | **Yes** | New assignee ID |

### Queries

#### `query/issue` — Get Full Issue Details

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue ID |

Returns: labels, state, assignee, delegate, parent, children, relations, recent comments.

#### `query/team` — Get Team Info

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `teamId` | `string` | No (defaults to current) | Team ID |

Returns: workflow states, labels, members.

#### `query/repo-suggestions` — Get AI-Ranked Repository Suggestions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `issueId` | `string` | No (defaults to current) | Issue for context |
| `candidateRepositories` | `array` | **Yes** | `[{ hostname, repositoryFullName }]` |

Returns ranked suggestions with confidence scores.

#### `query/viewer` — Get Current App Identity

No parameters. Returns the authenticated app's user ID.

## Architecture

```
index.ts                          ← Entry point: registers HTTP routes
├── src/
│   ├── types.ts                  ← Shared TypeScript interfaces
│   ├── config.ts                 ← Plugin config normalization
│   ├── util.ts                   ← HTTP/JSON helpers
│   ├── linear-client.ts          ← Single gateway for all Linear GraphQL calls
│   ├── graphql/
│   │   ├── queries.ts            ← GraphQL query strings
│   │   └── mutations.ts          ← GraphQL mutation strings
│   ├── webhook/
│   │   ├── handler.ts            ← Main webhook handler + agent orchestration
│   │   ├── validation.ts         ← HMAC-SHA256 signature verification
│   │   ├── session-resolver.ts   ← Session ID lookup (direct → cache → GraphQL)
│   │   ├── message-builder.ts    ← Agent prompt construction
│   │   ├── response-parser.ts    ← Parse agent output into response text
│   │   ├── issue-policy.ts       ← Auto-start and auto-delegate policies
│   │   ├── close-intent.ts       ← Natural language close detection
│   │   └── skip-filter.ts        ← System echo and self-comment filtering
│   ├── api/
│   │   ├── router.ts             ← API proxy router (bearer token auth)
│   │   ├── base-url.ts           ← Auto-detect public URL from Host header
│   │   ├── issue-ops.ts          ← Issue CRUD operations
│   │   ├── activity-ops.ts       ← Agent activity posting
│   │   ├── session-ops.ts        ← Session management (plans, proactive creation)
│   │   ├── delegation-ops.ts     ← Issue delegation and reassignment
│   │   └── query-ops.ts          ← Read-only queries (issue, team, viewer)
│   └── agent/
│       ├── session-token.ts      ← Per-run bearer token lifecycle
│       ├── context-builder.ts    ← Enriched prompt with API documentation
│       ├── response-tracker.ts   ← Tracks whether agent already posted a response
│       └── plan-manager.ts       ← In-memory plan state per session
```

### Key Design Patterns

| Pattern | Description |
|---------|-------------|
| **Single Linear Gateway** | All GraphQL communication goes through `callLinear()` which handles auth, errors, and logging |
| **Per-Session Tokens** | Each agent run gets a unique `crypto.randomBytes(32)` bearer token, revoked on completion |
| **Response Deduplication** | If the agent posts a response via the API, the handler skips auto-posting the text output |
| **Cascading Session Resolution** | Direct field → in-memory cache → GraphQL query with retry (120ms/350ms/800ms backoff) |
| **Side-Effect Registration** | API handlers register themselves via `registerApiHandler()` and are imported in `index.ts` |
| **Dedup Window** | Prevents double agent runs when Linear sends both AgentSession + Comment webhooks (5s window) |

## Development

### Build

```bash
npm run build    # Runs tsc, outputs to dist/
```

### Project Structure

- **TypeScript** with `strict: true`, targeting ES2022
- **ESM** (`"type": "module"` in package.json)
- **Node16 module resolution**
- Zero runtime dependencies (only `@types/node` and `typescript` as dev deps)

### Adding a New API Operation

1. Create a file in `src/api/` (e.g. `my-ops.ts`)
2. Import and use `registerApiHandler`:

```typescript
import { registerApiHandler } from "./router.js";
import { sendJson } from "../util.js";

registerApiHandler("/my/action", async ({ api, cfg, context, body, res }) => {
  // context.sessionId, context.issueId, context.teamId are available
  // body contains the parsed JSON request
  sendJson(res, 200, { ok: true });
});
```

3. Add a side-effect import in `index.ts`:

```typescript
import "./src/api/my-ops.js";
```

The handler is now available as `{ "action": "my/action" }` through the API proxy.

## Troubleshooting

### Webhook not reaching the plugin

- Verify the URL in Linear application settings matches `https://<host>/plugins/linear/linear`
- Ensure your host is publicly reachable (check with `curl`)
- Check that "Agent session events" is enabled in the Linear app webhook settings

### 401 Unauthorized on webhook

- Verify `linearWebhookSecret` matches the signing secret from Linear app settings
- Check that the webhook is not stale (>60 seconds old) — clock sync issues can cause this

### Agent doesn't respond in Linear

- Check that `linearApiKey` is a valid OAuth token with the required scopes
- Verify the agent ID in `devAgentId` matches a configured OpenClaw agent
- Check OpenClaw gateway logs for errors

### Agent API calls fail

- If `apiBaseUrl` is not set, the URL is auto-detected from the first webhook's `Host` header. Ensure your reverse proxy forwards the correct `Host`
- For Tailscale setups, the `Host` header with `.ts.net` domain is used automatically
- Set `apiBaseUrl` explicitly to bypass auto-detection

### Self-comment loop

- The plugin automatically filters out comments authored by the app itself using the `viewer` query
- If you see loops, verify that the `linearApiKey` belongs to the same OAuth application that sends the webhooks

## License

[MIT](LICENSE) &copy; [tokezooo](https://github.com/tokezooo)

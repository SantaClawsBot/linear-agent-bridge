# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an OpenClaw plugin that bridges Linear's Agent Session webhooks to OpenClaw agent runs. The agent is a full participant in Linear: it can manage issues, communicate with humans and other agents, delegate work, show progress plans, and use all Linear Agent API capabilities.

## Build

```bash
npm run build    # runs tsc
```

No test suite. TypeScript sources in `index.ts` + `src/` compile to `dist/`.

## Architecture

### Entry point (`index.ts`)

Registers two HTTP routes via `api.registerHttpRoute`:
- `POST /plugins/linear/linear` — webhook receiver for Linear events
- `POST /plugins/linear/api` — API proxy for agent-callable operations (bearer token auth)

### Module structure

```
src/
  types.ts              — shared interfaces (PluginConfig, SessionContext, etc.)
  config.ts             — normalizeCfg() for plugin config
  util.ts               — readString/readObject/readArray/readBody/sendJson/etc.
  linear-client.ts      — callLinear() (all Linear GraphQL communication)
  graphql/
    queries.ts          — all GraphQL query strings
    mutations.ts        — all GraphQL mutation strings
  oauth/
    route.ts            — OAuth code exchange endpoint (GET + POST)
    refresh.ts          — automatic token refresh using stored refresh token
    token-store.ts      — persistent token storage with restrictive file permissions
  webhook/
    handler.ts          — createLinearWebhook, handleWebhook, handleAgentEvent, postActivity
    validation.ts       — HMAC-SHA256 signature verification
    session-resolver.ts — resolveOwnedSessionId (read session id from the AgentSessionEvent payload + ownership check; no API calls)
    session-serializer.ts — runSerialized: one run per Linear session at a time; drops duplicates, queues genuine follow-ups
    message-builder.ts  — buildMessage, resolveAction, resolvePrompt, resolveGuidance, etc.
    response-parser.ts  — buildAgentResponse from agent payloads
    issue-policy.ts     — applyIssuePolicy, resolveStartedState, resolveCompletedState, updateIssue
    close-intent.ts     — isCloseIntentPrompt, closeIssueFromPrompt
    skip-filter.ts      — shouldSkipPromptedRun, isSelfAuthoredComment
    concurrency.ts       — enqueueAgentRun / runAndDrain (bounds simultaneous agent runs)
    active-runs.ts      — per-issue active-run registry; cancel + reap canceled records
    issue-events.ts     — resolveDelegateUnassignment (detects the agent being un-delegated via Issue update)
    pending-repo.ts     — caches a low-confidence repo suggestion awaiting user confirmation
    repo-resolver.ts    — auto-resolve repos from GitHub org via Linear suggestions
  api/
    router.ts           — API endpoint router with bearer token auth
    base-url.ts         — auto-detects public URL from webhook Host header
    issue-ops.ts        — issue create/update/close/sub-issue/link
    activity-ops.ts     — post thought/action/elicitation/response/error
    session-ops.ts      — session plan, create-on-issue/comment, external URL
    delegation-ops.ts   — delegate/reassign issues to agents or humans
    query-ops.ts        — query issue detail, team info, repo suggestions, viewer
  agent/
    session-token.ts    — per-run bearer token create/validate/revoke
    context-builder.ts  — buildEnrichedMessage (agent prompt with API docs)
    response-tracker.ts — tracks whether agent already posted a response
    plan-manager.ts     — in-memory plan state per session
```

### Webhook flow

1. Linear sends POST to `/plugins/linear/linear`
2. Validates HMAC signature (rejects when no secret is configured — fail closed), rejects stale webhooks (>60s), responds 202
3. Filters out PermissionChange, OAuthApp, notifications, self-authored comments; handles `Issue` delegate-removal (cancels the issue's active runs)
4. Resolves agent session ID directly from the payload and confirms we own it (ownership via payload appUser)
5. Serializes per session (one run at a time) via the concurrency limiter + `runSerialized`
6. Determines action (`created`/`prompted`), handles stop signal and close-intent fast-paths, and gates low-confidence repo confirmation
7. Generates a per-session API token, builds enriched prompt with API documentation
8. Calls agent via `callGateway` (multi-phase plan→exec for `created`), revokes token and posts response on completion

### Agent API proxy

During execution, the agent can call `POST /plugins/linear/api/*` with the bearer token to:
- Manage issues (create, update, close, link, sub-issues)
- Post activities (thought, action, elicitation with select signal, response, error)
- Update session plans (multi-step progress checklists)
- Delegate issues to other agents or humans
- Query issue details, team info, repository suggestions
- Create proactive sessions on issues/comments
- Use `exec` + `git`/`gh` CLI directly for code changes and pull requests (no dedicated API actions needed)

Base URL is auto-detected from the `Host` header of incoming webhooks (Tailscale), overridable via `apiBaseUrl` config.

### Key patterns

- **callLinear()** in `linear-client.ts` — single gateway for all Linear GraphQL calls (auth, error handling, logging)
- **Session token scoping** — each agent run gets a unique bearer token tied to its session context; revoked on completion
- **Response deduplication** — if agent posts a response via API, the handler skips auto-posting the text response
- **Session ID resolution** — read directly from the AgentSessionEvent payload (`created` and `prompted` both embed it); ownership confirmed from the payload's appUser. The plugin subscribes only to "Agent session events" (+ optionally "Issues" for cancel-on-unassign), not Comments, so no GraphQL comment→session fallback is needed
- **Per-session serialization** — `runSerialized` ensures one run per Linear session at a time (queues genuine follow-ups, drops same-action/Comment-on-creation duplicates within a 5s window)
- **API endpoint registration** — `registerApiHandler()` in router.ts; ops files register via side-effect imports

### Configuration

Defined in `openclaw.plugin.json`. Key options:
- `devAgentId`, `linearApiKey`, `linearWebhookSecret` — core setup
- `defaultDir`/`repoByTeam`/`repoByProject` — repo mapping
- `delegateOnCreate`/`startOnCreate` — issue policies
- `enableAgentApi` (default: true) — enable/disable API proxy
- `apiBaseUrl` — override auto-detected base URL

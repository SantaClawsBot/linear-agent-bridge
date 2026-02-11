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
  webhook/
    handler.ts          — createLinearWebhook, handleWebhook, handleAgentEvent, postActivity
    validation.ts       — HMAC-SHA256 signature verification
    session-resolver.ts — session ID cascading lookup + in-memory caches
    message-builder.ts  — buildMessage, resolveAction, resolvePrompt, etc.
    response-parser.ts  — buildAgentResponse from agent payloads
    issue-policy.ts     — applyIssuePolicy, resolveStartedState, resolveCompletedState, updateIssue
    close-intent.ts     — isCloseIntentPrompt, closeIssueFromPrompt
    skip-filter.ts      — shouldSkipPromptedRun, isSelfAuthoredComment
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
2. Validates HMAC signature, rejects stale webhooks (>60s), responds 202
3. Filters out PermissionChange, OAuthApp, notifications, self-authored comments
4. Resolves agent session ID (direct → cache → GraphQL with retry)
5. Determines action (`created`/`prompted`), handles stop signal and close intent fast-paths
6. Generates a per-session API token, builds enriched prompt with API documentation
7. Calls agent via `callGateway`, revokes token and posts response on completion

### Agent API proxy

During execution, the agent can call `POST /plugins/linear/api/*` with the bearer token to:
- Manage issues (create, update, close, link, sub-issues)
- Post activities (thought, action, elicitation with select signal, response, error)
- Update session plans (multi-step progress checklists)
- Delegate issues to other agents or humans
- Query issue details, team info, repository suggestions
- Create proactive sessions on issues/comments

Base URL is auto-detected from the `Host` header of incoming webhooks (Tailscale), overridable via `apiBaseUrl` config.

### Key patterns

- **callLinear()** in `linear-client.ts` — single gateway for all Linear GraphQL calls (auth, error handling, logging)
- **Session token scoping** — each agent run gets a unique bearer token tied to its session context; revoked on completion
- **Response deduplication** — if agent posts a response via API, the handler skips auto-posting the text response
- **Session ID resolution** — cascading: direct field → in-memory cache → GraphQL queries with retry (120/350/800ms)
- **API endpoint registration** — `registerApiHandler()` in router.ts; ops files register via side-effect imports

### Configuration

Defined in `openclaw.plugin.json`. Key options:
- `devAgentId`, `linearApiKey`, `linearWebhookSecret` — core setup
- `defaultDir`/`repoByTeam`/`repoByProject` — repo mapping
- `delegateOnCreate`/`startOnCreate` — issue policies
- `enableAgentApi` (default: true) — enable/disable API proxy
- `apiBaseUrl` — override auto-detected base URL

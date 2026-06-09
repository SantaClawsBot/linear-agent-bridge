# Agent‑invocation migration plan

Status as of branch `refactor/idiomatic-agent-invocation`. Grounded against the
**OpenClaw 2026.6.1** source (`npm pack openclaw@2026.6.1`; the VM runs this
version). All type signatures below are copied/derived from the package's
`dist/**/*.d.ts`.

## Why

The bridge dispatches agent runs with `api.runtime.subagent.run()` +
`waitForRun()` + `getSessionMessages()` reverse‑scraped for "the last assistant
message". OpenClaw's docs are explicit that this is the wrong tool:

- **Sub‑agents are "background agent runs spawned from an existing agent run"**
  (`docs/tools/subagents.md`) — fan‑out helpers, not the way a webhook turns an
  inbound message into a reply. `subagent.run` returns only `{ runId }`, has
  **no abort method**, and completion is push‑based (polling
  `getSessionMessages` is "the wrong shape").
- The sanctioned in‑process primitive is **`api.runtime.agent.runEmbeddedAgent`**
  ("the neutral helper for starting a normal OpenClaw agent turn from plugin
  code") — it returns the reply inline and takes an `abortSignal`.
- The idiomatic architecture for "external surface → agent → reply" is a
  **channel plugin** (`api.runtime.channel.inbound.*`), where core owns
  sessions, dedup, delivery, streaming, and cancellation.

Consequences in the current code, all traceable to the wrong primitive:
`extractLastAssistantText` scrape, no abort on cancel, the `plan→exec`
two‑session split + `lightContext:true` to "dodge `blocked_tool_call`" (which is
a runtime diagnostic, not something `lightContext` — a bootstrap‑file token trim
— addresses), and the 8 s "Working…" keepalive loop.

## Already done (committed on this branch)

- `56eeb70` — removed dead `dispatchToAgentRuntime` (internal `runtime.channel`
  plumbing) + `response-parser.ts`.
- `32946e3` — replaced hand‑written `OpenClawPluginApi`/`*SubagentApi` types with
  the real `import type { OpenClawPluginApi, PluginRuntime, PluginLogger } from
  "openclaw/plugin-sdk"`. Added `openclaw` as a devDependency so `tsc` resolves
  them. This immediately caught one real unsoundness (`getSessionMessages`
  returns `{ messages: unknown[] }`, not `{role,content}`), now fixed in
  `extractLastAssistantText`.

> Dependency note: the devDependency is heavy (~361 MB, 294 transitive pkgs;
> gitignored, only `package.json`/lock committed). If undesirable, switch to a
> `peerDependency` and ensure dev/CI provisions `openclaw` before `npm run build`.

---

## Tier 1 — `subagent.run` → `runEmbeddedAgent` (interim)

Lower risk than Tier 2 but still a **core behavior change → smoke‑test on the VM
before merge.** With real types imported, the API‑shape is now compiler‑checked.

### Verified contract

```ts
// api.runtime.agent.runEmbeddedAgent(params): Promise<EmbeddedAgentRunResult>
// Required:  sessionId, sessionFile, workspaceDir, prompt, timeoutMs, runId
// Useful optionals: agentId, cwd, agentDir, config, bootstrapContextMode,
//                   abortSignal, lane, extraSystemPrompt, provider, model,
//                   thinkLevel, and streaming callbacks (below).
// Result:    result.payloads?[].text  (+ mediaUrl(s), isError, isReasoning)
//            result.meta.finalAssistantVisibleText
//            result.meta.aborted
//            result.didSendViaMessagingTool  // agent already delivered via a tool
```

Helpers (all on `api.runtime.agent`, verified positional/object shapes):

```ts
resolveAgentDir(cfg, agentId, env?) => string
resolveAgentWorkspaceDir(cfg, agentId, env?) => string
resolveAgentTimeoutMs({ cfg, overrideSeconds?, overrideMs?, minMs? }) => number
ensureAgentWorkspace({ dir? }) => Promise<{ dir: string }>          // async
agent.session.resolveSessionFilePath(sessionId, entry?, { agentId }) => string
agent.defaults.{ model, provider }
```

### Minimal call sequence (replaces each `subagent.run` + `waitForRun` + scrape)

```ts
const subagent_unused = 0; // delete the subagent path
const cfg = api.config;                       // real OpenClawConfig (required)
const agentId = cfg.devAgentId ?? "dev";      // bridge already resolves this
const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId);
await api.runtime.agent.ensureAgentWorkspace({ dir: workspaceDir });
const sessionId = `linear:${session}`;        // stable per Linear agent session
const sessionFile = api.runtime.agent.session.resolveSessionFilePath(
  sessionId, undefined, { agentId },
);
const result = await api.runtime.agent.runEmbeddedAgent({
  sessionId,
  runId: crypto.randomUUID(),
  sessionFile,
  workspaceDir,
  cwd: repo,                                   // run code work in the repo dir
  agentDir: api.runtime.agent.resolveAgentDir(cfg, agentId),
  config: cfg,
  agentId,
  prompt: message,                             // the enriched message
  timeoutMs: api.runtime.agent.resolveAgentTimeoutMs({ cfg }),
  abortSignal,                                 // see cancellation below
  bootstrapContextMode: "full",
  // streaming → Linear activities (see mapping):
  onReasoningStream: (p) => postThought(p.text),
  onToolResult:      (p) => postAction(p),
  onAgentEvent:      (e) => maybePostPlan(e),
});
const text = result.meta.finalAssistantVisibleText
  ?? result.payloads?.map((p) => p.text ?? "").join("").trim()
  || undefined;
```

### Streaming → Linear activity mapping (replaces the 8 s keepalive loop)

| `runEmbeddedAgent` hook | Linear activity |
|---|---|
| `onReasoningStream` / `onReasoningEnd` | `activity/thought` (ephemeral) |
| `onToolResult`, `onAgentEvent` (tool streams) | `activity/action` |
| `onAgentEvent` plan stream / plan updates | `session/plan` |
| final `payloads[].text` / `meta.finalAssistantVisibleText` | `activity/response` |
| `payload.isError` | `activity/error` |

Because the run streams progress, drop the 8 s `setInterval` "Working…" keepalive
— real activity now flows continuously.

### Cancellation (fixes the "no abort on cancel" gap)

- Create an `AbortController` per run; store it on the `ActiveRunRecord`
  (`active-runs.ts`). Pass `controller.signal` as `abortSignal`.
- In `cancelActiveRunsForIssue` / the delegate‑unassignment path, call
  `controller.abort()`. `runEmbeddedAgent` returns with `meta.aborted === true`.
- (If any `subagent.run` path is retained, its admin‑scope kill is
  `killSubagentRunAdmin({ cfg, sessionKey })` — but `runEmbeddedAgent`'s
  `abortSignal` is the clean path.)

### Code to delete / change (all in `src/webhook/handler.ts`)

- The three `api.runtime.subagent.run(...)` + `waitForRun(...)` blocks (plan,
  exec, single‑phase) → one `runEmbeddedAgent` call.
- `PHASE_PLAN_PROMPT_SUFFIX`, `buildExecPhaseMessage`, `PHASE_TIMEOUT_MS`,
  `shouldUseMultiPhase`, the whole plan→exec split, and `lightContext:true`.
  The runtime handles long runs natively (48 h default); if true staged work is
  ever needed, use `api.runtime.tasks.managedFlows` (TaskFlow), not two manual
  sessionKeys.
- `extractLastAssistantText` (output now comes back inline).
- The keepalive `setInterval`.
- `addActiveRunSessionKey` plan/exec bookkeeping (single session now).

### VM smoke‑test checklist (Tier 1)

1. Build + deploy to the gateway VM.
2. Delegate/@mention a test issue → agent runs, posts thought/action/response,
   issue moves to the review state.
3. Confirm the agent runs **in the resolved repo** (`cwd`) and can reach the
   Linear API proxy (token still threaded via the enriched prompt).
4. Un‑delegate mid‑run → `abort()` fires, run stops, "canceled" response posted,
   no stray final response.
5. Follow‑up prompt → single‑session continuation works (no plan/exec).
6. Low‑confidence repo confirmation → resume flow still works.

### Open questions to confirm on the VM

- Does `runEmbeddedAgent` with `cwd: repo` resolve tool policy/sandbox correctly,
  or is a real `sessionKey` (via `api.runtime.channel.routing.resolveAgentRoute`)
  also needed alongside `sessionId`?
- `didSendViaMessagingTool` / the message tool: does the agent try to deliver via
  its own messaging tool? If so, set `disableMessageTool: true` (the bridge owns
  delivery to Linear) to avoid double‑sends.
- Confirm `api.config` is the full `OpenClawConfig` the `resolve*` helpers expect
  (vs `api.runtime.config.current()`).

---

## Tier 2 — first‑class **channel plugin** (recommended destination)

Eliminates most of the hand‑rolled machinery. Core owns the inbound→agent→reply
pipeline; the bridge keeps only Linear‑specific translation.

### Shape

- Manifest: `openclaw.plugin.json` → `{ kind: "channel", channels: [{ id:
  "linear", ... }] }`; entry via `defineChannelPluginEntry` /
  `createChatChannelPlugin` (`openclaw/plugin-sdk/channel-core`).
- `registerFull` registers the inbound webhook with `api.registerHttpRoute(
  { auth:"plugin", path:"/plugins/linear/linear", handler })` (verify HMAC
  ourselves), then forwards the event into the channel inbound runner.
- Implement a `ChannelTurnAdapter`:
  - `ingest(raw)` → `NormalizedTurnInput` (translate the AgentSessionEvent;
    ownership/appUser filter lives here).
  - `resolveTurn(...)` → `{ agentId, routeSessionKey, delivery }` where
    `delivery` is a `ChannelEventDeliveryAdapter` whose `deliver(payload:
    ReplyPayload, info)` posts back to Linear.
- **Core** runs the agent (`getReplyFromConfig`) and calls `delivery.deliver(...)`
  per `ReplyPayload` block. No `subagent.run`, no `waitForRun`, no scrape.

### What core takes over (delete from the bridge)

- Session keying/recording → core derives `agent:<agentId>:linear:<conversation>`.
- Inbound dedup + bot‑loop protection → most of `session-serializer.ts`,
  `active-runs.ts` inflight/dedup, and the manual `concurrency.ts`.
- Cancellation → core `abortSignal` / fast‑abort.
- Output capture/delivery → structured `ReplyPayload` blocks.

### What the bridge keeps

- HMAC verification, the Linear GraphQL client (`linear-client.ts`), issue
  policies / repo resolution, and the **`ReplyPayload` → Linear activity
  mapping** in the delivery adapter (the one genuinely Linear‑specific piece,
  since Linear's thought/action/elicitation/response model is richer than the
  portable reply model — use `ReplyPayload.presentation` + `isReasoning/
  isStatusNotice/isError` flags + the `GetReplyOptions` streaming hooks).

### Migration strategy

1. Build the channel plugin **alongside** the existing webhook path (new
   `src/channel/`), behind a config flag, so the working bridge is untouched.
2. Smoke‑test on the VM: parity on create/prompted/cancel/close, activity
   fidelity, dedup.
3. Cut over; delete the superseded webhook/dispatch/session/serializer code.

### To finalize before coding Tier 2

Pull the verbatim channel `.d.ts` (the grounding run captured these; re‑extract
from `dist/plugin-sdk/channel-inbound*.d.ts` / `channel-outbound*.d.ts`):
`ChannelTurnAdapter`, `NormalizedTurnInput`, `AssembledChannelTurn`,
`ChannelEventDeliveryAdapter`, `ChannelDeliveryInfo`, `ReplyPayload`,
`MessagePresentation`, and the `defineChannelPluginEntry` signature + the exact
manifest schema (`docs/plugins/manifest.md`, a bundled webhook‑style channel like
`google-meet`/`msteams` as the precedent).

---

## Recommendation

Tier 2 is the real destination; Tier 1 is a reasonable interim if inline‑result +
abort are wanted sooner. Both need a VM smoke‑test — neither can be validated in a
non‑gateway environment. The foundation (real types + dead‑code) is already
landed and de‑risks both by making the OpenClaw API surface compiler‑checked.

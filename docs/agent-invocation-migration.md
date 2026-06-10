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

## Already done (landed on `master`)

- `56eeb70` — removed dead `dispatchToAgentRuntime` (internal `runtime.channel`
  plumbing) + `response-parser.ts`.
- `32946e3` — replaced hand‑written `OpenClawPluginApi`/`*SubagentApi` types with
  the real `import type { OpenClawPluginApi, PluginRuntime, PluginLogger } from
  "openclaw/plugin-sdk"`. Added `openclaw` as a devDependency so `tsc` resolves
  them. This immediately caught one real unsoundness (`getSessionMessages`
  returns `{ messages: unknown[] }`, not `{role,content}`), now fixed.
- **`a8c4f51` — Tier 1 implemented**: dispatch via
  `api.runtime.agent.runEmbeddedAgent` (new `src/agent/embedded-run.ts`), real
  `AbortController` cancellation, streaming → Linear activities + gated keepalive
  backstop, `disableMessageTool:true`. Plan/exec split, `lightContext`, the scrape,
  and the unconditional keepalive are gone. **Needs a VM smoke‑test** (see the
  Tier 1 checklist below) — runtime behavior can't be validated off‑gateway.

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

Because the run streams progress, the unconditional 8 s "Working…" keepalive is
replaced. **As implemented (`a8c4f51`)** a *gated* backstop is kept: it posts an
ephemeral "Working…" only when nothing has streamed in the last ~8 s — covering a
long *silent* tool call (e.g. a build) that would otherwise leave Linear with no
activity and risk a "stopped responding" mark. Only `onReasoningStream` (→ thought)
and `onToolResult` (→ action) are wired today; plan‑stream → `session/plan` is not
yet (the agent can still post plans via the API proxy).

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

### Verified Tier 2 contracts (OpenClaw 2026.6.1) and the open blocker

Grounded from the installed `dist/**/*.d.ts`. Import paths (verified against the
package `exports` map):

```ts
import { runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelInboundEventRunnerParams } from "openclaw/plugin-sdk/channel-inbound";
import { defineChannelPluginEntry, createChatChannelPlugin, createChannelPluginBase }
  from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
```

Key shapes (the raw `ChannelTurnAdapter`/`AssembledChannelTurn`/`ReplyPayload`
names are NOT exported — type the adapter **structurally** and let
`runChannelInboundEvent` infer; public aliases are `ChannelInboundEventRunnerParams`,
`AssembledInboundReply`, `PreparedInboundReply`, `InboundReplyDispatchResult`):

```ts
ChannelTurnAdapter<TRaw> = {
  ingest: (raw) => NormalizedTurnInput | null | Promise<…>;          // null => drop
  classify?; preflight?;                                              // optional
  resolveTurn: (input, eventClass, preflight) => ChannelTurnResolved; // required
  onFinalize?;
}
NormalizedTurnInput = { id; rawText; textForAgent?; textForCommands?; timestamp?; raw? }
// resolveTurn returns EITHER a full AssembledChannelTurn { cfg, channel, agentId,
// routeSessionKey, storePath, ctxPayload, recordInboundSession,
// dispatchReplyWithBufferedBlockDispatcher, delivery } OR a PreparedChannelTurn
// { routeSessionKey, storePath, ctxPayload, recordInboundSession, runDispatch() }.
ChannelEventDeliveryAdapter = {
  deliver: (payload: ReplyPayload, info: { kind }) => Promise<ChannelDeliveryResult | void>;
  preparePayload?; durable?; onDelivered?; onError?;
}
```

Wiring (per `sdk-channel-plugins.md` / `sdk-channel-inbound.md`): in `registerFull(api)`
call `api.registerHttpRoute({ path, auth: "plugin", match: "exact", handler })`,
**verify the Linear HMAC yourself** (auth:"plugin" routes get no gateway scopes),
respond 202, then `await runChannelInboundEvent({ channel: "linear", accountId,
raw: event, adapter })`. Manifest is **two files**: `package.json` →
`{ openclaw: { extensions, setupEntry, channel: { id, label, blurb } } }` and
`openclaw.plugin.json` → `{ kind: "channel", channels: ["linear"], configSchema,
channelConfigs: { linear: { schema, uiHints } } }`. Entry:
`export default defineChannelPluginEntry({ id, name, plugin, registerFull })` where
`plugin = createChatChannelPlugin({ base: createChannelPluginBase({ id, setup }) })`.
Avoid the deprecated `createChannelTurnReplyPipeline` / `recordInboundSessionAndDispatchReply`
/ `runtime.channel.turn.*` names.

**Open blocker (why this isn't scaffolded yet).** `resolveTurn` needs an
`AssembledChannelTurn` whose `ctxPayload` (FinalizedMsgContext),
`recordInboundSession`, and `dispatchReplyWithBufferedBlockDispatcher` are produced
by `buildChannelInboundEventContext(...)` — whose exact param type
(`BuildChannelInboundEventContextParams`) is a large facts/context shape that
wasn't fully expanded, and **no concrete channel‑plugin source ships in the npm
package** to copy (the real references live in separate plugin packages, e.g. MS
Teams / Google Chat, or the `github.com/openclaw/openclaw` monorepo `src/`).
Building this from reconstructed wiring alone, with no reference and no gateway to
run it, would reproduce the `api.subagent`‑style guess‑and‑break failure. So Tier 2
should be built **against a real channel‑plugin reference + iterated on the VM**,
not blind. Concrete unblock: pull a real channel implementation
(`createChatChannelPlugin` + `runChannelInboundEvent`) from the openclaw repo `src/`
or a bundled channel package, ground `BuildChannelInboundEventContextParams`, then
scaffold `src/channel/linear-channel.ts` behind a default‑off config flag.

---

## Recommendation

Tier 2 is the real destination; Tier 1 is a reasonable interim if inline‑result +
abort are wanted sooner. Both need a VM smoke‑test — neither can be validated in a
non‑gateway environment. The foundation (real types + dead‑code) is already
landed and de‑risks both by making the OpenClaw API surface compiler‑checked.

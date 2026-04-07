# NanoHarness DeepAgents Native Migration Plan

Updated: 2026-04-07
Status: In progress

## Objectives

- Replace custom container-side context compaction with DeepAgents/LangChain native summarization middleware.
- Make planning behavior rely on DeepAgents native `write_todos` and `read_todos`.
- Introduce predefined DeepAgents subagents for research, implementation, and review.
- Preserve NanoHarness platform-specific orchestration capabilities such as IPC, message routing, and scheduled tasks.
- Keep the host/container protocol stable while internal execution moves toward native DeepAgents features.

## Design Principles

- Preserve the host-side `ContainerInput` and `ContainerOutput` contract until the native path is stable.
- Prefer additive migration with compatibility shims before deleting old code paths.
- Move one behavioral concern at a time: summarization, planning, subagents, streaming, then cleanup.
- Keep NanoHarness-specific tools at the platform layer; do not let all subagents inherit them blindly.
- Add regression tests whenever an old compatibility path is retired.

## Target Runtime Architecture

### Host responsibilities

- Start and stop containers.
- Manage sessions, retries, and chat routing.
- Maintain mount rules, IPC namespaces, and task snapshots.
- Render streaming output and user-visible events.

### Container responsibilities

- Build a DeepAgents agent with:
  - `LocalShellBackend`
  - native summarization middleware
  - native todo tooling
  - predefined subagents
  - existing NanoHarness IPC tools
- Keep runtime prompt guidance concise and aligned with DeepAgents conventions.
- Persist checkpoints with the current SQLite checkpointer.

### Platform-specific features to keep

- `mcp__nanoclaw__send_message`
- `mcp__nanoclaw__schedule_task`
- task pause/resume/cancel/update helpers
- group registration IPC
- host-side lifecycle and terminal rendering

## Phases

## Phase 1: Native Summarization

Goal: remove container-side custom compact execution and rely on native middleware.

Implementation:

- Add middleware loading at agent construction time.
- Support both `summarizationMiddleware(...)` and `new SummarizationMiddleware(...)` export styles.
- Keep compatibility metadata fields temporarily, but stop using them to control flow.
- Remove host-side fallback rerun logic that depended on `nativeCompact.fallbackToRuleCompact`.
- Simplify prompt-formatting logic to a single non-fallback path.

Success criteria:

- Long-running turns no longer trigger custom compact reruns.
- Host-side prompt formatting has one standard path.
- Existing runtime and integration tests still pass.

## Phase 2: Native Planning

Goal: make `write_todos` and `read_todos` part of the runtime contract instead of an implicit capability.

Implementation:

- Add explicit runtime prompt instructions for:
  - when to create todos
  - keeping one item `in_progress`
  - closing todos immediately after completion
  - skipping todos for trivial one-step work
- Update tests that assert runtime prompt contents.

Success criteria:

- Multi-step work reliably produces visible todo planning.
- Trivial requests are not forced through unnecessary planning loops.

## Phase 3: Predefined Subagents

Goal: introduce native DeepAgents subagents with bounded responsibilities.

Planned subagents:

- `researcher`
  - Focus on reading code, tracing behavior, comparing options, and summarizing findings.
  - Avoid broad code changes unless explicitly escalated by the parent agent.
- `coder`
  - Focus on implementation, refactoring, and targeted verification.
  - Prefer concrete edits over exploratory analysis.
- `reviewer`
  - Focus on behavioral regression review, missing tests, and risk identification.
  - Avoid broad implementation work unless the parent explicitly asks.

Tool strategy:

- Built-in filesystem and shell tools come from the configured DeepAgents backend.
- Custom MCP tools may be selectively exposed.
- NanoHarness scheduling and orchestration tools should remain with the main agent unless there is a clear need.
- Predefined subagents should not inherit the main agent's `skills` by default; add role-specific skills only when explicitly configured.

Success criteria:

- Main agent can delegate to at least three predefined subagents.
- Subagent responsibilities are reflected in prompts and tool access.
- No recursion explosion or accidental delegation loops.

## Phase 4: Native Streaming

Goal: replace ad hoc container-side streaming generation with `agent.stream()` while keeping host rendering stable.

Implementation:

- Move query execution from `invoke()` to `stream()` internally.
- Follow the official DeepAgents streaming contract from `deepagents-handbook/steaming.md`:
  - use `streamMode: ['updates', 'messages', 'custom']`
  - enable `subgraphs: true`
  - treat stream items as `[namespace, mode, data]` tuples when multiple modes are requested
- Map DeepAgents/LangGraph stream events into the current NanoHarness stream protocol first.
- Use `updates` chunks for node-level decisions and `task` lifecycle hints.
- Use `messages` chunks for token streaming, `tool_call_chunks`, and `ToolMessage` results.
- Use `custom` chunks for long-running tool progress emitted via `config.writer`.
- Only remove the compatibility bridge after parser and renderer stability is proven.

Success criteria:

- Tool and content events originate from native stream events.
- Tool lifecycle and node decisions are derived from official stream payloads instead of generic text-only fallback.
- Final answer delivery remains stable.
- Existing stream parser and terminal renderer do not regress.

## Phase 5: Compatibility Cleanup

Goal: delete dead paths after native execution is stable.

Implementation:

- Remove old host-side compact metadata assumptions.
- Remove prompt-formatting helpers that only existed for fallback compaction.
- When `memory: [...]` is validated in production, remove manual `CLAUDE.md` prompt injection in favor of DeepAgents native memory loading.
- Prefer `AGENTS.md` naming for new memory files while keeping `CLAUDE.md` as a compatibility fallback during migration.
- Trim outdated tests and rename them to reflect the new behavior.

Success criteria:

- Fewer duplicate code paths.
- Fewer compatibility-only branches in host and container entry points.

## Phase 6: Optional Enhancements

- Persistent memory using `CompositeBackend` or `StoreBackend`.
- Human approval gates for risky tool actions.
- More explicit subagent model overrides by role.
- MCP exposure policies per subagent.

## Phase 7: Native Human-in-the-Loop

Goal: let NanoHarness pause and resume DeepAgents runs natively when the agent needs approval or direct user input.

Implementation:

- Detect official LangGraph interrupt results via `result.__interrupt__`.
- Persist pending interrupt state inside `.nanoclaw/runtime-context` so the container can survive wait/resume boundaries cleanly.
- Resume the same DeepAgents thread with `new Command({ resume: ... })` semantics instead of treating the next user message as a fresh prompt.
- Add a NanoHarness-native `mcp__nanoclaw__ask_user` tool backed by `interrupt()` so the agent can proactively request:
  - yes/no approval
  - extra instructions
  - OTP or CAPTCHA values
  - structured JSON payloads
- Keep the host/container protocol stable by surfacing interrupt requests as normal assistant results, then consuming the next IPC user message as resume input.
- Support optional DeepAgents `interruptOn` configuration from environment so risky tool calls can require review without extra custom orchestration.

Success criteria:

- The agent can pause mid-run, wait for a user reply, and continue in the same thread without losing state.
- Both tool approval interrupts and arbitrary tool-level `interrupt()` payloads are supported.
- NanoHarness users can inject decisions and information directly into an active run in a Claude Code-like way, without changing the host message protocol.

## Validation Strategy

- `npm run typecheck`
- Focused Vitest suites for runtime, orchestration, formatting, and compaction compatibility
- Targeted smoke runs for container behavior when dependency availability permits

## Current Decision Record

- `LocalShellBackend` remains the correct backend because NanoHarness already runs inside a container boundary.
- Native summarization should be middleware-driven, not implemented as a separate query pass.
- Todo planning should be encouraged by prompt policy rather than custom orchestration.
- Predefined subagents should come before native streaming migration because they are lower risk and improve task structure immediately.
- Predefined subagents should receive shared skills and filtered custom MCP tools, while `mcp__nanoclaw__*` orchestration tools stay with the main agent by default.
- Streaming migration should follow the official DeepAgents documentation payload shapes first, then add compatibility heuristics only where NanoHarness legacy protocol still requires them.
- Runtime prompt guidance should describe DeepAgents native harness capabilities directly and avoid long Claude-specific tool alias tables.
- Human-in-the-loop should be implemented container-side with persisted interrupt state and `Command(resume)` rather than inventing a second NanoHarness-specific pause protocol.

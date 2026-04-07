# NanoHarness DeepAgents Native Migration Progress

Updated: 2026-04-07

## Overall Status

- Phase 1: Completed
- Phase 2: Started
- Phase 3: Started
- Phase 4: Started
- Phase 5: Not started
- Phase 6: Backlog

## Completed

### 2026-04-07

- Replaced container-side custom compact trigger flow with native middleware loading in `container/agent-runner/src/index.ts`.
- Added compatibility-aware middleware loading that supports multiple summarization export styles.
- Removed host-side fallback rerun logic that depended on `nativeCompact.fallbackToRuleCompact`.
- Simplified prompt formatting to a single standard path in:
  - `src/prompt-context.ts`
  - `src/compact/prompt-preparation.ts`
  - `src/router.ts`
- Updated tests to reflect the new standard-formatting behavior.
- Added a regression test proving the host no longer retries a fallback compact run when legacy metadata is present.
- Added runtime prompt guidance for `write_todos` and `read_todos`.
- Added predefined subagents in `container/agent-runner/src/index.ts`:
  - `researcher`
  - `coder`
  - `reviewer`
- Scoped subagent custom tools to non-NanoHarness MCP tools by filtering out `mcp__nanoclaw__*`.
- Tightened subagent defaults so `researcher` and `reviewer` only receive read-oriented custom tools by default, while `coder` can receive the wider non-NanoHarness custom tool set.
- Added an environment flag to disable predefined subagents: `NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS=false`.
- Corrected predefined subagent skill inheritance to match the official DeepAgents subagent docs:
  - predefined subagents now default to isolated `skills: []`
  - main-agent skills are only propagated when `NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS=true`
  - role-specific skill roots can be injected with `NANOCLAW_SUBAGENT_RESEARCHER_SKILLS`, `NANOCLAW_SUBAGENT_CODER_SKILLS`, and `NANOCLAW_SUBAGENT_REVIEWER_SKILLS`
- Added an opt-in native memory path for DeepAgents `memory` loading:
  - `NANOCLAW_USE_NATIVE_MEMORY=true` passes existing `CLAUDE.md` files through `createDeepAgent({ memory: [...] })`
  - manual `<group_memory>`, `<global_memory>`, and `<project_memory>` prompt injection is skipped when the native memory path is enabled
- Added memory file resolution that prefers official `AGENTS.md` files and falls back to legacy `CLAUDE.md` files:
  - native `memory: [...]` path generation and legacy prompt injection now share the same resolution logic
  - this keeps NanoHarness backward compatible while aligning new deployments with DeepAgents' documented memory conventions
- Added explicit DeepAgents main-agent naming based on `assistantName` or NanoHarness role defaults so trace metadata and stream attribution remain stable.
- Cleaned up the runtime prompt compatibility layer so it now describes DeepAgents native harness capabilities directly instead of carrying the older Claude-style tool mapping table.
- Further reduced runtime prompt duplication by removing planning and skills guidance that DeepAgents already injects through its built-in harness prompts; the NanoHarness runtime prompt now focuses on platform boundaries and custom delegation policy.
- Added a runtime test that validates predefined subagent construction and tool filtering.
- Refined runtime prompt guidance so the main agent has explicit delegation rules for `researcher`, `coder`, and `reviewer`.
- Made runtime delegation guidance conditional so prompt instructions stay aligned when predefined subagents are disabled.
- Updated the local OpenAI-compatible provider block in `.env` to point at an OpenRouter endpoint.
- Added an experimental native-stream bridge path in the container runtime, gated behind `NANOCLAW_USE_NATIVE_STREAMING=true`.
- Added helper coverage for stream gating and generic chunk-to-text extraction to support the later `agent.stream()` migration.
- Reworked the native-stream bridge to follow the official DeepAgents streaming model from `deepagents-handbook/steaming.md`:
  - requests `streamMode: ['updates', 'messages', 'custom']`
  - enables `subgraphs: true`
  - normalizes `[namespace, mode, data]` stream tuples
  - maps `updates`/`messages`/`custom` chunks into existing NanoHarness `tool_start`, `tool_progress`, `tool_complete`, `decision`, and optional `content` events
- Added runtime tests for native stream chunk normalization and bridge mapping across:
  - `updates`
  - `messages`
  - `custom`
- Added native DeepAgents human-in-the-loop runtime support based on `deepagents-handbook/humaninloop.md`:
  - detects `result.__interrupt__`
  - persists pending interrupt state under `.nanoclaw/runtime-context/pending-interrupt.json`
  - resumes the same thread with `Command({ resume: ... })` semantics on the next user IPC message
  - supports official tool-review decisions (`approve`, `edit`, `reject`) and generic tool-level interrupt payloads
- Added a new platform tool `mcp__nanoclaw__ask_user` so the agent can proactively pause and ask the user for:
  - yes/no approval
  - extra instructions
  - OTP, CAPTCHA, or verification codes
  - free-text or JSON responses
- Allowed predefined subagents to use `mcp__nanoclaw__ask_user` while still filtering out the rest of the NanoHarness orchestration tools.
- Added optional native interrupt policy wiring through `NANOCLAW_INTERRUPT_ON_JSON` so DeepAgents `interruptOn` can be enabled without changing the host protocol.
- Added runtime tests for:
  - interrupt payload extraction
  - human-in-the-loop prompt formatting
  - resume payload parsing for single-action, multi-action, and generic interrupt flows
- Removed default explicit `SummarizationMiddleware` injection from the container runtime after validating the official handbook: DeepAgents already provides built-in summarization/offloading, and double-registration caused startup failure.
- Added an escape hatch `NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE=true` for compatibility experiments only; default behavior now relies on the native DeepAgents harness path.

## Verified

- `npm run typecheck`
- `npx vitest run src/agent-runner-runtime.test.ts`
- `npx vitest run src/index.integration.test.ts`
- `npx vitest run src/index.integration.test.ts src/agent-runner-runtime.test.ts`
- `npx vitest run src/index.integration.test.ts src/agent-runner-runtime.test.ts src/formatting.test.ts src/compact/__tests__/integration.test.ts`

## Current Code Anchors

- Native summarization middleware load:
  - `container/agent-runner/src/index.ts`
- Predefined subagent definitions:
  - `container/agent-runner/src/index.ts`
- Native streaming bridge:
  - `container/agent-runner/src/index.ts`
- Native human-in-the-loop interrupt/resume flow:
  - `container/agent-runner/src/index.ts`
- Host-side compact cleanup:
  - `src/index.ts`
  - `src/prompt-context.ts`
  - `src/router.ts`
- Runtime todo prompt guidance:
  - `container/agent-runner/src/index.ts`

## Next

- Validate live `agent.stream()` behavior against official DeepAgents streaming docs, especially real `ToolMessage` and `tool_call_chunks` payload shapes.
- Validate live delegation behavior for `task(name="researcher" | "coder" | "reviewer")`.
- Decide whether the reviewer path needs stronger read-only enforcement beyond prompt constraints.
- Run a live end-to-end container test for `mcp__nanoclaw__ask_user` plus resume handling against the real LangGraph `Command` implementation.
- Decide on the default `interruptOn` policy for risky built-in backend tools such as `write_file`, `edit_file`, and `execute`.

## Open Risks

- DeepAgents subagent tool inheritance rules must be handled carefully to avoid overexposing NanoHarness orchestration tools.
- Native stream event payloads are now aligned to the official docs, but some compatibility mapping remains heuristic because NanoHarness still preserves its legacy host-side stream protocol.
- Human-in-the-loop resume currently depends on the runtime being able to load `@langchain/langgraph` helpers at execution time; this should be validated in the real container image, not only against mocked tests.
- If operators force-add LangChain summarization middleware on top of the native harness again, DeepAgents may reject duplicate middleware registration at startup.

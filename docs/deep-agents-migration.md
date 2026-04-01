# Deep Agents Migration

## Skill Inventory

This inventory separates the existing host-side `.claude/skills/*` content into two migration classes for a Deep Agents runtime.

Classification rule used here:

- `Pure instruction skills`: instruction-heavy skills that are primarily markdown workflows, references, diagnostics, or branch-merge guidance.
- `Claude-specific tool skills`: skills that embed Claude Code specific assumptions, invoke the `claude` CLI, depend on `.claude` runtime behavior, or ship executable code/scripts that are tightly coupled to the current Claude-based harness.

### Pure Instruction Skills

- `add-compact`
- `add-discord`
- `add-gmail`
- `add-image-vision`
- `add-parallel`
- `add-pdf-reader`
- `add-reactions`
- `add-slack`
- `add-telegram`
- `add-telegram-swarm`
- `add-voice-transcription`
- `add-whatsapp`
- `convert-to-apple-container`
- `customize`
- `get-qodo-rules`
- `qodo-pr-resolver`
- `update-nanoclaw`
- `update-skills`
- `use-local-whisper`

These can migrate first as Deep Agents skills with small wording changes.

### Claude-Specific Tool Skills

- `add-ollama-tool`
- `claw`
- `debug`
- `setup`
- `x-integration`

These need adapter work or a rewrite because they currently depend on one or more of:

- Claude Code CLI behavior
- `.claude` session or skills runtime conventions
- executable scripts or copied agent/host code
- Claude-specific command names and tool assumptions

## Runtime Skills

The container runtime skills under `container/skills/*` are the ones that matter for the in-container long-running agent:

- `Web2PRD`
- `Repo2Doc`
- `playwright-cli`
- `agent-browser`
- `status`
- `capabilities`
- `slack-formatting`

For the Deep Agents runtime, these are handled as follows:

- Pure instruction runtime skills migrate directly.
- Tool-oriented runtime skills are adapted to Deep Agents built-in tool names.

Tool-name mapping:

- `Bash` -> `execute`
- `Read` -> `read_file`
- `Write` -> `write_file`
- `Edit` -> `edit_file`
- `Glob` -> `glob`
- `Grep` -> `grep`
- `Task` / Agent delegation -> `task`
- Claude todo-writing behavior -> `write_todos`
- `mcp__nanoclaw__*` stays stable via NanoClaw adapter tools

## Architecture Changes

The host/container contract stays in place:

- host queueing, routing, DB state, task scheduling, and IPC remain unchanged
- the container-side Claude SDK runner is replaced by a Deep Agents runner
- NanoClaw MCP-like task/message/group actions are exposed as Deep Agents tools with stable names

This keeps the existing long-flow orchestration intact while removing the Claude Agent SDK dependency from the execution core.

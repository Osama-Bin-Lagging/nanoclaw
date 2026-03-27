# Agent Runner TODO

## Phase 2 - Additional Tools

- [ ] **Skills** - `run_skill` tool: scan `.claude/skills/*/SKILL.md`, read and inject as context
- [ ] **TodoWrite** - file-based todo list at `/workspace/group/.todos.json`
- [ ] **ToolSearch** - return list of all available tool names and descriptions
- [ ] **WebSearch** - search API integration (or agent-browser if available)
- [ ] **Context window overflow handling** - detect when approaching model's context limit, implement LLM-based compaction (summarize old messages via API call, replace with summary). MVP just truncates oldest messages.
- [ ] **Session compaction via LLM** - use an API call to summarize old messages when context is full

## Phase 3 - Agent Teams & Advanced

- [ ] **Agent teams / sub-agents** - `spawn_subagent` tool: run nested agent loop in async context, pipe results back
- [ ] **Task/TaskOutput/TaskStop** - internal sub-task management (needed for agent teams)
- [ ] **NotebookEdit** - parse/modify .ipynb JSON cells
- [ ] **Streaming responses** - switch from `stream: false` to streaming for faster time-to-first-token
- [ ] **Parallel tool execution** - execute multiple tool_calls concurrently with `Promise.all`

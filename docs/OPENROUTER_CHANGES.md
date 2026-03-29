# OpenRouter + Multi-Agent Architecture Changes

> These changes were developed and tested but reverted to the last commit (`4c8535e`).
> This document captures everything needed to re-apply them.

## What was built

### 1. OpenAI-compatible agent runner (ALREADY COMMITTED at `4c8535e`)

Replaced Claude Agent SDK with OpenAI SDK in `container/agent-runner/`. This is in the repo.

Files (already in git):
- `container/agent-runner/src/index.ts` — OpenAI chat completions loop with tool calling
- `container/agent-runner/src/tools.ts` — Core tools (bash, read, write, edit, glob, grep, web_fetch)
- `container/agent-runner/src/ipc-tools.ts` — IPC tools (send_message, schedule_task, etc.)
- `container/agent-runner/src/session.ts` — File-based session management
- `container/agent-runner/package.json` — `openai` dep instead of `claude-agent-sdk`
- `container/Dockerfile` — Updated (no claude-code global install)

**This was tested and works with OpenRouter.** Verified with `stepfun/step-3.5-flash:free`.

### 2. Hybrid Claude + OpenRouter architecture (REVERTED)

Dual container images — Claude SDK for primary agent, OpenAI SDK for specialist agents.

#### New files created (not in git after revert):

**`container/agent-runner-claude/`** — Restored original Claude SDK runner:
- `src/index.ts` — Original `query()` from `@anthropic-ai/claude-agent-sdk`
- `src/ipc-mcp-stdio.ts` — Original MCP server + NEW `invoke_specialist` tool
- `package.json` — Original deps (`claude-agent-sdk`, `@modelcontextprotocol/sdk`, `zod`)
- `tsconfig.json` — Same as agent-runner

**`container/Dockerfile.claude`** — Dockerfile for Claude SDK image:
```dockerfile
# Same as original Dockerfile but uses agent-runner-claude/ and installs
# agent-browser + @anthropic-ai/claude-code globally
COPY agent-runner-claude/package*.json ./
COPY agent-runner-claude/ ./
RUN npm install -g agent-browser @anthropic-ai/claude-code
# Also creates /workspace/ipc/specialists/ directory
```

**`src/specialist-manager.ts`** — Manages specialist agent containers:
- `loadAgentRegistry()` — reads `data/agents.json`
- `startSpecialists()` — registers agents (lazy boot on first use)
- `spawnSpecialist(agent)` — spawns Docker container with OpenAI runner image
- `routeSpecialistRequest(request)` — routes IPC request to specialist container
- `stopSpecialists()` — graceful shutdown of all specialist containers
- Uses `CONTAINER_RUNTIME_BIN` and `hostGatewayArgs()` from `container-runtime.ts`

**`data/agents.json`** — Agent registry:
```json
[
  {
    "name": "dummy",
    "image": "nanoclaw-agent:openai",
    "model": "stepfun/step-3.5-flash:free",
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKey": "env:OPENAI_API_KEY",
    "description": "Test specialist"
  }
]
```

#### Modified files (changes reverted):

**`container/build.sh`** — Build both images:
- `./container/build.sh latest all` builds both
- `./container/build.sh latest claude` builds Claude image only
- `./container/build.sh latest openai` builds OpenAI image only
- Claude image tagged as both `:claude` and `:latest`

**`src/container-runner.ts`** — Two changes:
1. Agent-runner source variant selection (line ~183):
```typescript
const agentRunnerVariant =
  group.containerConfig?.containerImage === 'nanoclaw-agent:openai'
    ? 'agent-runner'
    : 'agent-runner-claude';
```
2. Pass `ANTHROPIC_BASE_URL` and `OPENAI_API_KEY` env vars to containers (line ~248)

**`src/index.ts`** — Import and call specialist manager:
```typescript
import { startSpecialists, stopSpecialists } from './specialist-manager.js';
// In main(): startSpecialists() after restoreRemoteControl()
// In shutdown(): await stopSpecialists() before queue.shutdown()
```

**`src/ipc.ts`** — Specialist request scanning in IPC watcher:
- Import `routeSpecialistRequest` from specialist-manager
- Scan `data/ipc/{group}/specialists/` for `invoke_specialist` request files
- Route to specialist manager
- Clean up processed files

#### `invoke_specialist` MCP tool (added to ipc-mcp-stdio.ts):

```typescript
server.tool('invoke_specialist',
  'Invoke a specialist AI agent for a specific task.',
  { agent: z.string(), prompt: z.string(), timeout: z.number().optional() },
  async (args) => {
    // 1. Generate requestId: `spec-${Date.now()}-${random}`
    // 2. Write request to /workspace/ipc/specialists/{requestId}.json
    // 3. Poll for /workspace/ipc/specialists/{requestId}.result.json (500ms interval)
    // 4. Return result or timeout error after 60s
    // 5. Clean up both files
  }
);
```

#### IPC protocol for specialists:

Request (written by Claude's MCP tool):
```json
{
  "type": "invoke_specialist",
  "agent": "dummy",
  "prompt": "Give me a fun fact",
  "requestId": "spec-1234567890-abc",
  "sourceGroupFolder": "slack_main",
  "timestamp": "2026-03-27T..."
}
```

Result (written by host after specialist responds):
```json
{
  "status": "success",
  "result": "Here's a fun fact...",
  "agent": "dummy",
  "model": "stepfun/step-3.5-flash:free",
  "durationMs": 3200
}
```

## What was tested and verified

### Working:
- OpenAI runner with OpenRouter (`stepfun/step-3.5-flash:free`) — responded to Slack messages ✅
- `CLAUDE_CODE_USE_MODEL` passthrough to containers ✅
- `ANTHROPIC_BASE_URL` passthrough to containers ✅
- Dual Docker image build (`:claude` and `:openai`) ✅
- Specialist manager lazy boot (registers at startup, spawns on first use) ✅
- Specialist container stays alive (long-lived, polls for IPC input) ✅

### Now working (fixed 2026-03-29):
- Claude Agent SDK with OAuth tokens (`sk-ant-oat01-...`) — **WORKS** ✅
  - Fix: read `CLAUDE_CODE_OAUTH_TOKEN` from `.env` via `readEnvFile`, pass to container
  - Fix: strip OneCLI's `ANTHROPIC_API_KEY=placeholder` (conflicts with OAuth)
  - Fix: configure OneCLI with generic secret (`Authorization: Bearer`) instead of `anthropic` type

## Errors encountered and root causes

### Error 1: "Invalid API key · Fix external API key"
- **When**: Claude Agent SDK container with OneCLI proxy + OAuth token
- **Root cause**: OneCLI's `anthropic` secret type injects the token as `x-api-key` header, but OAuth tokens (`oat01`) require a different auth flow. The Anthropic API does not support OAuth tokens for direct API calls.
- **Research finding**: The Claude Agent SDK officially does NOT support OAuth tokens. OAuth tokens only work through Claude Code CLI's internal auth mechanism, not the Agent SDK.
- **Source**: GitHub issue anthropics/claude-code#6536, anthropics/claude-code#37205

### Error 2: "OAuth authentication is currently not supported"
- **When**: Passing `ANTHROPIC_AUTH_TOKEN` directly (bypassing OneCLI proxy)
- **API response**: `{"type":"error","error":{"type":"authentication_error","message":"OAuth authentication is currently not supported."}}`
- **Root cause**: Same as above — Anthropic API rejects OAuth tokens regardless of how they're sent (x-api-key or Authorization Bearer)

### Error 3: `ReferenceError: group is not defined`
- **When**: Added `isSpecialist = group.containerConfig?.containerImage === ...` inside `buildContainerArgs()`
- **Root cause**: `buildContainerArgs()` doesn't receive the `group` parameter, only `mounts`, `containerName`, `agentIdentifier`
- **Fix**: Either pass `group` as a parameter, or use a different signal (e.g., check image name from the args array)

### Error 4: Stale `ipc-mcp-stdio.ts` in container
- **When**: Container compiled old MCP server that still imported `@modelcontextprotocol/sdk` and `zod`
- **Root cause**: Host copies `container/agent-runner/src/` to `data/sessions/{group}/agent-runner-src/` which gets mounted into the container at `/app/src`. The entrypoint recompiles from this mount. The old cached copy still had `ipc-mcp-stdio.ts`.
- **Fix**: Delete `data/sessions/{group}/agent-runner-src/` to force re-copy

### Error 5: `ANTHROPIC_AUTH_TOKEN` conflicting with OneCLI proxy
- **When**: Both `ANTHROPIC_AUTH_TOKEN` and OneCLI proxy env vars set in container
- **Root cause**: Claude SDK picks up `ANTHROPIC_AUTH_TOKEN` and tries direct auth, ignoring the proxy. But OAuth tokens can't be used directly.
- **Fix**: Don't pass `ANTHROPIC_AUTH_TOKEN` to containers — let OneCLI handle auth

## Requirements to re-implement

### For Claude SDK primary agent:
- **OAuth tokens work** (`sk-ant-oat01-...`) — set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`
- OR use an Anthropic API key (`sk-ant-api03-...`) from console.anthropic.com
- OR use OpenRouter for Claude models too (our OpenAI runner works)

### For OpenRouter specialist agents:
- `OPENAI_API_KEY` with OpenRouter key (`sk-or-v1-...`)
- `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1` or `OPENAI_BASE_URL`
- Model ID in `CLAUDE_CODE_USE_MODEL` (e.g., `stepfun/step-3.5-flash:free`)

### Environment variables needed:
```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ONECLI_URL=http://127.0.0.1:10254
CLAUDE_CODE_USE_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=sk-or-v1-...  # OpenRouter key for specialists

# OneCLI vault:
# - Anthropic API key (sk-ant-api03-...) with host-pattern api.anthropic.com
# - OpenRouter key with host-pattern openrouter.ai
```

## Phase 2/3 TODO (from container/agent-runner/TODO.md)

### Phase 2 — Additional Tools for OpenAI runner:
- Skills (`run_skill` tool)
- TodoWrite (file-based)
- ToolSearch (list tools)
- WebSearch
- Context window overflow handling (LLM-based compaction)

### Phase 3 — Agent Teams & Advanced:
- Agent teams / sub-agents (`spawn_subagent` tool)
- Task/TaskOutput/TaskStop
- NotebookEdit
- Streaming responses
- Parallel tool execution

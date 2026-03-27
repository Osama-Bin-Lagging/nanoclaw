/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per query result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { coreTools } from './tools.js';
import { configure, getIpcTools } from './ipc-tools.js';
import {
  generateSessionId,
  loadSession,
  saveSession,
  truncateHistory,
  archiveTranscript,
} from './session.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const MAX_HISTORY_CHARS = 200_000;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ---------------------------------------------------------------------------
// Core I/O helpers
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------

/**
 * Check for _close sentinel and consume it if present.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns message texts found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages joined as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile('bash', [scriptPath], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      if (stderr) {
        log(`Script stderr: ${stderr.slice(0, 500)}`);
      }

      if (error) {
        log(`Script error: ${error.message}`);
        return resolve(null);
      }

      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) {
        log('Script produced no output');
        return resolve(null);
      }

      try {
        const result = JSON.parse(lastLine);
        if (typeof result.wakeAgent !== 'boolean') {
          log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
          return resolve(null);
        }
        resolve(result as ScriptResult);
      } catch {
        log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(containerInput: ContainerInput): string {
  const parts: string[] = [];

  parts.push(`You are ${containerInput.assistantName || 'Andy'}, a personal assistant.`);
  parts.push(`Current date: ${new Date().toISOString()}`);
  parts.push(`Timezone: ${process.env.TZ || 'UTC'}`);
  parts.push('');

  // Load CLAUDE.md files
  const claudeMdPaths = ['/workspace/group/CLAUDE.md'];
  if (!containerInput.isMain) {
    claudeMdPaths.push('/workspace/global/CLAUDE.md');
  }
  // Additional directories
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const mdPath = path.join(extraBase, entry, 'CLAUDE.md');
      claudeMdPaths.push(mdPath);
    }
  }

  for (const mdPath of claudeMdPaths) {
    try {
      if (fs.existsSync(mdPath)) {
        parts.push(fs.readFileSync(mdPath, 'utf-8'));
        parts.push('');
      }
    } catch { /* ignore unreadable files */ }
  }

  parts.push('You have access to tools for file operations, running commands, web fetching, and IPC with the host system. Use them as needed to accomplish tasks.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Agent query loop
// ---------------------------------------------------------------------------

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  // Build OpenAI client
  const client = new OpenAI({
    baseURL: process.env.ANTHROPIC_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || 'dummy',
  });
  const model = process.env.CLAUDE_CODE_USE_MODEL || process.env.OPENAI_MODEL || 'anthropic/claude-sonnet-4';

  // Build tool definitions and executor map
  const allTools = [...coreTools, ...getIpcTools()];
  const toolDefinitions = allTools.map(t => t.definition);
  const toolExecutors = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
  for (const tool of allTools) {
    toolExecutors.set(tool.definition.function.name, tool.execute);
  }

  // Session setup
  const sessionDir = '/workspace/group/.sessions';
  const currentSessionId = sessionId || generateSessionId();

  // Load existing session history or start fresh
  let messages: ChatCompletionMessageParam[] = [];
  if (sessionId) {
    messages = loadSession(sessionId, sessionDir);
    log(`Loaded ${messages.length} messages from session ${sessionId}`);
  }

  // Prepend system prompt (replace existing system message if present)
  const systemPrompt = buildSystemPrompt(containerInput);
  if (messages.length > 0 && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: systemPrompt };
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
  }

  // Add the user message
  messages.push({ role: 'user', content: prompt });

  let closedDuringQuery = false;

  // Agent loop
  while (true) {
    // Check for _close sentinel
    if (shouldClose()) {
      log('Close sentinel detected during query, aborting');
      closedDuringQuery = true;
      break;
    }

    // Drain any queued IPC follow-up messages, add as user messages
    const followUps = drainIpcInput();
    for (const text of followUps) {
      log(`Adding queued IPC follow-up message (${text.length} chars)`);
      messages.push({ role: 'user', content: text });
    }

    // Call the API
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: toolDefinitions,
        temperature: 0.7,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`API error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: currentSessionId,
        error: errorMessage,
      });
      return { newSessionId: currentSessionId, closedDuringQuery: false };
    }

    const choice = response.choices[0];
    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // Handle tool calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      log(`Handling ${assistantMessage.tool_calls.length} tool call(s)`);
      for (const toolCall of assistantMessage.tool_calls) {
        const executor = toolExecutors.get(toolCall.function.name);
        let result: string;
        if (executor) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            result = await executor(args);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          result = `Unknown tool: ${toolCall.function.name}`;
        }
        log(`Tool ${toolCall.function.name} result: ${result.slice(0, 100)}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
      continue; // Back to top of loop for next API call
    }

    // Text response (no tool calls) — we have a final result
    const resultText = typeof assistantMessage.content === 'string'
      ? assistantMessage.content
      : null;

    log(`Got text response (${resultText?.length ?? 0} chars)`);

    // Truncate history if it has grown too large before saving
    const trimmedMessages = truncateHistory(messages, MAX_HISTORY_CHARS);
    if (trimmedMessages.length < messages.length) {
      log(`Truncated history from ${messages.length} to ${trimmedMessages.length} messages`);
    }

    // Save session
    saveSession(currentSessionId, sessionDir, trimmedMessages);

    // Write output
    writeOutput({
      status: 'success',
      result: resultText,
      newSessionId: currentSessionId,
    });

    break; // Result produced, exit the agent loop
  }

  // Archive transcript on close
  if (closedDuringQuery && messages.length > 1) {
    try {
      const conversationsDir = '/workspace/group/conversations';
      archiveTranscript(messages, conversationsDir, containerInput.assistantName);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { newSessionId: currentSessionId, closedDuringQuery };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Configure IPC tools with per-invocation context
  configure(containerInput.chatJid, containerInput.groupFolder, containerInput.isMain);

  // Session setup
  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase: run script before waking agent (scheduled tasks only)
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }

    // Script says wake agent — enrich prompt with script data
    log('Script wakeAgent=true, enriching prompt with data');
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'})...`);

      const queryResult = await runQuery(prompt, sessionId, containerInput);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      // If _close was consumed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();

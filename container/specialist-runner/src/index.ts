/**
 * NanoClaw Specialist Runner
 * Persistent OpenAI-compatible agent that polls for IPC requests.
 *
 * Config via env vars:
 *   SPECIALIST_MODEL     - OpenAI model ID (e.g. "google/gemini-2.5-flash")
 *   SPECIALIST_BASE_URL  - API base URL (e.g. "https://openrouter.ai/api/v1")
 *   OPENAI_API_KEY       - API key for the provider
 *   SPECIALIST_SYSTEM_PROMPT - Optional system prompt
 *   SPECIALIST_IDLE_TIMEOUT  - Idle timeout in ms (default: 600000 = 10min)
 *
 * IPC protocol:
 *   Polls /workspace/ipc/requests/ for {requestId}.json files
 *   Writes {requestId}.result.json with the response
 *   Exits on _shutdown sentinel or idle timeout
 */

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js';
import { executeTool, toolDefinitions } from './tools.js';

const IPC_REQUESTS_DIR = '/workspace/ipc/requests';
const POLL_INTERVAL = 500;
const IDLE_TIMEOUT = parseInt(
  process.env.SPECIALIST_IDLE_TIMEOUT || '600000',
  10,
);
const MAX_TOOL_ROUNDS = 30;

interface SpecialistRequest {
  type: string;
  requestId: string;
  agent: string;
  prompt: string;
  groupFolder: string;
  timestamp: string;
}

interface SpecialistResult {
  status: 'success' | 'error';
  output?: string;
  error?: string;
  durationMs: number;
}

const model = process.env.SPECIALIST_MODEL;
const baseURL = process.env.SPECIALIST_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;
const systemPrompt =
  process.env.SPECIALIST_SYSTEM_PROMPT || 'You are a helpful specialist agent.';

if (!model || !baseURL || !apiKey) {
  console.error(
    'Missing required env vars: SPECIALIST_MODEL, SPECIALIST_BASE_URL, OPENAI_API_KEY',
  );
  process.exit(1);
}

const client = new OpenAI({ apiKey, baseURL });

async function runToolCallingLoop(prompt: string): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model: model!,
      messages,
      tools: toolDefinitions,
    });

    const choice = response.choices[0];
    if (!choice?.message) break;

    messages.push(choice.message);

    const toolCalls = choice.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return choice.message.content || '';
    }

    for (const toolCall of toolCalls as ChatCompletionMessageToolCall[]) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      console.error(
        `[specialist] tool: ${toolCall.function.name}(${toolCall.function.arguments.slice(0, 100)})`,
      );
      const result = await executeTool(toolCall.function.name, args);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return 'Max tool rounds exceeded.';
}

async function processRequest(request: SpecialistRequest): Promise<void> {
  const start = Date.now();
  console.error(`[specialist] Processing request: ${request.requestId}`);

  let result: SpecialistResult;
  try {
    const output = await runToolCallingLoop(request.prompt);
    result = {
      status: 'success',
      output,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    result = {
      status: 'error',
      error: (err as Error).message,
      durationMs: Date.now() - start,
    };
  }

  const resultPath = path.join(
    IPC_REQUESTS_DIR,
    `${request.requestId}.result.json`,
  );
  const tmpPath = resultPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(result));
  fs.renameSync(tmpPath, resultPath);

  console.error(
    `[specialist] Completed ${request.requestId}: ${result.status} (${result.durationMs}ms)`,
  );
}

function scanForRequests(): SpecialistRequest[] {
  if (!fs.existsSync(IPC_REQUESTS_DIR)) return [];

  const files = fs.readdirSync(IPC_REQUESTS_DIR).filter(
    (f) => f.endsWith('.json') && !f.endsWith('.result.json'),
  );

  const requests: SpecialistRequest[] = [];
  for (const file of files) {
    const filePath = path.join(IPC_REQUESTS_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.type === 'specialist_request') {
        fs.unlinkSync(filePath); // consume the request
        requests.push(data);
      }
    } catch {
      // skip malformed files
    }
  }
  return requests;
}

function checkShutdown(): boolean {
  return fs.existsSync(path.join(IPC_REQUESTS_DIR, '_shutdown'));
}

async function main(): Promise<void> {
  console.error(
    `[specialist] Started: model=${model} baseURL=${baseURL} idle=${IDLE_TIMEOUT}ms`,
  );

  fs.mkdirSync(IPC_REQUESTS_DIR, { recursive: true });

  let lastActivity = Date.now();

  while (true) {
    if (checkShutdown()) {
      console.error('[specialist] Shutdown sentinel detected, exiting');
      break;
    }

    if (Date.now() - lastActivity > IDLE_TIMEOUT) {
      console.error('[specialist] Idle timeout, exiting');
      break;
    }

    const requests = scanForRequests();
    if (requests.length > 0) {
      lastActivity = Date.now();
      for (const req of requests) {
        await processRequest(req);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

main().catch((err) => {
  console.error('[specialist] Fatal error:', err);
  process.exit(1);
});

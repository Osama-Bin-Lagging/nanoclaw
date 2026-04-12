/**
 * Specialist Manager for NanoClaw
 * Manages persistent OpenAI-compatible specialist agent containers.
 * Specialists are defined in data/agents.json, lazy-booted on first use,
 * and communicate via IPC files.
 */

import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  stopContainer,
} from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface SpecialistAgent {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string; // raw key or "env:VAR_NAME"
  description: string;
  systemPrompt?: string;
  enabled?: boolean; // default: true
}

interface RunningSpecialist {
  agent: SpecialistAgent;
  containerName: string;
  ipcDir: string;
  process: ChildProcess;
}

const SPECIALIST_IMAGE =
  process.env.SPECIALIST_IMAGE || 'nanoclaw-specialist:latest';
const SPECIALIST_TIMEOUT = parseInt(
  process.env.SPECIALIST_TIMEOUT || '120000',
  10,
);
const SPECIALIST_IDLE_TIMEOUT = parseInt(
  process.env.SPECIALIST_IDLE_TIMEOUT || '600000',
  10,
);

const DATA_DIR = path.resolve(process.cwd(), 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const SPECIALISTS_IPC_BASE = path.join(DATA_DIR, 'ipc', '_specialists');

export class SpecialistManager {
  private agents = new Map<string, SpecialistAgent>();
  private running = new Map<string, RunningSpecialist>();

  loadAgents(): void {
    if (!fs.existsSync(AGENTS_FILE)) {
      logger.debug('No agents.json found, specialists disabled');
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
      for (const agent of raw as SpecialistAgent[]) {
        if (agent.enabled === false) {
          logger.info({ agent: agent.name }, 'Specialist disabled, skipping');
          continue;
        }
        this.agents.set(agent.name, agent);
      }
      logger.info(
        { count: this.agents.size },
        'Specialist agents loaded',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to load agents.json');
    }
  }

  getAgentList(): Array<{ name: string; description: string }> {
    return Array.from(this.agents.values()).map((a) => ({
      name: a.name,
      description: a.description,
    }));
  }

  private resolveApiKey(agent: SpecialistAgent): string {
    if (agent.apiKey.startsWith('env:')) {
      const varName = agent.apiKey.slice(4);
      const fromEnv = readEnvFile([varName]);
      const value = process.env[varName] || fromEnv[varName];
      if (!value) {
        throw new Error(
          `Specialist "${agent.name}" requires ${varName} but it's not set`,
        );
      }
      return value;
    }
    return agent.apiKey;
  }

  private ensureRunning(agentName: string): RunningSpecialist {
    const existing = this.running.get(agentName);
    if (existing && !existing.process.killed) {
      return existing;
    }

    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Unknown specialist agent: ${agentName}`);
    }

    const apiKey = this.resolveApiKey(agent);

    // Create IPC directory
    const ipcDir = path.join(SPECIALISTS_IPC_BASE, agentName);
    const requestsDir = path.join(ipcDir, 'requests');
    fs.mkdirSync(requestsDir, { recursive: true });

    const containerName = `nanoclaw-specialist-${agentName}-${Date.now()}`;

    const args: string[] = [
      'run',
      '-i',
      '--rm',
      '--name',
      containerName,
      '-e', `TZ=${TIMEZONE}`,
      '-e', `SPECIALIST_MODEL=${agent.model}`,
      '-e', `SPECIALIST_BASE_URL=${agent.baseUrl}`,
      '-e', `OPENAI_API_KEY=${apiKey}`,
      '-e', `SPECIALIST_IDLE_TIMEOUT=${SPECIALIST_IDLE_TIMEOUT}`,
    ];

    if (agent.systemPrompt) {
      args.push('-e', `SPECIALIST_SYSTEM_PROMPT=${agent.systemPrompt}`);
    }

    args.push(...hostGatewayArgs());

    // Mount IPC directory
    args.push('-v', `${ipcDir}:/workspace/ipc`);

    // Run as host user for bind-mount compatibility
    const hostUid = process.getuid?.();
    const hostGid = process.getgid?.();
    if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
      args.push('--user', `${hostUid}:${hostGid}`);
      args.push('-e', 'HOME=/home/node');
    }

    args.push(SPECIALIST_IMAGE);

    logger.info(
      { agent: agentName, containerName, model: agent.model },
      'Spawning specialist container',
    );

    const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr?.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ specialist: agentName }, line);
      }
    });

    proc.stdout?.on('data', (data) => {
      logger.debug({ specialist: agentName }, data.toString().trim());
    });

    proc.on('close', (code) => {
      logger.info(
        { specialist: agentName, containerName, code },
        'Specialist container exited',
      );
      this.running.delete(agentName);
    });

    proc.on('error', (err) => {
      logger.error(
        { specialist: agentName, err },
        'Specialist container spawn error',
      );
      this.running.delete(agentName);
    });

    const specialist: RunningSpecialist = {
      agent,
      containerName,
      ipcDir,
      process: proc,
    };
    this.running.set(agentName, specialist);

    return specialist;
  }

  async invoke(
    agentName: string,
    prompt: string,
    callerGroupFolder: string,
  ): Promise<{ output?: string; error?: string }> {
    let specialist: RunningSpecialist;
    try {
      specialist = this.ensureRunning(agentName);
    } catch (err) {
      return { error: (err as Error).message };
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestsDir = path.join(specialist.ipcDir, 'requests');

    // Write request
    const requestFile = path.join(requestsDir, `${requestId}.json`);
    const tmpFile = requestFile + '.tmp';
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        type: 'specialist_request',
        requestId,
        agent: agentName,
        prompt,
        groupFolder: callerGroupFolder,
        timestamp: new Date().toISOString(),
      }),
    );
    fs.renameSync(tmpFile, requestFile);

    logger.info(
      { specialist: agentName, requestId },
      'Specialist request sent',
    );

    // Poll for result
    const resultFile = path.join(requestsDir, `${requestId}.result.json`);
    const start = Date.now();
    const POLL_MS = 500;

    while (Date.now() - start < SPECIALIST_TIMEOUT) {
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          // Cleanup
          try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
          logger.info(
            { specialist: agentName, requestId, durationMs: result.durationMs },
            'Specialist result received',
          );
          if (result.status === 'success') {
            return { output: result.output };
          }
          return { error: result.error || 'Specialist returned error' };
        } catch {
          // result file not ready yet (partial write)
        }
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    // Cleanup stale request
    try { fs.unlinkSync(requestFile); } catch { /* ignore */ }

    return { error: `Specialist "${agentName}" timed out after ${SPECIALIST_TIMEOUT / 1000}s` };
  }

  async stopAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [name, specialist] of this.running) {
      // Write shutdown sentinel
      const shutdownFile = path.join(specialist.ipcDir, 'requests', '_shutdown');
      try {
        fs.writeFileSync(shutdownFile, '');
      } catch { /* ignore */ }

      promises.push(
        new Promise<void>((resolve) => {
          // Give the container a few seconds to exit gracefully
          const timeout = setTimeout(() => {
            exec(stopContainer(specialist.containerName), { timeout: 5000 }, () => {
              resolve();
            });
          }, 3000);

          specialist.process.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
      );

      logger.info({ specialist: name }, 'Stopping specialist');
    }

    await Promise.all(promises);
    this.running.clear();
    logger.info('All specialists stopped');
  }
}

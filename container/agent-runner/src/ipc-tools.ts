/**
 * IPC tools for NanoClaw agent runner (OpenAI function calling format).
 * Ports the tool definitions and execution logic from ipc-mcp-stdio.ts.
 * Tools write JSON files to IPC directories so the host process can pick them up.
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context set via configure()
let _chatJid = '';
let _groupFolder = '';
let _isMain = false;

/**
 * Set the per-invocation context. Must be called before getIpcTools() is used.
 */
export function configure(chatJid: string, groupFolder: string, isMain: boolean): void {
  _chatJid = chatJid;
  _groupFolder = groupFolder;
  _isMain = isMain;
}

/**
 * Atomic write: write to a temp file then rename into place.
 * Returns the filename written.
 */
function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

export function getIpcTools(): Array<{
  definition: ChatCompletionTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}> {
  return [
    // -------------------------------------------------------------------------
    // send_message
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'send_message',
          description:
            "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
          parameters: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The message text to send',
              },
              sender: {
                type: 'string',
                description:
                  'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
              },
            },
            required: ['text'],
          },
        },
      },
      execute: async (args) => {
        const data: Record<string, string | undefined> = {
          type: 'message',
          chatJid: _chatJid,
          text: args.text as string,
          sender: args.sender !== undefined ? (args.sender as string) : undefined,
          groupFolder: _groupFolder,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(MESSAGES_DIR, data);

        return 'Message sent.';
      },
    },

    // -------------------------------------------------------------------------
    // schedule_task
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'schedule_task',
          description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
          parameters: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description:
                  'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
              },
              schedule_type: {
                type: 'string',
                enum: ['cron', 'interval', 'once'],
                description:
                  'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
              },
              schedule_value: {
                type: 'string',
                description:
                  'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
              },
              context_mode: {
                type: 'string',
                enum: ['group', 'isolated'],
                description:
                  'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
              },
              target_group_jid: {
                type: 'string',
                description:
                  '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
              },
              script: {
                type: 'string',
                description:
                  'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
              },
            },
            required: ['prompt', 'schedule_type', 'schedule_value'],
          },
        },
      },
      execute: async (args) => {
        const scheduleType = args.schedule_type as string;
        const scheduleValue = args.schedule_value as string;

        // Validate schedule_value before writing IPC
        if (scheduleType === 'cron') {
          try {
            CronExpressionParser.parse(scheduleValue);
          } catch {
            return `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            return `Invalid interval: "${scheduleValue}". Must be positive milliseconds (e.g., "300000" for 5 min).`;
          }
        } else if (scheduleType === 'once') {
          if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
            return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}" — use format like "2026-02-01T15:30:00".`;
          }
          const date = new Date(scheduleValue);
          if (isNaN(date.getTime())) {
            return `Invalid timestamp: "${scheduleValue}". Use local time format like "2026-02-01T15:30:00".`;
          }
        }

        // Non-main groups can only schedule for themselves
        const targetJid =
          _isMain && args.target_group_jid ? (args.target_group_jid as string) : _chatJid;

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const data: Record<string, string | undefined> = {
          type: 'schedule_task',
          taskId,
          prompt: args.prompt as string,
          script: args.script !== undefined ? (args.script as string) : undefined,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: (args.context_mode as string | undefined) ?? 'group',
          targetJid,
          createdBy: _groupFolder,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(TASKS_DIR, data);

        return `Task ${taskId} scheduled: ${scheduleType} - ${scheduleValue}`;
      },
    },

    // -------------------------------------------------------------------------
    // list_tasks
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'list_tasks',
          description:
            "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
          parameters: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
      },
      execute: async (_args) => {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

        try {
          if (!fs.existsSync(tasksFile)) {
            return 'No scheduled tasks found.';
          }

          const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

          const tasks = _isMain
            ? allTasks
            : allTasks.filter(
                (t: { groupFolder: string }) => t.groupFolder === _groupFolder,
              );

          if (tasks.length === 0) {
            return 'No scheduled tasks found.';
          }

          const formatted = tasks
            .map(
              (t: {
                id: string;
                prompt: string;
                schedule_type: string;
                schedule_value: string;
                status: string;
                next_run: string;
              }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');

          return `Scheduled tasks:\n${formatted}`;
        } catch (err) {
          return `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },

    // -------------------------------------------------------------------------
    // pause_task
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'pause_task',
          description: 'Pause a scheduled task. It will not run until resumed.',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: 'The task ID to pause',
              },
            },
            required: ['task_id'],
          },
        },
      },
      execute: async (args) => {
        const data = {
          type: 'pause_task',
          taskId: args.task_id as string,
          groupFolder: _groupFolder,
          isMain: _isMain,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(TASKS_DIR, data);

        return `Task ${args.task_id as string} pause requested.`;
      },
    },

    // -------------------------------------------------------------------------
    // resume_task
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'resume_task',
          description: 'Resume a paused task.',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: 'The task ID to resume',
              },
            },
            required: ['task_id'],
          },
        },
      },
      execute: async (args) => {
        const data = {
          type: 'resume_task',
          taskId: args.task_id as string,
          groupFolder: _groupFolder,
          isMain: _isMain,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(TASKS_DIR, data);

        return `Task ${args.task_id as string} resume requested.`;
      },
    },

    // -------------------------------------------------------------------------
    // cancel_task
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'cancel_task',
          description: 'Cancel and delete a scheduled task.',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: 'The task ID to cancel',
              },
            },
            required: ['task_id'],
          },
        },
      },
      execute: async (args) => {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id as string,
          groupFolder: _groupFolder,
          isMain: _isMain,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(TASKS_DIR, data);

        return `Task ${args.task_id as string} cancellation requested.`;
      },
    },

    // -------------------------------------------------------------------------
    // update_task
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'update_task',
          description:
            'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: 'The task ID to update',
              },
              prompt: {
                type: 'string',
                description: 'New prompt for the task',
              },
              schedule_type: {
                type: 'string',
                enum: ['cron', 'interval', 'once'],
                description: 'New schedule type',
              },
              schedule_value: {
                type: 'string',
                description: 'New schedule value (see schedule_task for format)',
              },
              script: {
                type: 'string',
                description:
                  'New script for the task. Set to empty string to remove the script.',
              },
            },
            required: ['task_id'],
          },
        },
      },
      execute: async (args) => {
        const scheduleType = args.schedule_type as string | undefined;
        const scheduleValue = args.schedule_value as string | undefined;

        // Validate schedule_value if provided
        if (scheduleType === 'cron' || (!scheduleType && scheduleValue)) {
          if (scheduleValue) {
            try {
              CronExpressionParser.parse(scheduleValue);
            } catch {
              return `Invalid cron: "${scheduleValue}".`;
            }
          }
        }
        if (scheduleType === 'interval' && scheduleValue) {
          const ms = parseInt(scheduleValue, 10);
          if (isNaN(ms) || ms <= 0) {
            return `Invalid interval: "${scheduleValue}".`;
          }
        }

        const data: Record<string, string | undefined> = {
          type: 'update_task',
          taskId: args.task_id as string,
          groupFolder: _groupFolder,
          isMain: String(_isMain),
          timestamp: new Date().toISOString(),
        };
        if (args.prompt !== undefined) data.prompt = args.prompt as string;
        if (args.script !== undefined) data.script = args.script as string;
        if (scheduleType !== undefined) data.schedule_type = scheduleType;
        if (scheduleValue !== undefined) data.schedule_value = scheduleValue;

        writeIpcFile(TASKS_DIR, data);

        return `Task ${args.task_id as string} update requested.`;
      },
    },

    // -------------------------------------------------------------------------
    // register_group
    // -------------------------------------------------------------------------
    {
      definition: {
        type: 'function',
        function: {
          name: 'register_group',
          description: `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
          parameters: {
            type: 'object',
            properties: {
              jid: {
                type: 'string',
                description:
                  'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
              },
              name: {
                type: 'string',
                description: 'Display name for the group',
              },
              folder: {
                type: 'string',
                description:
                  'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
              },
              trigger: {
                type: 'string',
                description: 'Trigger word (e.g., "@Andy")',
              },
            },
            required: ['jid', 'name', 'folder', 'trigger'],
          },
        },
      },
      execute: async (args) => {
        if (!_isMain) {
          return 'Only the main group can register new groups.';
        }

        const data = {
          type: 'register_group',
          jid: args.jid as string,
          name: args.name as string,
          folder: args.folder as string,
          trigger: args.trigger as string,
          timestamp: new Date().toISOString(),
        };

        writeIpcFile(TASKS_DIR, data);

        return `Group "${args.name as string}" registered. It will start receiving messages immediately.`;
      },
    },
  ];
}

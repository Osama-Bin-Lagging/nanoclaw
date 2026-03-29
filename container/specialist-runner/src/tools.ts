import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';

// Tool implementations

export function bashExec(args: {
  command: string;
  timeout?: number;
}): string {
  try {
    const result = execSync(args.command, {
      timeout: args.timeout || 30000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      cwd: '/workspace/group',
    });
    return result;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return `Error: ${e.stderr || e.stdout || e.message}`;
  }
}

export function readFile(args: {
  path: string;
  offset?: number;
  limit?: number;
}): string {
  try {
    const content = fs.readFileSync(args.path, 'utf-8');
    const lines = content.split('\n');
    const start = args.offset || 0;
    const end = args.limit ? start + args.limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n');
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

export function writeFile(args: { path: string; content: string }): string {
  try {
    const dir = path.dirname(args.path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.path, args.content);
    return `Written ${args.content.length} bytes to ${args.path}`;
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

export function editFile(args: {
  path: string;
  old_text: string;
  new_text: string;
}): string {
  try {
    const content = fs.readFileSync(args.path, 'utf-8');
    if (!content.includes(args.old_text)) {
      return `Error: old_text not found in ${args.path}`;
    }
    const count = content.split(args.old_text).length - 1;
    if (count > 1) {
      return `Error: old_text found ${count} times in ${args.path}, must be unique`;
    }
    fs.writeFileSync(args.path, content.replace(args.old_text, args.new_text));
    return `Edited ${args.path}`;
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

export function glob(args: { pattern: string; path?: string }): string {
  try {
    const dir = args.path || '/workspace/group';
    const result = execSync(
      `find ${JSON.stringify(dir)} -name ${JSON.stringify(args.pattern)} -type f 2>/dev/null | head -100`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    return result || 'No matches found';
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

export function grep(args: {
  pattern: string;
  path?: string;
  type?: string;
}): string {
  try {
    const dir = args.path || '/workspace/group';
    let cmd = `grep -rn ${JSON.stringify(args.pattern)} ${JSON.stringify(dir)}`;
    if (args.type) {
      cmd += ` --include="*.${args.type}"`;
    }
    cmd += ' 2>/dev/null | head -50';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    return result || 'No matches found';
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

export async function webFetch(args: { url: string }): Promise<string> {
  try {
    const res = await fetch(args.url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'NanoClaw-Specialist/1.0' },
    });
    const text = await res.text();
    return text.slice(0, 10000);
  } catch (err: unknown) {
    return `Error: ${(err as Error).message}`;
  }
}

// Tool dispatcher
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'bash_exec':
      return bashExec(args as Parameters<typeof bashExec>[0]);
    case 'read_file':
      return readFile(args as Parameters<typeof readFile>[0]);
    case 'write_file':
      return writeFile(args as Parameters<typeof writeFile>[0]);
    case 'edit_file':
      return editFile(args as Parameters<typeof editFile>[0]);
    case 'glob':
      return glob(args as Parameters<typeof glob>[0]);
    case 'grep':
      return grep(args as Parameters<typeof grep>[0]);
    case 'web_fetch':
      return await webFetch(args as Parameters<typeof webFetch>[0]);
    default:
      return `Unknown tool: ${name}`;
  }
}

// OpenAI function definitions
export const toolDefinitions: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Execute a bash command and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout: {
            type: 'number',
            description: 'Timeout in ms (default: 30000)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file and return its contents with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          offset: { type: 'number', description: 'Starting line (0-based)' },
          limit: { type: 'number', description: 'Number of lines to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace a unique string in a file. old_text must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          old_text: { type: 'string', description: 'Text to find (must be unique)' },
          new_text: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a name pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename pattern (e.g. "*.ts")' },
          path: { type: 'string', description: 'Directory to search (default: /workspace/group)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for a pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search (default: /workspace/group)' },
          type: { type: 'string', description: 'File extension filter (e.g. "ts")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch content from a URL. Returns first 10KB of text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
];

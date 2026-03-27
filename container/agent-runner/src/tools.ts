import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 100 * 1024; // 100 KB
const MAX_WEB_BYTES = 50 * 1024;     // 50 KB
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_BASH_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  return buf.slice(0, maxBytes).toString('utf8') + `\n[truncated — output exceeded ${maxBytes} bytes]`;
}

function catN(lines: string[], startLine: number): string {
  // startLine is 1-based (first line in the slice = startLine)
  return lines
    .map((line, i) => {
      const lineNum = startLine + i;
      const padded = String(lineNum).padStart(6);
      return `${padded}\t${line}`;
    })
    .join('\n');
}

/** Recursively list all files under a directory, skipping node_modules and .git. */
function walkDir(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Minimal glob matcher supporting `*`, `**`, and `?`.
 * Matches the full path string against the pattern.
 */
function globMatch(pattern: string, filePath: string): boolean {
  // Escape regex special chars except our wildcards
  const regexStr = pattern
    .split('**')
    .map(segment =>
      segment
        .split('*')
        .map(part =>
          part
            .split('?')
            .map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]')
        )
        .join('[^/]*')
    )
    .join('.*');

  const regex = new RegExp(`^${regexStr}$`);

  // Try matching against the full path and also just the basename
  return regex.test(filePath) || regex.test(path.basename(filePath));
}

function looksLikeBinary(buf: Buffer): boolean {
  // Heuristic: if the first 8 KB contain a null byte, treat as binary
  const sample = buf.slice(0, 8192);
  return sample.includes(0);
}

// ---------------------------------------------------------------------------
// Tool: bash
// ---------------------------------------------------------------------------

const bashDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'bash',
    description:
      'Execute a shell command in the agent workspace (/workspace/group). ' +
      'Returns stdout and stderr. Output is truncated to 100 KB.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        timeout: {
          type: 'number',
          description:
            'Timeout in milliseconds before the command is killed. Default 120000 (2 minutes).',
        },
      },
      required: ['command'],
    },
  },
};

async function bashExecute(args: Record<string, unknown>): Promise<string> {
  const command = args['command'] as string;
  const timeout = typeof args['timeout'] === 'number' ? args['timeout'] : DEFAULT_BASH_TIMEOUT;

  let stdout = '';
  let stderr = '';

  try {
    const result = await execFileAsync('bash', ['-c', command], {
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      cwd: '/workspace/group',
      env: { ...process.env },
    });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: number | string;
    };
    const partialStdout = error.stdout ?? '';
    const partialStderr = error.stderr ?? '';
    const killed = error.killed === true;
    const code = error.code;

    let msg = killed
      ? `Command timed out after ${timeout}ms.`
      : `Command failed with exit code ${code ?? 'unknown'}: ${error.message}`;

    const parts: string[] = [msg];
    if (partialStdout) parts.push(`stdout:\n${partialStdout}`);
    if (partialStderr) parts.push(`stderr:\n${partialStderr}`);

    return truncate(parts.join('\n'), MAX_OUTPUT_BYTES);
  }

  const parts: string[] = [];
  if (stdout) parts.push(`stdout:\n${stdout}`);
  if (stderr) parts.push(`stderr:\n${stderr}`);
  const combined = parts.join('\n') || '(no output)';
  return truncate(combined, MAX_OUTPUT_BYTES);
}

// ---------------------------------------------------------------------------
// Tool: read_file
// ---------------------------------------------------------------------------

const readFileDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a file from the filesystem. Returns file contents with line numbers in `cat -n` format. ' +
      'Use offset and limit to read large files in chunks.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative path to the file.',
        },
        offset: {
          type: 'number',
          description: '1-based line number to start reading from. Defaults to 1.',
        },
        limit: {
          type: 'number',
          description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.`,
        },
      },
      required: ['file_path'],
    },
  },
};

async function readFileExecute(args: Record<string, unknown>): Promise<string> {
  const filePath = args['file_path'] as string;
  const offset = typeof args['offset'] === 'number' ? Math.max(1, args['offset']) : 1;
  const limit = typeof args['limit'] === 'number' ? args['limit'] : DEFAULT_READ_LIMIT;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const allLines = raw.split('\n');

    // offset is 1-based; slice is 0-based
    const startIndex = offset - 1;
    const sliced = allLines.slice(startIndex, startIndex + limit);

    return catN(sliced, offset);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error reading file '${filePath}': ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Tool: write_file
// ---------------------------------------------------------------------------

const writeFileDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      'Write content to a file, creating it (and any parent directories) if it does not exist. ' +
      'Overwrites the file if it already exists.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative path to the file.',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
};

async function writeFileExecute(args: Record<string, unknown>): Promise<string> {
  const filePath = args['file_path'] as string;
  const content = args['content'] as string;

  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return `File written successfully: ${filePath}`;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error writing file '${filePath}': ${error.message}`;
  }
}

// ---------------------------------------------------------------------------
// Tool: edit_file
// ---------------------------------------------------------------------------

const editFileDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Find and replace text in an existing file. ' +
      'If old_text appears more than once and replace_all is false, the edit is rejected — ' +
      'provide more surrounding context to make the match unique, or set replace_all to true.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative path to the file.',
        },
        old_text: {
          type: 'string',
          description: 'Exact text to find and replace.',
        },
        new_text: {
          type: 'string',
          description: 'Text to replace old_text with.',
        },
        replace_all: {
          type: 'boolean',
          description:
            'When true, replace every occurrence of old_text. ' +
            'When false (default), the edit fails if old_text appears more than once.',
        },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
  },
};

async function editFileExecute(args: Record<string, unknown>): Promise<string> {
  const filePath = args['file_path'] as string;
  const oldText = args['old_text'] as string;
  const newText = args['new_text'] as string;
  const replaceAll = typeof args['replace_all'] === 'boolean' ? args['replace_all'] : false;

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error reading file '${filePath}': ${error.message}`;
  }

  if (!content.includes(oldText)) {
    return `Error: old_text not found in '${filePath}'. No changes made.`;
  }

  // Count occurrences
  let count = 0;
  let searchFrom = 0;
  while (true) {
    const idx = content.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    count++;
    searchFrom = idx + oldText.length;
  }

  if (count > 1 && !replaceAll) {
    return (
      `Error: old_text appears ${count} times in '${filePath}'. ` +
      `To replace all occurrences set replace_all to true, ` +
      `or provide more surrounding context to make the match unique.`
    );
  }

  const modified = replaceAll
    ? content.split(oldText).join(newText)
    : content.replace(oldText, newText);

  try {
    fs.writeFileSync(filePath, modified, 'utf8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error writing file '${filePath}': ${error.message}`;
  }

  const occurrenceLabel = replaceAll && count > 1 ? `${count} occurrences` : '1 occurrence';
  return `Successfully replaced ${occurrenceLabel} in '${filePath}'.`;
}

// ---------------------------------------------------------------------------
// Tool: glob
// ---------------------------------------------------------------------------

const globDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'glob',
    description:
      'Find files matching a glob pattern. Supports `*`, `**`, and `?`. ' +
      `Returns up to ${MAX_GLOB_RESULTS} matching paths, one per line.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match against file paths (e.g. "**/*.ts", "src/*.js").',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Defaults to the current working directory.',
        },
      },
      required: ['pattern'],
    },
  },
};

async function globExecute(args: Record<string, unknown>): Promise<string> {
  const pattern = args['pattern'] as string;
  const searchPath =
    typeof args['path'] === 'string' ? args['path'] : process.cwd();

  let allFiles: string[];
  try {
    allFiles = walkDir(searchPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error accessing path '${searchPath}': ${error.message}`;
  }

  // Make paths relative to searchPath for matching, then return absolute
  const matched: string[] = [];
  for (const filePath of allFiles) {
    if (matched.length >= MAX_GLOB_RESULTS) break;
    const rel = path.relative(searchPath, filePath);
    if (globMatch(pattern, rel) || globMatch(pattern, filePath)) {
      matched.push(filePath);
    }
  }

  if (matched.length === 0) return 'No files matched the pattern.';
  const result = matched.join('\n');
  if (matched.length === MAX_GLOB_RESULTS) {
    return result + `\n[Results truncated at ${MAX_GLOB_RESULTS} files]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool: grep
// ---------------------------------------------------------------------------

const grepDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'grep',
    description:
      'Search file contents for a regex pattern. ' +
      `Returns matches in "file:line_number:content" format, up to ${MAX_GREP_MATCHES} matches. ` +
      'Skips binary files, node_modules, and .git directories.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression to search for.',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in. Defaults to the current working directory.',
        },
        include: {
          type: 'string',
          description: 'Glob pattern to filter which files are searched (e.g. "*.ts", "**/*.json").',
        },
      },
      required: ['pattern'],
    },
  },
};

async function grepExecute(args: Record<string, unknown>): Promise<string> {
  const pattern = args['pattern'] as string;
  const searchPath =
    typeof args['path'] === 'string' ? args['path'] : process.cwd();
  const include = typeof args['include'] === 'string' ? args['include'] : null;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `Error: invalid regex pattern: ${pattern}`;
  }

  // Determine if searchPath is a file or directory
  let filesToSearch: string[];
  try {
    const stat = fs.statSync(searchPath);
    if (stat.isFile()) {
      filesToSearch = [searchPath];
    } else {
      filesToSearch = walkDir(searchPath);
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Error accessing path '${searchPath}': ${error.message}`;
  }

  // Apply include filter if provided
  if (include !== null) {
    filesToSearch = filesToSearch.filter(f => {
      const rel = path.relative(searchPath, f);
      return globMatch(include, rel) || globMatch(include, path.basename(f));
    });
  }

  const matches: string[] = [];

  for (const filePath of filesToSearch) {
    if (matches.length >= MAX_GREP_MATCHES) break;

    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      continue;
    }

    if (looksLikeBinary(buf)) continue;

    const text = buf.toString('utf8');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      if (regex.test(lines[i])) {
        matches.push(`${filePath}:${i + 1}:${lines[i]}`);
      }
    }
  }

  if (matches.length === 0) return 'No matches found.';
  const result = matches.join('\n');
  if (matches.length === MAX_GREP_MATCHES) {
    return result + `\n[Results truncated at ${MAX_GREP_MATCHES} matches]`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool: web_fetch
// ---------------------------------------------------------------------------

const webFetchDefinition: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description:
      'Fetch the content of a URL. Returns the response body as text, truncated to 50 KB. ' +
      'Times out after 30 seconds.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch.',
        },
      },
      required: ['url'],
    },
  },
};

async function webFetchExecute(args: Record<string, unknown>): Promise<string> {
  const url = args['url'] as string;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return truncate(text, MAX_WEB_BYTES);
  } catch (err: unknown) {
    const error = err as Error;
    if (error.name === 'AbortError') {
      return `Error fetching '${url}': request timed out after 30 seconds.`;
    }
    return `Error fetching '${url}': ${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const coreTools: Array<{
  definition: ChatCompletionTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}> = [
  { definition: bashDefinition,      execute: bashExecute      },
  { definition: readFileDefinition,  execute: readFileExecute  },
  { definition: writeFileDefinition, execute: writeFileExecute },
  { definition: editFileDefinition,  execute: editFileExecute  },
  { definition: globDefinition,      execute: globExecute      },
  { definition: grepDefinition,      execute: grepExecute      },
  { definition: webFetchDefinition,  execute: webFetchExecute  },
];

export function getToolExecutor(
  name: string
): ((args: Record<string, unknown>) => Promise<string>) | undefined {
  return coreTools.find(t => t.definition.function.name === name)?.execute;
}

import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

interface Session {
  id: string;
  messages: ChatCompletionMessageParam[];
  createdAt: string;
  updatedAt: string;
}

export function generateSessionId(): string {
  return `session-${Date.now()}-${randomUUID()}`;
}

export function loadSession(sessionId: string, sessionDir: string): ChatCompletionMessageParam[] {
  const filePath = path.join(sessionDir, `${sessionId}.json`);
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const session: Session = JSON.parse(raw);
    return session.messages ?? [];
  } catch (err) {
    console.error(`[session] Failed to load session ${sessionId}:`, err);
    return [];
  }
}

export function saveSession(sessionId: string, sessionDir: string, messages: ChatCompletionMessageParam[]): void {
  try {
    fs.mkdirSync(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    const filePath = path.join(sessionDir, `${sessionId}.json`);
    const tmpPath = `${filePath}.tmp`;

    let createdAt = now;
    try {
      if (fs.existsSync(filePath)) {
        const existing: Session = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        createdAt = existing.createdAt ?? now;
      }
    } catch {
      // ignore — use now as createdAt
    }

    const session: Session = {
      id: sessionId,
      messages,
      createdAt,
      updatedAt: now,
    };

    fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[session] Failed to save session ${sessionId}:`, err);
  }
}

export function truncateHistory(
  messages: ChatCompletionMessageParam[],
  maxChars: number
): ChatCompletionMessageParam[] {
  const totalChars = (msgs: ChatCompletionMessageParam[]): number =>
    msgs.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      return sum + content.length;
    }, 0);

  if (totalChars(messages) <= maxChars) {
    return messages;
  }

  const systemMessage = messages[0]?.role === 'system' ? messages[0] : null;
  const nonSystem = systemMessage ? messages.slice(1) : messages.slice();

  // Always keep at least the last 5 non-system messages
  const minKeep = 5;

  let trimmed = nonSystem.slice();
  while (trimmed.length > minKeep) {
    const combined = systemMessage ? [systemMessage, ...trimmed] : trimmed;
    if (totalChars(combined) <= maxChars) {
      break;
    }
    trimmed.shift();
  }

  return systemMessage ? [systemMessage, ...trimmed] : trimmed;
}

export function archiveTranscript(
  messages: ChatCompletionMessageParam[],
  conversationsDir: string,
  assistantName?: string
): void {
  try {
    fs.mkdirSync(conversationsDir, { recursive: true });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateTimeStr = now.toISOString().replace('T', ' ').slice(0, 19);

    const firstUserMessage = messages.find((m) => m.role === 'user');
    const firstUserText =
      firstUserMessage && typeof firstUserMessage.content === 'string'
        ? firstUserMessage.content
        : firstUserMessage?.content
          ? JSON.stringify(firstUserMessage.content)
          : 'conversation';

    const safeName = firstUserText
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'conversation';

    const fileName = `${dateStr}-${safeName}.md`;
    const filePath = path.join(conversationsDir, fileName);

    const agentLabel = assistantName ?? 'Assistant';

    const lines: string[] = ['# Conversation', '', `Archived: ${dateTimeStr}`, '', '---', ''];

    for (const message of messages) {
      if (message.role === 'system') continue;
      if (message.role === 'tool') continue;
      if (
        message.role === 'assistant' &&
        message.content === null &&
        (message as { tool_calls?: unknown }).tool_calls
      ) {
        continue;
      }

      const rawContent =
        typeof message.content === 'string'
          ? message.content
          : message.content
            ? JSON.stringify(message.content)
            : '';

      const truncated =
        rawContent.length > 2000 ? rawContent.slice(0, 2000) + '...' : rawContent;

      if (message.role === 'user') {
        lines.push(`**User**: ${truncated}`, '');
      } else if (message.role === 'assistant') {
        lines.push(`**${agentLabel}**: ${truncated}`, '');
      }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  } catch (err) {
    console.error('[session] Failed to archive transcript:', err);
  }
}

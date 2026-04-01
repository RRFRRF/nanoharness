/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 *
 * Deep Agents replaces the Claude Agent SDK, but the host/container protocol
 * stays stable:
 * - stdin: ContainerInput JSON
 * - stdout: marker-wrapped ContainerOutput JSON
 * - IPC files under /workspace/ipc for host coordination
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { CronExpressionParser } from 'cron-parser';
import { createDeepAgent, LocalShellBackend } from 'deepagents';
import { z } from 'zod';

const posixPath = path.posix;

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  queryCompleted?: boolean;
  event?: {
    type: 'assistant' | 'status';
    text: string;
    replace?: boolean;
  };
  error?: string;
}

interface QueryRunResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  lastAssistantText: string;
  lastResultText: string | null;
  lastResultSubtype?: string;
  sawStatusEvent: boolean;
}

type AnyRecord = Record<string, unknown>;
type MountMode = 'rw' | 'ro' | 'host-configured';

interface WorkspaceMountInfo {
  path: string;
  exists: boolean;
  mode: MountMode;
  purpose: string;
  entries?: string[];
}

interface WorkspaceManifest {
  generatedAt: string;
  writableRoot: string;
  requiredOutputRoot: string;
  rules: string[];
  mounts: WorkspaceMountInfo[];
}

interface MemorySnapshot {
  path: string;
  included: boolean;
  content: string | null;
}

interface RuntimeContextSnapshot {
  generatedAt: string;
  sessionId: string | null;
  resumeAt: string | null;
  isScheduledTask: boolean;
  workspaceManifestPath: string;
  pendingIpcMessages: string[];
  runtimeInstructions: string[];
  memories: {
    group: MemorySnapshot;
    global: MemorySnapshot;
    project: MemorySnapshot;
  };
  basePrompt: string;
  finalPrompt: string;
}

interface RuntimePromptBundle {
  runtimePrompt: string;
  snapshot: RuntimeContextSnapshot;
}

const WORKSPACE_ROOT = '/workspace';
const GROUP_ROOT = '/workspace/group';
const GLOBAL_ROOT = '/workspace/global';
const SKILLS_SRC = '/home/node/.claude/skills';
const SKILLS_DST = '/workspace/group/.deepagents-skills';
const RUNTIME_ROOT = posixPath.join(GROUP_ROOT, '.nanoclaw');
const RUNTIME_CONTEXT_DIR = posixPath.join(RUNTIME_ROOT, 'runtime-context');
const RUNTIME_CONTEXT_LATEST = posixPath.join(
  RUNTIME_CONTEXT_DIR,
  'latest.json',
);
const WORKSPACE_MANIFEST_PATH = posixPath.join(
  RUNTIME_ROOT,
  'workspace-manifest.json',
);
const REQUIRED_OUTPUT_ROOT = posixPath.join(GROUP_ROOT, 'outputs');
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = posixPath.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = posixPath.join(IPC_INPUT_DIR, '_close');
const MESSAGES_DIR = posixPath.join(IPC_DIR, 'messages');
const TASKS_DIR = posixPath.join(IPC_DIR, 'tasks');
const IPC_POLL_MS = 500;
const HEARTBEAT_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.NANOCLAW_HEARTBEAT_MS || '20000', 10) || 20000,
);
const QUERY_RECURSION_LIMIT = Math.max(
  150,
  Number.parseInt(process.env.NANOCLAW_RECURSION_LIMIT || '600', 10) || 600,
);

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function readOptionalFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    log(
      `Failed to read ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function listDirectoryEntries(dirPath: string): string[] {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).sort();
  } catch (err) {
    log(
      `Failed to list ${dirPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'query';
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function buildWorkspaceManifest(
  containerInput: ContainerInput,
): WorkspaceManifest {
  const mounts: WorkspaceMountInfo[] = [
    {
      path: GROUP_ROOT,
      exists: fs.existsSync(GROUP_ROOT),
      mode: 'rw',
      purpose: 'Primary writable workspace for this agent and all generated artifacts.',
      entries: listDirectoryEntries(GROUP_ROOT),
    },
    {
      path: IPC_DIR,
      exists: fs.existsSync(IPC_DIR),
      mode: 'rw',
      purpose: 'NanoClaw IPC bridge for streaming messages, tasks, and follow-up input.',
      entries: listDirectoryEntries(IPC_DIR),
    },
    {
      path: GLOBAL_ROOT,
      exists: fs.existsSync(GLOBAL_ROOT),
      mode: 'ro',
      purpose: 'Shared global memory mounted read-only when available.',
      entries: listDirectoryEntries(GLOBAL_ROOT),
    },
    {
      path: '/workspace/project',
      exists: fs.existsSync('/workspace/project'),
      mode: 'ro',
      purpose: containerInput.isMain
        ? 'Main-group project root, mounted read-only.'
        : 'Project root is only mounted for the main group.',
      entries: listDirectoryEntries('/workspace/project'),
    },
    {
      path: '/workspace/extra',
      exists: fs.existsSync('/workspace/extra'),
      mode: 'host-configured',
      purpose:
        'Optional host-approved mounts. Treat them as input sources; write outputs back into /workspace/group.',
      entries: listDirectoryEntries('/workspace/extra'),
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    writableRoot: GROUP_ROOT,
    requiredOutputRoot: REQUIRED_OUTPUT_ROOT,
    rules: [
      `Write all new artifacts under ${GROUP_ROOT}.`,
      `Use absolute paths rooted at ${GROUP_ROOT} when creating files or directories.`,
      'Treat /workspace/project, /workspace/global, and /workspace/extra as mounted inputs unless the user explicitly asked to modify them.',
      `Persist long-running progress, checkpoints, and summaries under ${RUNTIME_ROOT} or ${REQUIRED_OUTPUT_ROOT}.`,
    ],
    mounts,
  };
}

function ensureRuntimeWorkspace(containerInput: ContainerInput): WorkspaceManifest {
  fs.mkdirSync(RUNTIME_CONTEXT_DIR, { recursive: true });
  fs.mkdirSync(REQUIRED_OUTPUT_ROOT, { recursive: true });

  const manifest = buildWorkspaceManifest(containerInput);
  fs.writeFileSync(
    WORKSPACE_MANIFEST_PATH,
    JSON.stringify(manifest, null, 2) + '\n',
  );

  return manifest;
}

function ensureWorkspaceSkills(): string[] {
  if (!fs.existsSync(SKILLS_SRC)) {
    return [];
  }

  fs.mkdirSync(SKILLS_DST, { recursive: true });
  fs.rmSync(SKILLS_DST, { recursive: true, force: true });
  fs.mkdirSync(SKILLS_DST, { recursive: true });

  for (const entry of fs.readdirSync(SKILLS_SRC)) {
    const srcDir = posixPath.join(SKILLS_SRC, entry);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = posixPath.join(SKILLS_DST, entry);
    fs.cpSync(srcDir, dstDir, { recursive: true });
  }

  // Deep Agents skill paths are relative to backend root (/workspace).
  return ['./group/.deepagents-skills/'];
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (!Array.isArray(content)) return '';

  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';

      const record = block as AnyRecord;
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text;
      }
      if (
        record.type === 'reasoning' &&
        typeof record.text === 'string' &&
        record.text.trim()
      ) {
        return `<thinking>\n${record.text.trim()}\n</thinking>`;
      }
      if (
        record.type === 'tool_use' &&
        typeof record.name === 'string' &&
        record.input !== undefined
      ) {
        let renderedInput = '';
        try {
          renderedInput = JSON.stringify(record.input, null, 2);
        } catch {
          renderedInput = String(record.input);
        }
        return `<tool_use name="${record.name}">\n${renderedInput}\n</tool_use>`;
      }
      return '';
    })
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
}

function normalizeRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;

  const record = message as AnyRecord;
  if (typeof record.role === 'string') {
    return record.role;
  }

  const getter = record._getType;
  if (typeof getter === 'function') {
    try {
      return String(getter.call(message));
    } catch {
      return null;
    }
  }

  const ctorName = (message as { constructor?: { name?: string } }).constructor
    ?.name;
  if (ctorName === 'AIMessage') return 'ai';
  if (ctorName === 'HumanMessage') return 'human';

  return null;
}

function getMessageContent(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  return (message as AnyRecord).content;
}

function extractFinalAssistantText(result: unknown): string {
  const messages = extractMessages(result);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = normalizeRole(messages[i]);
    if (role === 'assistant' || role === 'ai') {
      const text = extractTextContent(getMessageContent(messages[i]));
      if (text.trim()) return text.trim();
    }
  }

  if (typeof result === 'string') {
    return result.trim();
  }

  return '';
}

function extractMessages(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];

  const record = result as AnyRecord;
  if (Array.isArray(record.messages)) {
    return record.messages;
  }
  if (record.output && typeof record.output === 'object') {
    const outputRecord = record.output as AnyRecord;
    if (Array.isArray(outputRecord.messages)) {
      return outputRecord.messages;
    }
  }
  return [];
}

function stripStructuredAssistantContent(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, ' ')
    .replace(/<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/g, ' ')
    .replace(/<tool_use\b[^>]*\/>/g, ' ')
    .replace(/<internal>[\s\S]*?<\/internal>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeDelegationEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    /^```json action\b/i.test(trimmed) ||
    /"tool"\s*:\s*"Agent"/i.test(trimmed) ||
    /"subagent_type"\s*:/i.test(trimmed)
  );
}

function looksLikePlanningContinuation(text: string): boolean {
  if (!text.trim()) return false;
  return /(?:\blet me\b|\bi(?:'ll| will)\b|\bstart(?:ing)?\b|\bbegin(?:ning)?\b|\bfirst\b|\bnext\b|接下来|我先|我将|让我|开始|先去|先来|先进行|下一步)/i.test(
    text,
  );
}

function getAutoContinueReason(
  queryResult: QueryRunResult,
  isScheduledTask: boolean,
  autoContinueCount: number,
): string | null {
  const MAX_AUTO_CONTINUES = 6;
  if (isScheduledTask) return null;
  if (queryResult.closedDuringQuery) return null;
  if (
    queryResult.lastResultSubtype &&
    queryResult.lastResultSubtype !== 'success'
  ) {
    return null;
  }
  if (autoContinueCount >= MAX_AUTO_CONTINUES) return null;

  const assistantText = queryResult.lastAssistantText.trim();
  const assistantPlain = stripStructuredAssistantContent(assistantText);
  const resultText = queryResult.lastResultText?.trim() || '';
  const hasStructuredOnly =
    !!assistantText && !assistantPlain && assistantText !== assistantPlain;

  if (
    looksLikeDelegationEnvelope(resultText) ||
    looksLikeDelegationEnvelope(assistantText)
  ) {
    return 'delegation envelope emitted without execution';
  }

  if (!resultText && queryResult.sawStatusEvent) {
    return 'tooling status emitted without a final result';
  }

  if (
    !resultText &&
    (hasStructuredOnly || looksLikePlanningContinuation(assistantPlain))
  ) {
    return 'planning output emitted without a final result';
  }

  return null;
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = posixPath.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(String(data.text));
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

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

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.json`;
  const filePath = posixPath.join(dir, filename);
  const tempPath = `${filePath}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
  return filename;
}

function validateScheduleValue(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
      return null;
    } catch {
      return `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" or "*/5 * * * *".`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      return `Invalid interval: "${scheduleValue}". Must be positive milliseconds.`;
    }
    return null;
  }

  if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
    return `Timestamp must be local time without timezone suffix. Got "${scheduleValue}".`;
  }
  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) {
    return `Invalid timestamp: "${scheduleValue}". Use local time format like "2026-02-01T15:30:00".`;
  }
  return null;
}

export function buildRuntimePromptBundle(
  basePrompt: string,
  containerInput: ContainerInput,
  options?: {
    sessionId?: string;
    resumeAt?: string;
    pendingIpcMessages?: string[];
  },
): RuntimePromptBundle {
  const sections: string[] = [];
  const pendingIpcMessages = options?.pendingIpcMessages || [];
  const runtimeInstructions = [
    'You are running inside NanoClaw on a Deep Agents runtime.',
    `Working directory: ${GROUP_ROOT}`,
    `Write all new files, screenshots, reports, logs, and generated outputs under ${GROUP_ROOT}.`,
    `Prefer absolute output paths under ${REQUIRED_OUTPUT_ROOT} so artifacts never land outside the workspace by accident.`,
    'Treat /workspace/project, /workspace/global, and /workspace/extra as mounted input context unless the user explicitly asked to modify them.',
    `Workspace diagnostics are available at ${WORKSPACE_MANIFEST_PATH} and ${RUNTIME_CONTEXT_LATEST}.`,
    'Deep Agents compatibility mapping for older Claude-style skills:',
    '- Bash -> execute',
    '- Read -> read_file',
    '- Write -> write_file',
    '- Edit -> edit_file',
    '- Glob -> glob',
    '- Grep -> grep',
    '- Task -> task',
    '- TodoWrite -> write_todos',
    '- NanoClaw orchestration tools stay as mcp__nanoclaw__*',
    'Prefer skill-guided workflows when a relevant skill is available.',
    'Persist intermediate artifacts to disk for long workflows instead of emitting huge inline outputs.',
  ];

  if (containerInput.isScheduledTask) {
    sections.push(
      '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]',
    );
  }

  sections.push(runtimeInstructions.join('\n'));

  const groupClaudePath = posixPath.join(GROUP_ROOT, 'CLAUDE.md');
  const globalClaudePath = posixPath.join(GLOBAL_ROOT, 'CLAUDE.md');
  const projectClaudePath = '/workspace/project/CLAUDE.md';

  const groupClaude = readOptionalFile(groupClaudePath);
  if (groupClaude) {
    sections.push(`<group_memory>\n${groupClaude.trim()}\n</group_memory>`);
  }

  const globalClaude = readOptionalFile(globalClaudePath);
  if (globalClaude) {
    sections.push(`<global_memory>\n${globalClaude.trim()}\n</global_memory>`);
  }

  const projectClaude = containerInput.isMain
    ? readOptionalFile(projectClaudePath)
    : null;
  if (projectClaude) {
    sections.push(`<project_memory>\n${projectClaude.trim()}\n</project_memory>`);
  }

  sections.push(basePrompt);
  const runtimePrompt = sections.join('\n\n');

  return {
    runtimePrompt,
    snapshot: {
      generatedAt: new Date().toISOString(),
      sessionId: options?.sessionId || null,
      resumeAt: options?.resumeAt || null,
      isScheduledTask: containerInput.isScheduledTask === true,
      workspaceManifestPath: WORKSPACE_MANIFEST_PATH,
      pendingIpcMessages,
      runtimeInstructions,
      memories: {
        group: {
          path: groupClaudePath,
          included: groupClaude !== null,
          content: groupClaude,
        },
        global: {
          path: globalClaudePath,
          included: globalClaude !== null,
          content: globalClaude,
        },
        project: {
          path: projectClaudePath,
          included: projectClaude !== null,
          content: projectClaude,
        },
      },
      basePrompt,
      finalPrompt: runtimePrompt,
    },
  };
}

function writeRuntimeContextSnapshot(snapshot: RuntimeContextSnapshot): void {
  fs.mkdirSync(RUNTIME_CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(
    RUNTIME_CONTEXT_LATEST,
    JSON.stringify(snapshot, null, 2) + '\n',
  );

  const timestamp = snapshot.generatedAt.replace(/[:.]/g, '-');
  const sessionToken = sanitizeFileToken(snapshot.sessionId || 'new-session');
  const historyPath = posixPath.join(
    RUNTIME_CONTEXT_DIR,
    `${timestamp}-${sessionToken}.json`,
  );
  fs.writeFileSync(historyPath, JSON.stringify(snapshot, null, 2) + '\n');
}

function looksLikeMissingCheckpoint(errorMessage: string): boolean {
  return /checkpoint/i.test(errorMessage) && /(not found|missing|unknown)/i.test(errorMessage);
}

async function getLatestCheckpointId(
  checkpointer: any,
  sessionId: string,
): Promise<string | undefined> {
  if (!checkpointer?.getTuple) return undefined;

  try {
    const tuple = (await checkpointer.getTuple({
      configurable: { thread_id: sessionId },
    })) as AnyRecord | null;

    if (!tuple) return undefined;

    const tupleConfig = tuple.config as AnyRecord | undefined;
    const configurable = tupleConfig?.configurable as AnyRecord | undefined;
    if (typeof configurable?.checkpoint_id === 'string') {
      return configurable.checkpoint_id;
    }

    const checkpoint = tuple.checkpoint as AnyRecord | undefined;
    if (typeof checkpoint?.id === 'string') {
      return checkpoint.id;
    }
  } catch (err) {
    log(
      `Failed to read checkpoint id for session ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return undefined;
}

function createNanoClawTools(
  containerInput: ContainerInput,
  emitStatus: (text: string, replace?: boolean) => void,
) {
  const sendMessageTool = tool(
    async ({
      text,
      sender,
    }: {
      text: string;
      sender?: string;
    }) => {
      emitStatus(`mcp__nanoclaw__send_message: ${text.slice(0, 120)}`);
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: containerInput.chatJid,
        text,
        sender,
        groupFolder: containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return 'Message sent.';
    },
    {
      name: 'mcp__nanoclaw__send_message',
      description:
        "Send a message to the user or group immediately while you're still running.",
      schema: z.object({
        text: z.string().describe('The message text to send'),
        sender: z
          .string()
          .optional()
          .describe(
            'Your role or identity name. When set, messages appear from a dedicated bot.',
          ),
      }),
    },
  );

  const scheduleTaskTool = tool(
    async ({
      prompt,
      schedule_type,
      schedule_value,
      context_mode,
      target_group_jid,
    }: {
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode?: 'group' | 'isolated';
      target_group_jid?: string;
    }) => {
      const validationError = validateScheduleValue(
        schedule_type,
        schedule_value,
      );
      if (validationError) {
        throw new Error(validationError);
      }

      const targetJid =
        containerInput.isMain && target_group_jid
          ? target_group_jid
          : containerInput.chatJid;
      const taskId = `task-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

      emitStatus(
        `mcp__nanoclaw__schedule_task: ${schedule_type} ${schedule_value}`,
      );
      writeIpcFile(TASKS_DIR, {
        type: 'schedule_task',
        taskId,
        prompt,
        schedule_type,
        schedule_value,
        context_mode: context_mode || 'group',
        targetJid,
        createdBy: containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      });

      return `Task ${taskId} scheduled: ${schedule_type} - ${schedule_value}`;
    },
    {
      name: 'mcp__nanoclaw__schedule_task',
      description:
        'Schedule a recurring or one-time task. Returns the task ID for future reference.',
      schema: z.object({
        prompt: z
          .string()
          .describe('What the agent should do when the task runs'),
        schedule_type: z.enum(['cron', 'interval', 'once']),
        schedule_value: z.string(),
        context_mode: z.enum(['group', 'isolated']).default('group'),
        target_group_jid: z
          .string()
          .optional()
          .describe('(Main group only) override target group JID'),
      }),
    },
  );

  const listTasksTool = tool(
    async () => {
      const tasksFile = posixPath.join(IPC_DIR, 'current_tasks.json');
      emitStatus('mcp__nanoclaw__list_tasks');

      if (!fs.existsSync(tasksFile)) {
        return 'No scheduled tasks found.';
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as Array<
        Record<string, unknown>
      >;
      const tasks = containerInput.isMain
        ? allTasks
        : allTasks.filter(
            (task) => task.groupFolder === containerInput.groupFolder,
          );

      if (tasks.length === 0) {
        return 'No scheduled tasks found.';
      }

      return [
        'Scheduled tasks:',
        ...tasks.map((task) => {
          const id = String(task.id ?? '');
          const prompt = String(task.prompt ?? '').slice(0, 50);
          const scheduleType = String(task.schedule_type ?? '');
          const scheduleValue = String(task.schedule_value ?? '');
          const status = String(task.status ?? '');
          const nextRun = String(task.next_run ?? 'N/A');
          return `- [${id}] ${prompt}... (${scheduleType}: ${scheduleValue}) - ${status}, next: ${nextRun}`;
        }),
      ].join('\n');
    },
    {
      name: 'mcp__nanoclaw__list_tasks',
      description:
        "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
      schema: z.object({}),
    },
  );

  const pauseTaskTool = tool(
    async ({ task_id }: { task_id: string }) => {
      emitStatus(`mcp__nanoclaw__pause_task: ${task_id}`);
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId: task_id,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${task_id} pause requested.`;
    },
    {
      name: 'mcp__nanoclaw__pause_task',
      description: 'Pause a scheduled task.',
      schema: z.object({
        task_id: z.string().describe('The task ID to pause'),
      }),
    },
  );

  const resumeTaskTool = tool(
    async ({ task_id }: { task_id: string }) => {
      emitStatus(`mcp__nanoclaw__resume_task: ${task_id}`);
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId: task_id,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${task_id} resume requested.`;
    },
    {
      name: 'mcp__nanoclaw__resume_task',
      description: 'Resume a paused task.',
      schema: z.object({
        task_id: z.string().describe('The task ID to resume'),
      }),
    },
  );

  const cancelTaskTool = tool(
    async ({ task_id }: { task_id: string }) => {
      emitStatus(`mcp__nanoclaw__cancel_task: ${task_id}`);
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId: task_id,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${task_id} cancellation requested.`;
    },
    {
      name: 'mcp__nanoclaw__cancel_task',
      description: 'Cancel and delete a scheduled task.',
      schema: z.object({
        task_id: z.string().describe('The task ID to cancel'),
      }),
    },
  );

  const updateTaskTool = tool(
    async ({
      task_id,
      prompt,
      schedule_type,
      schedule_value,
    }: {
      task_id: string;
      prompt?: string;
      schedule_type?: 'cron' | 'interval' | 'once';
      schedule_value?: string;
    }) => {
      if (schedule_type && schedule_value) {
        const validationError = validateScheduleValue(
          schedule_type,
          schedule_value,
        );
        if (validationError) {
          throw new Error(validationError);
        }
      }

      emitStatus(`mcp__nanoclaw__update_task: ${task_id}`);
      const payload: Record<string, string | boolean> = {
        type: 'update_task',
        taskId: task_id,
        groupFolder: containerInput.groupFolder,
        isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      };
      if (prompt !== undefined) payload.prompt = prompt;
      if (schedule_type !== undefined) payload.schedule_type = schedule_type;
      if (schedule_value !== undefined) payload.schedule_value = schedule_value;

      writeIpcFile(TASKS_DIR, payload);
      return `Task ${task_id} update requested.`;
    },
    {
      name: 'mcp__nanoclaw__update_task',
      description:
        'Update an existing scheduled task. Only provided fields are changed.',
      schema: z.object({
        task_id: z.string(),
        prompt: z.string().optional(),
        schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
        schedule_value: z.string().optional(),
      }),
    },
  );

  const registerGroupTool = tool(
    async ({
      jid,
      name,
      folder,
      trigger,
    }: {
      jid: string;
      name: string;
      folder: string;
      trigger: string;
    }) => {
      if (!containerInput.isMain) {
        throw new Error('Only the main group can register new groups.');
      }

      emitStatus(`mcp__nanoclaw__register_group: ${name}`);
      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid,
        name,
        folder,
        trigger,
        timestamp: new Date().toISOString(),
      });
      return `Group "${name}" registered. It will start receiving messages immediately.`;
    },
    {
      name: 'mcp__nanoclaw__register_group',
      description:
        'Register a new chat or group so the agent can respond to messages there. Main group only.',
      schema: z.object({
        jid: z.string(),
        name: z.string(),
        folder: z.string(),
        trigger: z.string(),
      }),
    },
  );

  return [
    sendMessageTool,
    scheduleTaskTool,
    listTasksTool,
    pauseTaskTool,
    resumeTaskTool,
    cancelTaskTool,
    updateTaskTool,
    registerGroupTool,
  ];
}

async function buildAgent(
  containerInput: ContainerInput,
  emitStatus: (text: string, replace?: boolean) => void,
) {
  const skills = ensureWorkspaceSkills();
  const backend = await LocalShellBackend.create({
    rootDir: WORKSPACE_ROOT,
    virtualMode: false,
    inheritEnv: true,
    timeout: 600,
  });

  const checkpointer = await SqliteSaver.fromConnString(
    '/home/node/.claude/deepagents-checkpoints.sqlite',
  );

  const tools = createNanoClawTools(containerInput, emitStatus);
  const provider = process.env.MODEL_PROVIDER || 'anthropic';
  const model =
    provider === 'openai'
      ? new ChatOpenAI({
          model:
            process.env.OPENAI_MODEL ||
            process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
            'gpt-4.1',
          temperature: 0,
          maxRetries: 2,
        })
      : new ChatAnthropic({
          model:
            process.env.ANTHROPIC_MODEL ||
            process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
            'claude-sonnet-4-5',
          temperature: 0,
          maxRetries: 2,
        });

  const agent = (await createDeepAgent({
    model,
    backend,
    tools,
    skills,
    checkpointer,
  })) as unknown as {
    invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  };

  return { agent, checkpointer };
}

async function runQuery(
  agent: { invoke: (input: unknown, config?: unknown) => Promise<unknown> },
  checkpointer: any,
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  resumeAt?: string,
  pendingIpcMessages: string[] = [],
): Promise<QueryRunResult> {
  const nextSessionId = sessionId || crypto.randomUUID();
  let sawStatusEvent = false;

  const emitStatus = (text: string, replace = false) => {
    sawStatusEvent = true;
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: nextSessionId,
      lastAssistantUuid: resumeAt,
      event: {
        type: 'status',
        text,
        replace,
      },
    });
  };

  emitStatus('Starting Deep Agents query...', true);

  const { runtimePrompt, snapshot } = buildRuntimePromptBundle(
    prompt,
    containerInput,
    {
      sessionId: nextSessionId,
      resumeAt,
      pendingIpcMessages,
    },
  );
  writeRuntimeContextSnapshot(snapshot);
  const baseConfig: AnyRecord = {
    configurable: {
      thread_id: nextSessionId,
    },
    recursionLimit: QUERY_RECURSION_LIMIT,
  };

  let result: unknown;
  const queryStartedAt = Date.now();
  const heartbeat = setInterval(() => {
    emitStatus(
      `Still working inside the container. Elapsed ${formatElapsed(
        Date.now() - queryStartedAt,
      )}.`,
      true,
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    if (resumeAt) {
      (baseConfig.configurable as AnyRecord).checkpoint_id = resumeAt;
    }
    result = await agent.invoke(
      {
        messages: [{ role: 'user', content: runtimePrompt }],
      },
      baseConfig,
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (resumeAt && looksLikeMissingCheckpoint(errorMessage)) {
      emitStatus(
        'Stored checkpoint is invalid. Retrying from the latest thread state.',
        true,
      );
      delete (baseConfig.configurable as AnyRecord).checkpoint_id;
      result = await agent.invoke(
        {
          messages: [{ role: 'user', content: runtimePrompt }],
        },
        baseConfig,
      );
    } else {
      throw err;
    }
  } finally {
    clearInterval(heartbeat);
  }

  const finalText = extractFinalAssistantText(result);
  const checkpointId =
    (await getLatestCheckpointId(checkpointer, nextSessionId)) || resumeAt;

  if (finalText) {
    writeOutput({
      status: 'success',
      result: finalText,
      newSessionId: nextSessionId,
      lastAssistantUuid: checkpointId,
    });
  }

  return {
    newSessionId: nextSessionId,
    lastAssistantUuid: checkpointId,
    closedDuringQuery: false,
    lastAssistantText: finalText,
    lastResultText: finalText || null,
    lastResultSubtype: 'success',
    sawStatusEvent,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    process.exit(1);
    return;
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  ensureRuntimeWorkspace(containerInput);

  const statusWriter = (text: string, replace = false) => {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: containerInput.sessionId,
      lastAssistantUuid: containerInput.resumeAt,
      event: {
        type: 'status',
        text,
        replace,
      },
    });
  };

  const { agent, checkpointer } = await buildAgent(containerInput, statusWriter);

  let sessionId = containerInput.sessionId;
  let resumeAt = containerInput.resumeAt;
  let prompt = containerInput.prompt;
  let pendingForQuery = drainIpcInput();
  if (pendingForQuery.length > 0) {
    log(
      `Draining ${pendingForQuery.length} pending IPC messages into initial prompt`,
    );
    prompt += `\n${pendingForQuery.join('\n')}`;
  }

  let autoContinueCount = 0;

  try {
    while (true) {
      log(
        `Starting query (session: ${sessionId || 'new'}, resumeAt: ${
          resumeAt || 'latest'
        })...`,
      );

      const queryResult = await runQuery(
        agent,
        checkpointer,
        prompt,
        sessionId,
        containerInput,
        resumeAt,
        pendingForQuery,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      const autoContinueReason = getAutoContinueReason(
        queryResult,
        containerInput.isScheduledTask === true,
        autoContinueCount,
      );
      if (autoContinueReason) {
        autoContinueCount += 1;
        log(
          `Query appears unfinished, auto-continuing (#${autoContinueCount}): ${autoContinueReason}`,
        );
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId,
          lastAssistantUuid: resumeAt,
          event: {
            type: 'status',
            text: `Auto-continuing: ${autoContinueReason}`,
          },
        });
        prompt =
          'Continue automatically. Do not stop at planning, intent descriptions, or delegation envelopes. Execute the next concrete step now and keep going until the task is actually finished or you need external input that only the user can provide. If the task is already finished, return the final result now.';
        pendingForQuery = [];
        continue;
      }
      autoContinueCount = 0;

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: sessionId,
        lastAssistantUuid: resumeAt,
        queryCompleted: true,
      });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
      pendingForQuery = [];
      autoContinueCount = 0;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      lastAssistantUuid: resumeAt,
      error: errorMessage,
    });
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Fatal startup error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  });
}

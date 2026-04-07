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

import {
  StreamingOutput,
  getStreamingOutput,
  STREAM_MARKERS,
  LEGACY_MARKERS,
} from './streaming-output.js';

import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CompatibilityCallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
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
  enableStreaming?: boolean;
  nativeCompact?: NativeCompactRequest;
}

interface NativeCompactRequest {
  enabled?: boolean;
  sessionId?: string;
  metadata?: {
    compactMode?: 'rule' | 'native_llm' | 'fallback_rule';
    requestedNativeCompact?: boolean;
  };
}

interface NativeCompactOutcome {
  attempted: boolean;
  succeeded: boolean;
  fallbackToRuleCompact: boolean;
  reason?: string;
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
  nativeCompact?: NativeCompactOutcome;
}

interface QueryRunResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  lastAssistantText: string;
  lastResultText: string | null;
  lastResultSubtype?: string;
  sawStatusEvent: boolean;
  nativeCompact?: NativeCompactOutcome;
}

interface RuntimeAgent {
  invoke: (input: unknown, config?: unknown) => Promise<unknown>;
  stream?: (
    input: unknown,
    config?: unknown,
  ) => Promise<AsyncIterable<unknown>>;
}

interface NativeStreamBridgeEvent {
  type: 'tool_start' | 'tool_progress' | 'tool_complete' | 'decision' | 'content';
  key?: string;
  name?: string;
  input?: unknown;
  message?: string;
  percent?: number;
  result?: unknown;
  description?: string;
  choice?: string;
  text?: string;
}

type AnyRecord = Record<string, unknown>;
type MountMode = 'rw' | 'ro' | 'host-configured';
type ModelProvider = 'anthropic' | 'openai';

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

type HumanDecisionType = 'approve' | 'edit' | 'reject';

interface ResolvedWorkspaceMemoryFile {
  absolutePath: string;
  deepAgentsPath: string;
}

interface AutoContinueConfig {
  limit: number;
  allowScheduledTasks: boolean;
}

export interface ConfiguredMcpServer {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface LoadedMcpToolSet {
  tools: any[];
  cleanup: () => Promise<void>;
  servers: ConfiguredMcpServer[];
}

interface PredefinedSubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: any[];
  skills: string[];
  model: ReturnType<typeof createChatModel>;
}

interface NormalizedMcpToolResult {
  text: string;
  structured?: string;
  isError: boolean;
  summary: string;
}

interface HumanInterruptActionRequest {
  name: string;
  args?: unknown;
}

interface HumanInterruptReviewConfig {
  actionName: string;
  allowedDecisions?: HumanDecisionType[];
}

interface PendingInterruptState {
  createdAt: string;
  sessionId: string;
  checkpointId?: string;
  interrupt: unknown;
}

type InterruptOnConfig = Record<
  string,
  boolean | { allowedDecisions: HumanDecisionType[] }
>;

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
const NATIVE_STREAM_DEBUG_PATH = posixPath.join(
  RUNTIME_CONTEXT_DIR,
  'native-stream-debug.jsonl',
);
const PENDING_INTERRUPT_PATH = posixPath.join(
  RUNTIME_CONTEXT_DIR,
  'pending-interrupt.json',
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

const OUTPUT_START_MARKER = LEGACY_MARKERS.OUTPUT_START;
const OUTPUT_END_MARKER = LEGACY_MARKERS.OUTPUT_END;
const DEFAULT_ALLOWED_DECISIONS: HumanDecisionType[] = [
  'approve',
  'edit',
  'reject',
];

// Global streaming output instance
const streamingOutput = getStreamingOutput();

function writeOutput(output: ContainerOutput): void {
  // Always write legacy format for backward compatibility
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);

  // Streaming events should be emitted explicitly by the runtime as they happen.
  // Do not mirror legacy result/error payloads into streaming output here,
  // otherwise the host sees duplicate final content/errors.

  if (output.queryCompleted) {
    streamingOutput.complete();
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function shouldDebugNativeStreaming(): boolean {
  return process.env.NANOCLAW_DEBUG_NATIVE_STREAM !== 'false';
}

function describeValueShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      items: value.slice(0, 4).map((item) => describeValueShape(item)),
    };
  }

  if (!value || typeof value !== 'object') {
    return {
      kind: typeof value,
      value:
        typeof value === 'string' && value.length > 200
          ? `${value.slice(0, 200)}...`
          : value,
    };
  }

  const record = value as Record<string, unknown>;
  return {
    kind: 'object',
    keys: Object.keys(record).slice(0, 20),
    preview: Object.fromEntries(
      Object.entries(record)
        .slice(0, 8)
        .map(([key, entryValue]) => [key, describeValueShape(entryValue)]),
    ),
  };
}

function appendNativeStreamDebug(entry: Record<string, unknown>): void {
  if (!shouldDebugNativeStreaming()) return;

  try {
    fs.mkdirSync(RUNTIME_CONTEXT_DIR, { recursive: true });
    fs.appendFileSync(
      NATIVE_STREAM_DEBUG_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      })}\n`,
    );
  } catch (err) {
    log(
      `Failed to write native stream debug log: ${formatErrorMessage(err)}`,
    );
  }
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

function parseBooleanFlag(value: string | undefined, defaultValue = false): boolean {
  if (!value) return defaultValue;
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeParseMaybeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;

  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (
    (!trimmed.startsWith('{') || !trimmed.endsWith('}')) &&
    (!trimmed.startsWith('[') || !trimmed.endsWith(']'))
  ) {
    return raw;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function truncateForHumanPrompt(value: unknown, maxLength = 1200): string {
  const text =
    typeof value === 'string' ? value.trim() : safeJsonStringify(value).trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

export function getAutoContinueConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutoContinueConfig {
  return {
    limit: Math.max(
      0,
      Number.parseInt(env.NANOCLAW_AUTO_CONTINUE_LIMIT || '6', 10) || 6,
    ),
    allowScheduledTasks: parseBooleanFlag(
      env.NANOCLAW_AUTO_CONTINUE_SCHEDULED,
      false,
    ),
  };
}

export function parseConfiguredMcpServers(
  raw = process.env.NANOCLAW_MCP_SERVERS_JSON,
): ConfiguredMcpServer[] {
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('MCP server config must be a JSON array.');
    }

    return parsed.flatMap((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        log(`Ignoring MCP server config at index ${index}: expected object.`);
        return [];
      }

      const record = entry as AnyRecord;
      if (
        typeof record.name !== 'string' ||
        !record.name.trim() ||
        typeof record.command !== 'string' ||
        !record.command.trim()
      ) {
        log(
          `Ignoring MCP server config at index ${index}: both name and command are required.`,
        );
        return [];
      }

      const env =
        record.env && typeof record.env === 'object'
          ? Object.fromEntries(
              Object.entries(record.env as Record<string, unknown>).flatMap(
                ([key, value]) =>
                  typeof value === 'string' ? [[key, value]] : [],
              ),
            )
          : undefined;

      return [
        {
          name: record.name.trim(),
          command: record.command.trim(),
          args: Array.isArray(record.args)
            ? record.args.filter(
                (value): value is string => typeof value === 'string',
              )
            : undefined,
          cwd:
            typeof record.cwd === 'string' && record.cwd.trim()
              ? record.cwd
              : undefined,
          env,
        },
      ];
    });
  } catch (err) {
    log(
      `Failed to parse NANOCLAW_MCP_SERVERS_JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

let langGraphHumanInLoopPromise: Promise<{
  Command?: new (args: { resume: unknown }) => unknown;
  interrupt?: (value: unknown) => unknown;
}> | null = null;

async function loadLangGraphHumanInLoopHelpers(): Promise<{
  Command?: new (args: { resume: unknown }) => unknown;
  interrupt?: (value: unknown) => unknown;
}> {
  if (!langGraphHumanInLoopPromise) {
    langGraphHumanInLoopPromise = import('@langchain/langgraph')
      .then((mod) => {
        const record = mod as Record<string, unknown>;
        return {
          Command:
            typeof record.Command === 'function'
              ? (record.Command as new (args: { resume: unknown }) => unknown)
              : undefined,
          interrupt:
            typeof record.interrupt === 'function'
              ? (record.interrupt as (value: unknown) => unknown)
              : undefined,
        };
      })
      .catch((err) => {
        log(
          `Failed to load @langchain/langgraph human-in-the-loop helpers: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return {};
      });
  }

  return langGraphHumanInLoopPromise;
}

async function createResumeCommandInput(resume: unknown): Promise<unknown> {
  const helpers = await loadLangGraphHumanInLoopHelpers();
  if (helpers.Command) {
    return new helpers.Command({ resume });
  }
  return { resume };
}

async function requestHumanInterrupt(payload: unknown): Promise<unknown> {
  const helpers = await loadLangGraphHumanInLoopHelpers();
  if (!helpers.interrupt) {
    throw new Error(
      'DeepAgents human-in-the-loop interrupt() is unavailable in this runtime.',
    );
  }
  return helpers.interrupt(payload);
}

function isHumanDecisionType(value: unknown): value is HumanDecisionType {
  return value === 'approve' || value === 'edit' || value === 'reject';
}

function extractActionRequests(
  interrupt: unknown,
): HumanInterruptActionRequest[] {
  if (!isRecord(interrupt) || !Array.isArray(interrupt.actionRequests)) {
    return [];
  }

  return interrupt.actionRequests.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = getStringField(entry, 'name', 'actionName', 'tool');
    if (!name) return [];
    return [
      {
        name,
        args: entry.args ?? entry.arguments ?? entry.input,
      },
    ];
  });
}

function extractReviewConfigMap(
  interrupt: unknown,
): Map<string, HumanDecisionType[]> {
  if (!isRecord(interrupt) || !Array.isArray(interrupt.reviewConfigs)) {
    return new Map();
  }

  const configMap = new Map<string, HumanDecisionType[]>();
  for (const entry of interrupt.reviewConfigs) {
    if (!isRecord(entry)) continue;
    const actionName = getStringField(entry, 'actionName', 'name', 'tool');
    if (!actionName) continue;

    const allowedDecisions = Array.isArray(entry.allowedDecisions)
      ? entry.allowedDecisions.filter(isHumanDecisionType)
      : DEFAULT_ALLOWED_DECISIONS;
    configMap.set(actionName, allowedDecisions);
  }

  return configMap;
}

function writePendingInterruptState(state: PendingInterruptState): void {
  fs.mkdirSync(RUNTIME_CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(
    PENDING_INTERRUPT_PATH,
    JSON.stringify(state, null, 2) + '\n',
  );
}

function readPendingInterruptState(): PendingInterruptState | null {
  try {
    if (!fs.existsSync(PENDING_INTERRUPT_PATH)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(PENDING_INTERRUPT_PATH, 'utf8'),
    ) as unknown;
    if (!isRecord(parsed) || typeof parsed.sessionId !== 'string') {
      return null;
    }
    return {
      createdAt:
        typeof parsed.createdAt === 'string'
          ? parsed.createdAt
          : new Date().toISOString(),
      sessionId: parsed.sessionId,
      checkpointId:
        typeof parsed.checkpointId === 'string'
          ? parsed.checkpointId
          : undefined,
      interrupt: parsed.interrupt,
    };
  } catch (err) {
    log(
      `Failed to read pending interrupt state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function clearPendingInterruptState(): void {
  try {
    fs.unlinkSync(PENDING_INTERRUPT_PATH);
  } catch {
    // ignore
  }
}

export function parseInterruptOnConfig(
  raw = process.env.NANOCLAW_INTERRUPT_ON_JSON,
): InterruptOnConfig | undefined {
  if (!raw?.trim()) return undefined;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('interruptOn config must be a JSON object.');
    }

    const config: InterruptOnConfig = {};
    for (const [toolName, entry] of Object.entries(parsed)) {
      if (typeof entry === 'boolean') {
        config[toolName] = entry;
        continue;
      }
      if (!isRecord(entry)) {
        continue;
      }
      config[toolName] = {
        allowedDecisions:
          Array.isArray(entry.allowedDecisions) &&
          entry.allowedDecisions.some(isHumanDecisionType)
            ? entry.allowedDecisions.filter(isHumanDecisionType)
            : [...DEFAULT_ALLOWED_DECISIONS],
      };
    }

    return Object.keys(config).length > 0 ? config : undefined;
  } catch (err) {
    log(
      `Failed to parse NANOCLAW_INTERRUPT_ON_JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
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

export function getDeepAgentName(containerInput: ContainerInput): string {
  const requestedName = containerInput.assistantName?.trim();
  if (requestedName) {
    return requestedName;
  }

  return containerInput.isMain ? 'nanoharness-main' : 'nanoharness-agent';
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

function extractTextFromRecordFields(record: AnyRecord): string {
  const candidates = [
    record.text,
    record.output_text,
    record.completion,
    record.response,
    record.delta,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(record.content)) {
    const textParts = record.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        const contentRecord = item as AnyRecord;
        return [
          contentRecord.text,
          contentRecord.output_text,
          contentRecord.delta,
        ].find((value): value is string => typeof value === 'string') || '';
      })
      .filter((value) => value.trim());

    if (textParts.length > 0) {
      return textParts.join('').trim();
    }
  }

  return '';
}

export function extractStreamChunkText(chunk: unknown): string {
  const finalAssistantText = extractFinalAssistantText(chunk);
  if (finalAssistantText) return finalAssistantText;

  if (typeof chunk === 'string') return chunk.trim();
  if (!chunk || typeof chunk !== 'object') return '';

  return extractTextFromRecordFields(chunk as AnyRecord);
}

export function shouldUseNativeStreaming(agent: RuntimeAgent): boolean {
  return (
    process.env.NANOCLAW_USE_NATIVE_STREAMING === 'true' &&
    typeof agent.stream === 'function'
  );
}

function shouldEmitNativeStreamContent(): boolean {
  return process.env.NANOCLAW_STREAM_CONTENT_FROM_NATIVE === 'true';
}

function shouldFallbackFromNativeStreaming(error: unknown): boolean {
  if (process.env.NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK === 'true') {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return true;

  // Do not retry via invoke() when the upstream model/provider itself failed.
  // A second immediate request often repeats the same rate limit / provider error
  // and can surface less useful secondary exceptions.
  if (
    /(429|rate limit|rate increased too quickly|provider returned error|upstream error|unauthorized|forbidden|quota|billing|overloaded|timeout)/i.test(
      message,
    )
  ) {
    return false;
  }

  return true;
}

interface NormalizedNativeStreamChunk {
  namespace: string[];
  mode: string;
  data: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getStringField(
  record: AnyRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function getNumberField(
  record: AnyRecord,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getNamespaceToolSegment(namespace: string[]): string | undefined {
  return namespace.find((segment) => segment.startsWith('tools:'));
}

function inferNativeStreamMode(data: unknown): string {
  if (Array.isArray(data)) {
    const first = data[0];
    if (isRecord(first)) {
      if (
        Array.isArray(first.tool_call_chunks) ||
        typeof first.text === 'string' ||
        typeof first.type === 'string' ||
        Array.isArray(first.content)
      ) {
        return 'messages';
      }
    }
  }

  if (isRecord(data)) {
    if (
      getStringField(data, 'status', 'message', 'text', 'step') ||
      getNumberField(data, 'progress', 'percent') !== undefined
    ) {
      return 'custom';
    }
    return 'updates';
  }

  return 'unknown';
}

export function normalizeNativeStreamChunk(
  part: unknown,
): NormalizedNativeStreamChunk {
  if (Array.isArray(part)) {
    if (
      part.length >= 3 &&
      Array.isArray(part[0]) &&
      typeof part[1] === 'string'
    ) {
      return {
        namespace: part[0].filter(
          (segment): segment is string => typeof segment === 'string',
        ),
        mode: part[1],
        data: part[2],
      };
    }

    if (part.length >= 2 && Array.isArray(part[0])) {
      const namespace = part[0].filter(
        (segment): segment is string => typeof segment === 'string',
      );
      const data = part[1];
      const metadata = Array.isArray(data) ? data[1] : undefined;
      return {
        namespace,
        mode: inferNativeStreamMode(data),
        data,
        metadata,
      };
    }

    if (part.length >= 2 && typeof part[0] === 'string') {
      return {
        namespace: [],
        mode: part[0],
        data: part[1],
      };
    }
  }

  return {
    namespace: [],
    mode: inferNativeStreamMode(part),
    data: part,
  };
}

function buildNativeToolEventKey(
  namespace: string[],
  payload: AnyRecord,
  fallbackLabel: string,
): string {
  const toolSegment = getNamespaceToolSegment(namespace) || 'main';
  const explicitId = getStringField(
    payload,
    'tool_call_id',
    'toolCallId',
    'id',
    'call_id',
    'callId',
  );
  const explicitIndex =
    getNumberField(payload, 'index', 'chunk_index', 'chunkIndex') ?? 0;
  const toolName =
    getStringField(payload, 'name', 'tool', 'tool_name', 'toolName') ||
    fallbackLabel ||
    'tool';

  return explicitId
    ? `${toolSegment}:${explicitId}`
    : `${toolSegment}:${toolName}:${explicitIndex}`;
}

function extractToolCompletionResult(message: AnyRecord): unknown {
  if (message.content !== undefined) return message.content;
  if (message.text !== undefined) return message.text;
  return message;
}

function mapUpdatesChunkToBridgeEvents(
  namespace: string[],
  data: unknown,
): NativeStreamBridgeEvent[] {
  if (!isRecord(data)) return [];

  const events: NativeStreamBridgeEvent[] = [];
  const sourceLabel = getNamespaceToolSegment(namespace) || 'main';

  for (const [nodeName, nodeData] of Object.entries(data)) {
    events.push({
      type: 'decision',
      description:
        namespace.length === 0
          ? 'Native stream update'
          : `Native subagent update (${sourceLabel})`,
      choice: nodeName,
    });

    const nodeMessages = extractMessages(nodeData);
    for (const message of nodeMessages) {
      if (!isRecord(message)) continue;

      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      for (const toolCall of toolCalls) {
        if (!isRecord(toolCall)) continue;
        const name =
          getStringField(toolCall, 'name', 'tool', 'tool_name') || 'tool';
        events.push({
          type: 'tool_start',
          key: buildNativeToolEventKey(namespace, toolCall, name),
          name,
          input:
            toolCall.args ??
            toolCall.arguments ??
            toolCall.input ??
            toolCall.payload,
          message: `Node ${nodeName} requested ${name}`,
        });
      }

      const messageType = getStringField(message, 'type');
      if (messageType === 'tool' || getStringField(message, 'tool_call_id')) {
        const name =
          getStringField(message, 'name', 'tool', 'tool_name') || 'tool';
        events.push({
          type: 'tool_complete',
          key: buildNativeToolEventKey(namespace, message, name),
          name,
          result: extractToolCompletionResult(message),
        });
      }
    }
  }

  return events;
}

function mapMessagesChunkToBridgeEvents(
  namespace: string[],
  data: unknown,
): NativeStreamBridgeEvent[] {
  if (!Array.isArray(data) || data.length === 0) return [];

  const [message, metadata] = data;
  const events: NativeStreamBridgeEvent[] = [];

  if (isRecord(metadata)) {
    const nodeName = getStringField(
      metadata,
      'langgraph_node',
      'node',
      'nodeName',
    );
    if (nodeName) {
      events.push({
        type: 'decision',
        description:
          namespace.length === 0
            ? 'Native message stream'
            : `Native subagent message (${getNamespaceToolSegment(namespace) || 'main'})`,
        choice: nodeName,
      });
    }
  }

  if (!isRecord(message)) return events;

  const toolCallChunks = Array.isArray(message.tool_call_chunks)
    ? message.tool_call_chunks
    : [];
  for (const toolCallChunk of toolCallChunks) {
    if (!isRecord(toolCallChunk)) continue;
    const name =
      getStringField(toolCallChunk, 'name', 'tool', 'tool_name') || 'tool';
    const key = buildNativeToolEventKey(namespace, toolCallChunk, name);
    const args = safeParseMaybeJson(
      toolCallChunk.args ??
        toolCallChunk.arguments ??
        toolCallChunk.input ??
        toolCallChunk.payload,
    );

    events.push({
      type: 'tool_start',
      key,
      name,
      input: args,
      message: `Streaming tool call for ${name}`,
    });

    const rawArgs =
      getStringField(toolCallChunk, 'args', 'arguments') ||
      (args !== undefined && typeof args !== 'string'
        ? JSON.stringify(args)
        : undefined);
    if (rawArgs) {
      events.push({
        type: 'tool_progress',
        key,
        name,
        message: rawArgs,
      });
    }
  }

  const messageType = getStringField(message, 'type');
  if (messageType === 'tool' || getStringField(message, 'tool_call_id')) {
    const name =
      getStringField(message, 'name', 'tool', 'tool_name') || 'tool';
    events.push({
      type: 'tool_complete',
      key: buildNativeToolEventKey(namespace, message, name),
      name,
      result: extractToolCompletionResult(message),
    });
    return events;
  }

  const text = extractStreamChunkText(message);
  if (text && toolCallChunks.length === 0) {
    events.push({
      type: 'content',
      text,
    });
  }

  return events;
}

function mapCustomChunkToBridgeEvents(
  namespace: string[],
  data: unknown,
): NativeStreamBridgeEvent[] {
  if (!isRecord(data)) return [];

  const key = `${getNamespaceToolSegment(namespace) || 'main'}:custom`;
  const message =
    getStringField(data, 'status', 'message', 'text', 'step') ||
    'Custom progress update';
  const percent = getNumberField(data, 'progress', 'percent');

  return [
    {
      type: 'tool_progress',
      key,
      name: getNamespaceToolSegment(namespace) || 'custom',
      message,
      percent,
      result: data,
    },
  ];
}

export function mapNativeStreamChunkToBridgeEvents(
  part: unknown,
): NativeStreamBridgeEvent[] {
  const normalized = normalizeNativeStreamChunk(part);

  switch (normalized.mode) {
    case 'updates':
      return mapUpdatesChunkToBridgeEvents(
        normalized.namespace,
        normalized.data,
      );
    case 'messages':
      return mapMessagesChunkToBridgeEvents(
        normalized.namespace,
        normalized.data,
      );
    case 'custom':
      return mapCustomChunkToBridgeEvents(normalized.namespace, normalized.data);
    default: {
      const text = extractStreamChunkText(normalized.data);
      return text
        ? [
            {
              type: 'content',
              text,
            },
          ]
        : [];
    }
  }
}

async function consumeNativeAgentStream(
  agent: RuntimeAgent,
  invocationInput: unknown,
  baseConfig: AnyRecord,
): Promise<unknown> {
  appendNativeStreamDebug({
    type: 'stream_start',
    config: {
      threadId: (baseConfig.configurable as AnyRecord | undefined)?.thread_id,
      checkpointId: (baseConfig.configurable as AnyRecord | undefined)
        ?.checkpoint_id,
      streamMode: ['updates', 'messages', 'custom'],
      subgraphs: true,
    },
    invocationInputShape: describeValueShape(invocationInput),
  });

  let stream: AsyncIterable<unknown>;
  try {
    stream = await agent.stream!(
      invocationInput,
      {
        ...baseConfig,
        streamMode: ['updates', 'messages', 'custom'],
        subgraphs: true,
      },
    );
  } catch (err) {
    appendNativeStreamDebug({
      type: 'stream_open_error',
      error: formatErrorMessage(err),
      stack: formatErrorStack(err),
    });
    throw err;
  }

  let lastChunk: unknown = null;
  let interruptChunk: unknown = null;
  let lastEmittedText = '';
  let bufferedMainAssistantText = '';
  const decisionCache = new Set<string>();
  const activeToolIds = new Map<string, string>();
  let chunkCount = 0;

  streamingOutput.decision('Native stream bridge', 'agent.stream enabled');

  for await (const chunk of stream) {
    chunkCount += 1;
    lastChunk = chunk;

    appendNativeStreamDebug({
      type: 'chunk',
      chunkIndex: chunkCount,
      rawShape: describeValueShape(chunk),
      raw: chunk,
    });

    try {
      const directInterrupt = extractInterruptPayload(chunk);
      if (directInterrupt) {
        interruptChunk = {
          __interrupt__: [{ value: directInterrupt }],
        };
      }

      const normalizedChunk = normalizeNativeStreamChunk(chunk);
      appendNativeStreamDebug({
        type: 'normalized_chunk',
        chunkIndex: chunkCount,
        normalized: {
          namespace: normalizedChunk.namespace,
          mode: normalizedChunk.mode,
          dataShape: describeValueShape(normalizedChunk.data),
          metadataShape: describeValueShape(normalizedChunk.metadata),
        },
      });

      const normalizedInterrupt = extractInterruptPayload(normalizedChunk.data);
      if (normalizedInterrupt) {
        interruptChunk = {
          __interrupt__: [{ value: normalizedInterrupt }],
        };
      }
      if (
        normalizedChunk.mode === 'messages' &&
        normalizedChunk.namespace.length === 0 &&
        Array.isArray(normalizedChunk.data)
      ) {
        const [message] = normalizedChunk.data;
        if (isRecord(message)) {
          const hasToolCallChunks =
            Array.isArray(message.tool_call_chunks) &&
            message.tool_call_chunks.length > 0;
          const text = extractStreamChunkText(message);
          if (text && !hasToolCallChunks) {
            bufferedMainAssistantText += text;
          }
        }
      }

      const bridgeEvents = mapNativeStreamChunkToBridgeEvents(chunk);
      appendNativeStreamDebug({
        type: 'bridge_events',
        chunkIndex: chunkCount,
        events: bridgeEvents,
      });

      for (const event of bridgeEvents) {
        if (event.type === 'tool_start') {
          const key = event.key || event.name || 'tool';
          if (!activeToolIds.has(key)) {
            const toolId = streamingOutput.toolStart(
              event.name || 'tool',
              event.input ?? {},
            );
            activeToolIds.set(key, toolId);
          }
          if (event.message) {
            const toolId = activeToolIds.get(key);
            if (toolId) {
              streamingOutput.toolProgress(toolId, event.message, event.percent);
            }
          }
          continue;
        }

        if (event.type === 'tool_progress') {
          const key = event.key || event.name || 'tool';
          if (!activeToolIds.has(key)) {
            const toolId = streamingOutput.toolStart(
              event.name || 'tool',
              event.input ?? {},
            );
            activeToolIds.set(key, toolId);
          }
          const toolId = activeToolIds.get(key);
          if (toolId) {
            streamingOutput.toolProgress(
              toolId,
              event.message || 'In progress',
              event.percent,
            );
          }
          continue;
        }

        if (event.type === 'tool_complete') {
          const key = event.key || event.name || 'tool';
          if (!activeToolIds.has(key)) {
            const toolId = streamingOutput.toolStart(
              event.name || 'tool',
              {},
            );
            activeToolIds.set(key, toolId);
          }
          const toolId = activeToolIds.get(key);
          if (toolId) {
            streamingOutput.toolComplete(toolId, event.result ?? {});
            activeToolIds.delete(key);
          }
          continue;
        }

        if (event.type === 'decision') {
          const description = event.description || 'Native stream event';
          const choice = event.choice || 'update';
          const decisionKey = `${description}::${choice}`;
          if (!decisionCache.has(decisionKey)) {
            decisionCache.add(decisionKey);
            streamingOutput.decision(description, choice);
          }
          continue;
        }

        if (
          event.type === 'content' &&
          shouldEmitNativeStreamContent() &&
          event.text &&
          event.text !== lastEmittedText
        ) {
          streamingOutput.content(event.text);
          lastEmittedText = event.text;
        }
      }
    } catch (err) {
      appendNativeStreamDebug({
        type: 'chunk_processing_error',
        chunkIndex: chunkCount,
        error: formatErrorMessage(err),
        stack: formatErrorStack(err),
        rawShape: describeValueShape(chunk),
        raw: chunk,
      });
      throw err;
    }
  }

  appendNativeStreamDebug({
    type: 'stream_complete',
    chunkCount,
    emittedTextLength: bufferedMainAssistantText.length,
    lastChunkShape: describeValueShape(lastChunk),
  });

  if (interruptChunk) {
    return interruptChunk;
  }

  if (bufferedMainAssistantText.trim()) {
    return {
      messages: [
        {
          role: 'assistant',
          content: bufferedMainAssistantText,
        },
      ],
    };
  }

  return lastChunk ?? lastEmittedText;
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

export function getAutoContinueReason(
  queryResult: QueryRunResult,
  isScheduledTask: boolean,
  autoContinueCount: number,
  config: AutoContinueConfig = getAutoContinueConfig(),
): string | null {
  if (isScheduledTask && !config.allowScheduledTasks) return null;
  if (queryResult.closedDuringQuery) return null;
  if (
    queryResult.lastResultSubtype &&
    queryResult.lastResultSubtype !== 'success'
  ) {
    return null;
  }
  if (autoContinueCount >= config.limit) return null;

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

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getModelProvider(): ModelProvider {
  return process.env.MODEL_PROVIDER === 'openai' ? 'openai' : 'anthropic';
}

function getPrimaryModelName(provider: ModelProvider): string {
  if (provider === 'openai') {
    return (
      process.env.OPENAI_MODEL ||
      process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
      'gpt-4.1'
    );
  }

  return (
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
    'claude-sonnet-4-5'
  );
}

function getSummarizationModelName(
  provider: ModelProvider,
  primaryModelName: string,
): string {
  return (
    process.env.NANOCLAW_SUMMARIZATION_MODEL ||
    process.env.DEEPAGENTS_SUMMARIZATION_MODEL ||
    primaryModelName
  );
}

function createChatModel(provider: ModelProvider, modelName: string) {
  if (provider === 'openai') {
    return new ChatOpenAI({
      model: modelName,
      temperature: 0,
      maxRetries: 2,
    });
  }

  return new ChatAnthropic({
    model: modelName,
    temperature: 0,
    maxRetries: 2,
  });
}

async function loadDeepAgentsMiddleware(
  provider: ModelProvider,
  primaryModelName: string,
): Promise<any[]> {
  if (process.env.NANOCLAW_ENABLE_SUMMARIZATION === 'false') {
    return [];
  }

  // DeepAgents already includes built-in summarization/offloading in its harness.
  // Only inject LangChain's explicit SummarizationMiddleware when operators force
  // it for compatibility experiments, otherwise duplicate middleware registration
  // can crash startup.
  if (process.env.NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE !== 'true') {
    return [];
  }

  try {
    const langchainModule = (await import('langchain')) as AnyRecord;
    const summarizationOptions = {
      model: createChatModel(
        provider,
        getSummarizationModelName(provider, primaryModelName),
      ),
      trigger: [
        {
          tokens: parsePositiveIntEnv(
            'NANOCLAW_SUMMARIZATION_TRIGGER_TOKENS',
            24000,
          ),
        },
        {
          messages: parsePositiveIntEnv(
            'NANOCLAW_SUMMARIZATION_TRIGGER_MESSAGES',
            40,
          ),
        },
      ],
      keep: {
        messages: parsePositiveIntEnv(
          'NANOCLAW_SUMMARIZATION_KEEP_MESSAGES',
          12,
        ),
      },
      trimTokensToSummarize: parsePositiveIntEnv(
        'NANOCLAW_SUMMARIZATION_TRIM_TOKENS',
        12000,
      ),
    };

    const summarizationMiddlewareFactory =
      langchainModule.summarizationMiddleware;
    if (typeof summarizationMiddlewareFactory === 'function') {
      return [summarizationMiddlewareFactory(summarizationOptions)];
    }

    const SummarizationMiddleware = langchainModule.SummarizationMiddleware;
    if (typeof SummarizationMiddleware === 'function') {
      return [new (SummarizationMiddleware as new (options: unknown) => unknown)(
        summarizationOptions,
      )];
    }

    log(
      'LangChain summarization middleware export not found. Continuing with DeepAgents built-in summarization only.',
    );
    return [];
  } catch (err) {
    log(
      `Failed to load optional LangChain summarization middleware: ${
        err instanceof Error ? err.message : String(err)
      }. Continuing with DeepAgents built-in summarization only.`,
    );
    return [];
  }
}

function getSubagentModelName(
  role: 'researcher' | 'coder' | 'reviewer',
  primaryModelName: string,
): string {
  const overrideByRole = {
    researcher:
      process.env.NANOCLAW_SUBAGENT_RESEARCH_MODEL ||
      process.env.NANOCLAW_RESEARCHER_MODEL,
    coder:
      process.env.NANOCLAW_SUBAGENT_CODER_MODEL ||
      process.env.NANOCLAW_CODER_MODEL,
    reviewer:
      process.env.NANOCLAW_SUBAGENT_REVIEWER_MODEL ||
      process.env.NANOCLAW_REVIEWER_MODEL,
  } as const;

  return overrideByRole[role] || primaryModelName;
}

function shouldEnablePredefinedSubagents(): boolean {
  return process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS !== 'false';
}

function shouldUseNativeMemory(): boolean {
  return process.env.NANOCLAW_USE_NATIVE_MEMORY === 'true';
}

function parseEnvPathList(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  return value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getPredefinedSubagentSkills(
  role: 'researcher' | 'coder' | 'reviewer',
  mainSkills: string[],
): string[] {
  const shareMainSkills =
    process.env.NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS === 'true';
  const roleEnvName = {
    researcher: 'NANOCLAW_SUBAGENT_RESEARCHER_SKILLS',
    coder: 'NANOCLAW_SUBAGENT_CODER_SKILLS',
    reviewer: 'NANOCLAW_SUBAGENT_REVIEWER_SKILLS',
  }[role];
  const roleSpecificSkills = parseEnvPathList(process.env[roleEnvName]);

  const resolved = [
    ...(shareMainSkills ? mainSkills : []),
    ...roleSpecificSkills,
  ];

  return [...new Set(resolved)];
}

export function buildDelegationPolicyLines(): string[] {
  if (!shouldEnablePredefinedSubagents()) {
    return [
      'Use task delegation only when extra context isolation is clearly helpful.',
      'Prefer solving straightforward work in the main agent before delegating.',
    ];
  }

  return [
    'Available predefined subagents: researcher for investigation, coder for implementation, reviewer for findings-first review.',
    'Use task delegation when specialized work or context isolation is helpful, but avoid unnecessary recursive delegation.',
    'Delegate to researcher for codebase investigation or option comparison, coder for concrete implementation, and reviewer for regression-focused critique.',
    'When delegating, prefer the exact task names researcher, coder, or reviewer before falling back to general-purpose delegation.',
    'Prefer one focused subagent at a time unless the task clearly benefits from separation of concerns.',
    'If the task is already small and clear in the current context, do it directly instead of delegating.',
    'Do not re-delegate the same question repeatedly without incorporating the previous subagent result.',
  ];
}

function filterSubagentTools(
  tools: any[],
  role: 'researcher' | 'coder' | 'reviewer',
): any[] {
  const readonlyMutationPattern =
    /(write|edit|create|delete|schedule|send|update|cancel|pause|resume|register)/i;

  return tools.filter((tool) => {
    const name =
      tool && typeof tool === 'object' && 'name' in tool
        ? String((tool as { name?: unknown }).name || '')
        : '';
    if (name === '') {
      return false;
    }
    if (name === 'mcp__nanoclaw__ask_user') {
      return true;
    }
    if (name.startsWith('mcp__nanoclaw__')) {
      return false;
    }
    if (role === 'coder') {
      return true;
    }
    return !readonlyMutationPattern.test(name);
  });
}

export function buildPredefinedSubagents(options: {
  provider: ModelProvider;
  primaryModelName: string;
  skills: string[];
  tools: any[];
}): PredefinedSubagentConfig[] {
  if (!shouldEnablePredefinedSubagents()) {
    return [];
  }

  return [
    {
      name: 'researcher',
      description:
        'Investigates code, traces behavior, compares options, and returns concise findings before implementation.',
      systemPrompt: [
        'You are the researcher subagent inside NanoHarness.',
        'Focus on understanding the codebase, tracing behavior, comparing approaches, and collecting evidence.',
        'Prefer reading, searching, and targeted command output over editing files.',
        'Use the exact task identity researcher when delegated by the parent agent.',
        'Return concise findings, risks, and the most relevant next step for the parent agent.',
      ].join(' '),
      tools: filterSubagentTools(options.tools, 'researcher'),
      skills: getPredefinedSubagentSkills('researcher', options.skills),
      model: createChatModel(
        options.provider,
        getSubagentModelName('researcher', options.primaryModelName),
      ),
    },
    {
      name: 'coder',
      description:
        'Implements concrete code changes, keeps edits focused, and runs targeted verification when useful.',
      systemPrompt: [
        'You are the coder subagent inside NanoHarness.',
        'Focus on making the smallest correct code changes that solve the assigned task.',
        'Use files and shell tools pragmatically, keep scope tight, and run targeted verification when it materially reduces risk.',
        'Use the exact task identity coder when delegated by the parent agent.',
        'Return changed files, checks run, and any remaining risks to the parent agent.',
      ].join(' '),
      tools: filterSubagentTools(options.tools, 'coder'),
      skills: getPredefinedSubagentSkills('coder', options.skills),
      model: createChatModel(
        options.provider,
        getSubagentModelName('coder', options.primaryModelName),
      ),
    },
    {
      name: 'reviewer',
      description:
        'Reviews behavior, identifies regressions and missing tests, and returns findings-first feedback without implementation churn.',
      systemPrompt: [
        'You are the reviewer subagent inside NanoHarness.',
        'Inspect proposed or completed changes for bugs, regressions, unsafe assumptions, and missing tests.',
        'Do not make broad implementation changes unless the parent agent explicitly asks for them.',
        'Use the exact task identity reviewer when delegated by the parent agent.',
        'Return findings first, ordered by severity, then note residual risks or test gaps.',
      ].join(' '),
      tools: filterSubagentTools(options.tools, 'reviewer'),
      skills: getPredefinedSubagentSkills('reviewer', options.skills),
      model: createChatModel(
        options.provider,
        getSubagentModelName('reviewer', options.primaryModelName),
      ),
    },
  ];
}

export function validateScheduleValue(
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

export function buildDeepAgentsMemoryPaths(
  containerInput: Pick<ContainerInput, 'isMain'>,
): string[] {
  return resolveWorkspaceMemoryFiles(containerInput).map(
    (entry) => entry.deepAgentsPath,
  );
}

function resolveWorkspaceMemoryFiles(
  containerInput: Pick<ContainerInput, 'isMain'>,
): ResolvedWorkspaceMemoryFile[] {
  const candidates: Array<{
    absolutePath: string;
    deepAgentsPath: string;
  }> = [
    {
      absolutePath: posixPath.join(GROUP_ROOT, 'AGENTS.md'),
      deepAgentsPath: './group/AGENTS.md',
    },
    {
      absolutePath: posixPath.join(GROUP_ROOT, 'CLAUDE.md'),
      deepAgentsPath: './group/CLAUDE.md',
    },
    {
      absolutePath: posixPath.join(GLOBAL_ROOT, 'AGENTS.md'),
      deepAgentsPath: './global/AGENTS.md',
    },
    {
      absolutePath: posixPath.join(GLOBAL_ROOT, 'CLAUDE.md'),
      deepAgentsPath: './global/CLAUDE.md',
    },
  ];

  if (containerInput.isMain) {
    candidates.push(
      {
        absolutePath: '/workspace/project/AGENTS.md',
        deepAgentsPath: './project/AGENTS.md',
      },
      {
        absolutePath: '/workspace/project/CLAUDE.md',
        deepAgentsPath: './project/CLAUDE.md',
      },
    );
  }

  const resolvedByScope = new Map<string, ResolvedWorkspaceMemoryFile>();
  for (const candidate of candidates) {
    const scope = candidate.deepAgentsPath.split('/')[1];
    if (resolvedByScope.has(scope)) continue;
    if (!fs.existsSync(candidate.absolutePath)) continue;
    resolvedByScope.set(scope, candidate);
  }

  return Array.from(resolvedByScope.values());
}

function getResolvedWorkspaceMemoryFile(
  containerInput: Pick<ContainerInput, 'isMain'>,
  scope: 'group' | 'global' | 'project',
): ResolvedWorkspaceMemoryFile | null {
  return (
    resolveWorkspaceMemoryFiles(containerInput).find((entry) =>
      entry.deepAgentsPath.startsWith(`./${scope}/`),
    ) || null
  );
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
    'You are running inside NanoHarness on a Deep Agents runtime.',
    `Working directory: ${GROUP_ROOT}`,
    `Write all new files, screenshots, reports, logs, and generated outputs under ${GROUP_ROOT}.`,
    `Prefer absolute output paths under ${REQUIRED_OUTPUT_ROOT} so artifacts never land outside the workspace by accident.`,
    'Treat /workspace/project, /workspace/global, and /workspace/extra as mounted input context unless the user explicitly asked to modify them.',
    `Workspace diagnostics are available at ${WORKSPACE_MANIFEST_PATH} and ${RUNTIME_CONTEXT_LATEST}.`,
    'Use generic MCP tools as mcp__<server>__<tool> when external integrations are available.',
    'NanoHarness platform orchestration tools remain available as mcp__nanoclaw__* and should be used only for messaging, scheduling, and group management.',
    'When progress depends on the user, use mcp__nanoclaw__ask_user to pause natively and wait for approval, confirmation, codes, or additional instructions.',
    ...buildDelegationPolicyLines(),
    'Persist intermediate artifacts to disk for long workflows instead of emitting huge inline outputs.',
  ];

  if (containerInput.isScheduledTask) {
    sections.push(
      '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]',
    );
  }

  sections.push(runtimeInstructions.join('\n'));

  const useNativeMemory = shouldUseNativeMemory();
  const groupMemoryFile = getResolvedWorkspaceMemoryFile(containerInput, 'group');
  const globalMemoryFile = getResolvedWorkspaceMemoryFile(
    containerInput,
    'global',
  );
  const projectMemoryFile = getResolvedWorkspaceMemoryFile(
    containerInput,
    'project',
  );

  const groupClaude = groupMemoryFile
    ? readOptionalFile(groupMemoryFile.absolutePath)
    : null;
  const globalClaude = globalMemoryFile
    ? readOptionalFile(globalMemoryFile.absolutePath)
    : null;
  const projectClaude = projectMemoryFile
    ? readOptionalFile(projectMemoryFile.absolutePath)
    : null;

  if (!useNativeMemory) {
    if (groupClaude) {
      sections.push(`<group_memory>\n${groupClaude.trim()}\n</group_memory>`);
    }

    if (globalClaude) {
      sections.push(`<global_memory>\n${globalClaude.trim()}\n</global_memory>`);
    }

    if (projectClaude) {
      sections.push(
        `<project_memory>\n${projectClaude.trim()}\n</project_memory>`,
      );
    }
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
          path: groupMemoryFile?.absolutePath || posixPath.join(GROUP_ROOT, 'AGENTS.md'),
          included: groupClaude !== null,
          content: groupClaude,
        },
        global: {
          path:
            globalMemoryFile?.absolutePath || posixPath.join(GLOBAL_ROOT, 'AGENTS.md'),
          included: globalClaude !== null,
          content: globalClaude,
        },
        project: {
          path: projectMemoryFile?.absolutePath || '/workspace/project/AGENTS.md',
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

export function extractInterruptPayload(result: unknown): unknown | null {
  const candidates: unknown[] = [];

  if (isRecord(result)) {
    candidates.push(result.__interrupt__);
    if (isRecord(result.output)) {
      candidates.push((result.output as AnyRecord).__interrupt__);
    }
  }

  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const first = candidate[0];
    if (isRecord(first) && 'value' in first) {
      return first.value ?? null;
    }
    return first ?? null;
  }

  return null;
}

function getAllowedDecisionsForAction(
  reviewConfigMap: Map<string, HumanDecisionType[]>,
  actionName: string,
): HumanDecisionType[] {
  return reviewConfigMap.get(actionName) || DEFAULT_ALLOWED_DECISIONS;
}

function normalizeDecisionKeyword(message: string): HumanDecisionType | null {
  const trimmed = message.trim();
  if (/^(?:approve|approved|yes|y|ok|okay|continue)\b/i.test(trimmed)) {
    return 'approve';
  }
  if (/^(?:reject|rejected|no|n|cancel|stop)\b/i.test(trimmed)) {
    return 'reject';
  }
  if (/^edit\b/i.test(trimmed)) {
    return 'edit';
  }
  return null;
}

function assertAllowedDecision(
  decisionType: HumanDecisionType,
  allowedDecisions: HumanDecisionType[],
): void {
  if (!allowedDecisions.includes(decisionType)) {
    throw new Error(
      `Decision "${decisionType}" is not allowed here. Allowed decisions: ${allowedDecisions.join(', ')}.`,
    );
  }
}

function normalizeDecisionRecord(
  rawDecision: unknown,
  actionRequest: HumanInterruptActionRequest,
  allowedDecisions: HumanDecisionType[],
): Record<string, unknown> {
  if (typeof rawDecision === 'string') {
    return parseDecisionLine(rawDecision, actionRequest, allowedDecisions);
  }

  if (!isRecord(rawDecision)) {
    throw new Error('Each decision must be a string or object.');
  }

  const decisionType = getStringField(rawDecision, 'type');
  if (!isHumanDecisionType(decisionType)) {
    throw new Error('Decision object must include type approve, edit, or reject.');
  }

  assertAllowedDecision(decisionType, allowedDecisions);

  if (decisionType !== 'edit') {
    return { type: decisionType };
  }

  const editedAction = isRecord(rawDecision.editedAction)
    ? rawDecision.editedAction
    : rawDecision;
  const editedName =
    getStringField(editedAction, 'name') || actionRequest.name;
  const editedArgs =
    editedAction.args ??
    editedAction.arguments ??
    rawDecision.args ??
    rawDecision.arguments;

  if (editedArgs === undefined) {
    throw new Error('Edit decisions must include replacement args.');
  }

  return {
    type: 'edit',
    editedAction: {
      name: editedName,
      args: editedArgs,
    },
  };
}

function parseDecisionLine(
  line: string,
  actionRequest: HumanInterruptActionRequest,
  allowedDecisions: HumanDecisionType[],
): Record<string, unknown> {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error('Decision line cannot be empty.');
  }

  const decisionType = normalizeDecisionKeyword(trimmed);
  if (!decisionType) {
    throw new Error(
      'Reply with approve/yes, reject/no, edit {json}, or a JSON decisions payload.',
    );
  }

  assertAllowedDecision(decisionType, allowedDecisions);

  if (decisionType !== 'edit') {
    return { type: decisionType };
  }

  const editedArgsText = trimmed.replace(/^edit\b[:\s-]*/i, '').trim();
  if (!editedArgsText) {
    throw new Error('Edit decisions must include JSON arguments after "edit".');
  }

  const editedArgs = safeParseMaybeJson(editedArgsText);
  if (typeof editedArgs === 'string') {
    throw new Error('Edit decisions must include valid JSON arguments.');
  }

  return {
    type: 'edit',
    editedAction: {
      name: actionRequest.name,
      args: editedArgs,
    },
  };
}

export function formatHumanInLoopPrompt(interrupt: unknown): string {
  const actionRequests = extractActionRequests(interrupt);
  const reviewConfigMap = extractReviewConfigMap(interrupt);

  if (actionRequests.length > 0) {
    const actionLines = actionRequests.flatMap((actionRequest, index) => {
      const allowedDecisions = getAllowedDecisionsForAction(
        reviewConfigMap,
        actionRequest.name,
      );
      return [
        `${index + 1}. Tool: ${actionRequest.name}`,
        `Arguments: ${truncateForHumanPrompt(actionRequest.args) || '{}'}`,
        `Allowed decisions: ${allowedDecisions.join(', ')}`,
      ];
    });

    const decisionHint =
      actionRequests.length === 1
        ? 'Reply with approve/yes, reject/no, or edit {"field":"value"}.'
        : 'Reply with one decision per line in the same order, or JSON like {"decisions":[{"type":"approve"}, ...]}.';

    return [
      'Human review required before the agent can continue.',
      '',
      ...actionLines,
      '',
      decisionHint,
    ].join('\n');
  }

  const details = isRecord(interrupt)
    ? [
        getStringField(interrupt, 'message'),
        getStringField(interrupt, 'action'),
        getStringField(interrupt, 'type'),
      ].filter((value): value is string => typeof value === 'string')
    : [];

  return [
    'The agent paused and is waiting for user input before it can continue.',
    ...(details.length > 0 ? ['', ...details] : []),
    '',
    'Reply with yes/no, plain text, or JSON.',
  ].join('\n');
}

function formatHumanInLoopResumeError(
  error: unknown,
  interrupt: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    `Could not apply your reply: ${message}`,
    '',
    formatHumanInLoopPrompt(interrupt),
  ].join('\n');
}

export function parseHumanInLoopResumeInput(
  message: string,
  interrupt: unknown,
): unknown {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new Error('User reply was empty.');
  }

  const actionRequests = extractActionRequests(interrupt);
  if (actionRequests.length > 0) {
    const reviewConfigMap = extractReviewConfigMap(interrupt);
    const parsed = safeParseMaybeJson(trimmed);

    if (Array.isArray(parsed)) {
      if (parsed.length !== actionRequests.length) {
        throw new Error(
          `Expected ${actionRequests.length} decisions but got ${parsed.length}.`,
        );
      }
      return {
        decisions: parsed.map((entry, index) =>
          normalizeDecisionRecord(
            entry,
            actionRequests[index],
            getAllowedDecisionsForAction(
              reviewConfigMap,
              actionRequests[index].name,
            ),
          ),
        ),
      };
    }

    if (isRecord(parsed) && Array.isArray(parsed.decisions)) {
      if (parsed.decisions.length !== actionRequests.length) {
        throw new Error(
          `Expected ${actionRequests.length} decisions but got ${parsed.decisions.length}.`,
        );
      }
      return {
        decisions: parsed.decisions.map((entry, index) =>
          normalizeDecisionRecord(
            entry,
            actionRequests[index],
            getAllowedDecisionsForAction(
              reviewConfigMap,
              actionRequests[index].name,
            ),
          ),
        ),
      };
    }

    if (isRecord(parsed) && typeof parsed.type === 'string') {
      if (actionRequests.length !== 1) {
        throw new Error(
          'Provide one decision per line or a decisions array for multiple tool approvals.',
        );
      }
      return {
        decisions: [
          normalizeDecisionRecord(
            parsed,
            actionRequests[0],
            getAllowedDecisionsForAction(
              reviewConfigMap,
              actionRequests[0].name,
            ),
          ),
        ],
      };
    }

    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length !== actionRequests.length) {
      throw new Error(
        `Expected ${actionRequests.length} decisions in order, one per line.`,
      );
    }

    return {
      decisions: lines.map((line, index) =>
        parseDecisionLine(
          line,
          actionRequests[index],
          getAllowedDecisionsForAction(
            reviewConfigMap,
            actionRequests[index].name,
          ),
        ),
      ),
    };
  }

  const parsed = safeParseMaybeJson(trimmed);
  if (parsed !== trimmed) {
    if (isRecord(parsed) && parsed.resume !== undefined) {
      return parsed.resume;
    }
    return parsed;
  }

  if (/^(?:approve|approved|yes|y|ok|okay|continue)\b/i.test(trimmed)) {
    return {
      approved: true,
      response: trimmed,
      text: trimmed,
      value: trimmed,
    };
  }

  if (/^(?:reject|rejected|no|n|cancel|stop)\b/i.test(trimmed)) {
    return {
      approved: false,
      response: trimmed,
      text: trimmed,
      value: trimmed,
    };
  }

  return {
    response: trimmed,
    text: trimmed,
    value: trimmed,
  };
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

function sanitizeMcpNameToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
}

function applySchemaDescription<T extends z.ZodTypeAny>(
  schema: T,
  description?: string,
): T {
  return description?.trim() ? (schema.describe(description) as T) : schema;
}

function jsonSchemaToZod(schema: unknown, depth = 0): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || depth > 6) {
    return z.unknown();
  }

  const record = schema as AnyRecord;
  const description =
    typeof record.description === 'string' ? record.description : undefined;
  const typeValue = Array.isArray(record.type)
    ? record.type.find((value): value is string => typeof value === 'string')
    : typeof record.type === 'string'
      ? record.type
      : undefined;

  if (typeValue === 'string') {
    return applySchemaDescription(z.string(), description);
  }
  if (typeValue === 'number') {
    return applySchemaDescription(z.number(), description);
  }
  if (typeValue === 'integer') {
    return applySchemaDescription(z.number().int(), description);
  }
  if (typeValue === 'boolean') {
    return applySchemaDescription(z.boolean(), description);
  }
  if (typeValue === 'array') {
    const itemSchema = jsonSchemaToZod(record.items, depth + 1);
    return applySchemaDescription(z.array(itemSchema), description);
  }
  if (typeValue === 'object') {
    return applySchemaDescription(
      jsonSchemaObjectToZod(record, depth + 1),
      description,
    );
  }

  return applySchemaDescription(z.unknown(), description);
}

function jsonSchemaObjectToZod(
  schema: unknown,
  depth = 0,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  if (!schema || typeof schema !== 'object' || depth > 6) {
    return z.object({}).catchall(z.unknown());
  }

  const record = schema as AnyRecord;
  const properties =
    record.properties && typeof record.properties === 'object'
      ? (record.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const propertyType = jsonSchemaToZod(propertySchema, depth + 1);
    shape[key] = required.has(key) ? propertyType : propertyType.optional();
  }

  const objectSchema = z.object(shape);
  if (record.additionalProperties === false) {
    return objectSchema;
  }
  if (record.additionalProperties && typeof record.additionalProperties === 'object') {
    return objectSchema.catchall(
      jsonSchemaToZod(record.additionalProperties, depth + 1),
    );
  }
  return objectSchema.catchall(z.unknown());
}

function stringifyStructuredContent(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function normalizeMcpToolResult(result: AnyRecord): NormalizedMcpToolResult {
  const parts: string[] = [];

  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!block || typeof block !== 'object') continue;
      const record = block as AnyRecord;
      if (record.type === 'text' && typeof record.text === 'string') {
        parts.push(record.text);
        continue;
      }
      if (
        record.type === 'resource_link' &&
        typeof record.name === 'string' &&
        typeof record.uri === 'string'
      ) {
        parts.push(`${record.name}: ${record.uri}`);
        continue;
      }
      if (typeof record.type === 'string') {
        parts.push(`[${record.type}]`);
      }
    }
  }

  const structured = stringifyStructuredContent(result.structuredContent);
  if (structured) {
    parts.push(structured);
  }

  const text = parts.join('\n\n').trim();
  const isError = result.isError === true;
  const summary = isError
    ? 'MCP tool returned an error.'
    : text
      ? 'MCP tool completed with output.'
      : 'MCP tool completed.';

  return {
    text: text || summary,
    structured,
    isError,
    summary,
  };
}

export function renderMcpToolResult(result: AnyRecord): string {
  return normalizeMcpToolResult(result).text;
}

export async function loadConfiguredMcpTools(
  emitStatus: (text: string, replace?: boolean) => void,
): Promise<LoadedMcpToolSet> {
  const servers = parseConfiguredMcpServers();
  if (servers.length === 0) {
    return {
      tools: [],
      cleanup: async () => {},
      servers: [],
    };
  }

  const transports: StdioClientTransport[] = [];
  const runtimeTools: any[] = [];

  for (const server of servers) {
    const serverName = sanitizeMcpNameToken(server.name);

    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        stderr: 'pipe',
      } satisfies StdioServerParameters);
      const stderrStream = transport.stderr;
      if (stderrStream) {
        stderrStream.on('data', (chunk: Buffer | string) => {
          const text = chunk.toString().trim();
          if (text) log(`[mcp:${server.name}] ${text}`);
        });
      }

      const client = new Client(
        {
          name: 'nanoharness-agent-runner',
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      await client.connect(transport);
      transports.push(transport);

      const { tools } = await client.listTools();
      log(`Loaded ${tools.length} tools from MCP server ${server.name}`);

      for (const mcpTool of tools) {
        const toolName = `mcp__${serverName}__${sanitizeMcpNameToken(mcpTool.name)}`;
        runtimeTools.push(
          tool(
            async (input: Record<string, unknown>) => {
              emitStatus(`${toolName}: executing`);
              const result = (await client.callTool(
                {
                  name: mcpTool.name,
                  arguments: input,
                },
                CompatibilityCallToolResultSchema,
              )) as unknown as AnyRecord;
              const normalized = normalizeMcpToolResult(result);
              if (result.isError === true) {
                throw new Error(normalized.text);
              }
              return normalized.text;
            },
            {
              name: toolName,
              description:
                mcpTool.description ||
                `MCP tool "${mcpTool.name}" provided by server "${server.name}".`,
              schema: jsonSchemaObjectToZod(mcpTool.inputSchema),
            },
          ),
        );
      }
    } catch (err) {
      log(
        `Failed to initialize MCP server ${server.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    tools: runtimeTools,
    servers,
    cleanup: async () => {
      await Promise.allSettled(transports.map((transport) => transport.close()));
    },
  };
}

export function createNanoClawTools(
  containerInput: ContainerInput,
  emitStatus: (text: string, replace?: boolean) => void,
) {
  const askUserTool = tool(
    async ({
      question,
      context,
      expected_format,
    }: {
      question: string;
      context?: string;
      expected_format?: string;
    }) => {
      emitStatus(`mcp__nanoclaw__ask_user: ${question.slice(0, 120)}`);
      const response = await requestHumanInterrupt({
        type: 'nanoclaw_user_input',
        question,
        message: question,
        context,
        expectedFormat: expected_format,
        chatJid: containerInput.chatJid,
        groupFolder: containerInput.groupFolder,
      });
      return typeof response === 'string'
        ? response
        : safeJsonStringify(response);
    },
    {
      name: 'mcp__nanoclaw__ask_user',
      description:
        'Pause execution and ask the user for approval, confirmation, or extra information. Use this when progress depends on user input such as yes/no confirmation, a CAPTCHA, a code, or additional instructions.',
      schema: z.object({
        question: z
          .string()
          .describe('What you need the user to answer right now.'),
        context: z
          .string()
          .optional()
          .describe('Optional short context explaining why the answer is needed.'),
        expected_format: z
          .string()
          .optional()
          .describe('Optional hint such as yes/no, JSON, code, OTP, or free text.'),
      }),
    },
  );

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
    askUserTool,
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

  const nanoClawTools = createNanoClawTools(containerInput, emitStatus);
  const mcpToolSet = await loadConfiguredMcpTools(emitStatus);
  const tools = [...nanoClawTools, ...mcpToolSet.tools] as typeof nanoClawTools;
  const provider = getModelProvider();
  const primaryModelName = getPrimaryModelName(provider);
  const model = createChatModel(provider, primaryModelName);
  const middleware = await loadDeepAgentsMiddleware(provider, primaryModelName);
  const subagents = buildPredefinedSubagents({
    provider,
    primaryModelName,
    skills,
    tools,
  });
  const interruptOn = parseInterruptOnConfig();
  const memory = shouldUseNativeMemory()
    ? buildDeepAgentsMemoryPaths(containerInput)
    : undefined;

  const agent = (await createDeepAgent({
    name: getDeepAgentName(containerInput),
    model,
    backend,
    tools,
    skills,
    memory,
    checkpointer,
    middleware,
    subagents,
    interruptOn,
  })) as unknown as {
    invoke: (input: unknown, config?: unknown) => Promise<unknown>;
    stream?: (input: unknown, config?: unknown) => Promise<AsyncIterable<unknown>>;
  };

  return {
    agent,
    checkpointer,
    cleanup: mcpToolSet.cleanup,
  };
}

async function runQuery(
  agent: RuntimeAgent,
  checkpointer: any,
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  resumeAt?: string,
  pendingIpcMessages: string[] = [],
  pendingInterrupt?: PendingInterruptState | null,
): Promise<QueryRunResult> {
  const nextSessionId =
    pendingInterrupt?.sessionId || sessionId || crypto.randomUUID();
  let sawStatusEvent = false;

  const emitStatus = (text: string, replace = false) => {
    sawStatusEvent = true;
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: nextSessionId,
      lastAssistantUuid: pendingInterrupt?.checkpointId || resumeAt,
      event: {
        type: 'status',
        text,
        replace,
      },
    });
  };

  let invocationInput: unknown;
  let shouldRetryFromLatest = false;
  let checkpointTarget = resumeAt;

  if (pendingInterrupt) {
    emitStatus('Resuming Deep Agents query from pending user input...', true);
    try {
      const resumePayload = parseHumanInLoopResumeInput(
        prompt,
        pendingInterrupt.interrupt,
      );
      invocationInput = await createResumeCommandInput(resumePayload);
      checkpointTarget = undefined;
      streamingOutput.decision('Human-in-the-loop', 'resuming');
    } catch (err) {
      const resumeErrorPrompt = formatHumanInLoopResumeError(
        err,
        pendingInterrupt.interrupt,
      );
      writeOutput({
        status: 'success',
        result: resumeErrorPrompt,
        newSessionId: nextSessionId,
        lastAssistantUuid: pendingInterrupt.checkpointId || resumeAt,
      });
      return {
        newSessionId: nextSessionId,
        lastAssistantUuid: pendingInterrupt.checkpointId || resumeAt,
        closedDuringQuery: false,
        lastAssistantText: resumeErrorPrompt,
        lastResultText: resumeErrorPrompt,
        lastResultSubtype: 'interrupt',
        sawStatusEvent,
      };
    }
  } else {
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
    invocationInput = {
      messages: [{ role: 'user', content: runtimePrompt }],
    };
    shouldRetryFromLatest = true;
  }

  const baseConfig: AnyRecord = {
    configurable: {
      thread_id: nextSessionId,
    },
    recursionLimit: QUERY_RECURSION_LIMIT,
  };

  const invokeWithoutNativeStreaming = async (): Promise<unknown> =>
    agent.invoke(invocationInput, baseConfig);

  const invokeWithCurrentMode = async (): Promise<unknown> =>
    shouldUseNativeStreaming(agent)
      ? await consumeNativeAgentStream(agent, invocationInput, baseConfig)
      : await invokeWithoutNativeStreaming();

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
    if (checkpointTarget) {
      (baseConfig.configurable as AnyRecord).checkpoint_id = checkpointTarget;
    }
    try {
      result = await invokeWithCurrentMode();
    } catch (err) {
      if (shouldUseNativeStreaming(agent) && shouldFallbackFromNativeStreaming(err)) {
        const errorMessage = formatErrorMessage(err);
        const errorStack = formatErrorStack(err);
        log(
          `Native streaming failed, falling back to invoke(): ${errorMessage}. Debug log: ${NATIVE_STREAM_DEBUG_PATH}`,
        );
        if (errorStack) {
          log(`Native streaming stack:\n${errorStack}`);
        }
        emitStatus(
          'Native streaming failed for this turn. Falling back to non-streaming invoke().',
          true,
        );
        streamingOutput.decision(
          'Native stream bridge',
          'fallback to invoke',
        );
        result = await invokeWithoutNativeStreaming();
      } else {
        throw err;
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (shouldRetryFromLatest && checkpointTarget && looksLikeMissingCheckpoint(errorMessage)) {
      emitStatus(
        'Stored checkpoint is invalid. Retrying from the latest thread state.',
        true,
      );
      delete (baseConfig.configurable as AnyRecord).checkpoint_id;
      try {
        result = await invokeWithCurrentMode();
      } catch (retryErr) {
        if (
          shouldUseNativeStreaming(agent) &&
          shouldFallbackFromNativeStreaming(retryErr)
        ) {
          const retryMessage = formatErrorMessage(retryErr);
          const retryStack = formatErrorStack(retryErr);
          log(
            `Native streaming retry failed, falling back to invoke(): ${retryMessage}. Debug log: ${NATIVE_STREAM_DEBUG_PATH}`,
          );
          if (retryStack) {
            log(`Native streaming retry stack:\n${retryStack}`);
          }
          emitStatus(
            'Native streaming retry failed. Falling back to non-streaming invoke().',
            true,
          );
          streamingOutput.decision(
            'Native stream bridge',
            'retry fallback to invoke',
          );
          result = await invokeWithoutNativeStreaming();
        } else {
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  } finally {
    clearInterval(heartbeat);
  }

  const interruptPayload = extractInterruptPayload(result);
  const checkpointId =
    (await getLatestCheckpointId(checkpointer, nextSessionId)) ||
    pendingInterrupt?.checkpointId ||
    resumeAt;

  if (interruptPayload) {
    const nextPendingInterrupt: PendingInterruptState = {
      createdAt: new Date().toISOString(),
      sessionId: nextSessionId,
      checkpointId,
      interrupt: interruptPayload,
    };
    writePendingInterruptState(nextPendingInterrupt);
    streamingOutput.decision('Human-in-the-loop', 'waiting for user input');

    const interruptPrompt = formatHumanInLoopPrompt(interruptPayload);
    writeOutput({
      status: 'success',
      result: interruptPrompt,
      newSessionId: nextSessionId,
      lastAssistantUuid: checkpointId,
    });

    return {
      newSessionId: nextSessionId,
      lastAssistantUuid: checkpointId,
      closedDuringQuery: false,
      lastAssistantText: interruptPrompt,
      lastResultText: interruptPrompt,
      lastResultSubtype: 'interrupt',
      sawStatusEvent,
    };
  }

  clearPendingInterruptState();

  const finalText = extractFinalAssistantText(result);

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

  // Initialize streaming output with session ID
  streamingOutput.setSessionId(containerInput.sessionId);
  streamingOutput.setEnabled(containerInput.enableStreaming !== false);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    // ignore
  }

  ensureRuntimeWorkspace(containerInput);

  // Emit initial streaming event
  streamingOutput.decision('Container startup', 'Workspace initialized');

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

  const autoContinueConfig = getAutoContinueConfig();
  const { agent, checkpointer, cleanup } = await buildAgent(
    containerInput,
    statusWriter,
  );

  let pendingInterrupt = readPendingInterruptState();
  let sessionId = pendingInterrupt?.sessionId || containerInput.sessionId;
  let resumeAt =
    pendingInterrupt?.checkpointId || containerInput.resumeAt;
  let prompt = containerInput.prompt;
  let pendingForQuery = drainIpcInput();
  if (pendingForQuery.length > 0 && !pendingInterrupt) {
    log(
      `Draining ${pendingForQuery.length} pending IPC messages into initial prompt`,
    );
    prompt += `\n${pendingForQuery.join('\n')}`;
  }
  if (pendingInterrupt && pendingForQuery.length > 0) {
    prompt = [prompt, ...pendingForQuery].filter(Boolean).join('\n');
    pendingForQuery = [];
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
        pendingInterrupt,
      );

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }
      pendingInterrupt = readPendingInterruptState();

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      const autoContinueReason = getAutoContinueReason(
        queryResult,
        containerInput.isScheduledTask === true,
        autoContinueCount,
        autoContinueConfig,
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
    const errorMessage = formatErrorMessage(err);
    const errorStack = formatErrorStack(err);
    log(`Agent error: ${errorMessage}`);
    if (errorStack) {
      log(`Agent error stack:\n${errorStack}`);
    }
    streamingOutput.error(errorMessage);
    streamingOutput.complete();
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      lastAssistantUuid: resumeAt,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    // Cleanup streaming output
    streamingOutput.cleanup();
    await cleanup();
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    const errorMessage = formatErrorMessage(err);
    const errorStack = formatErrorStack(err);
    log(`Fatal startup error: ${errorMessage}`);
    if (errorStack) {
      log(`Fatal startup stack:\n${errorStack}`);
    }
    streamingOutput.error(errorMessage);
    streamingOutput.complete();
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  });
}

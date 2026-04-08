/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL,
  ANTHROPIC_MODEL,
  CLAUDE_CODE_SUBAGENT_MODEL,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MODEL_API_FORMAT,
  NANOCLAW_CODER_MODEL,
  NANOCLAW_DEBUG_NATIVE_STREAM,
  NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK,
  NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS,
  NANOCLAW_ENABLE_SUMMARIZATION,
  NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE,
  NANOCLAW_INTERRUPT_ON_JSON,
  NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT,
  NANOCLAW_RESEARCHER_MODEL,
  NANOCLAW_REVIEWER_MODEL,
  NANOCLAW_SUBAGENT_CODER_MODEL,
  NANOCLAW_SUBAGENT_CODER_SKILLS,
  NANOCLAW_SUBAGENT_RESEARCHER_MODEL,
  NANOCLAW_SUBAGENT_RESEARCHER_SKILLS,
  NANOCLAW_SUBAGENT_REVIEWER_MODEL,
  NANOCLAW_SUBAGENT_REVIEWER_SKILLS,
  NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS,
  NANOCLAW_STREAM_CONTENT_FROM_NATIVE,
  NANOCLAW_USE_NATIVE_STREAMING,
  NANOCLAW_USE_NATIVE_MEMORY,
  OPENAI_MODEL,
  STREAMING_CONFIG,
  TIMEZONE,
} from './config.js';
import {
  type NativeCompactOutcome,
  type NativeCompactRequest,
} from './compact/native-compact.js';
import {
  StreamEvent,
  StreamProcessor,
  ProcessOptions,
} from './streaming/index.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode, detectProvider } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';
import {
  createContainerLifecycleState,
  trackContainerOutput,
  trackContainerStreamEvent,
} from './container-lifecycle.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  enableStreaming?: boolean; // Enable streaming output
  nativeCompact?: NativeCompactRequest;
}

export interface ContainerOutput {
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
  streamEvents?: StreamEvent[]; // Collected streaming events
  nativeCompact?: NativeCompactOutcome;
}

const QUERY_START_STATUS_TEXT = 'Starting Deep Agents query...';
const HEARTBEAT_STATUS_PREFIX = 'Still working inside the container. Elapsed ';

function getQueryProgressTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.NANOCLAW_QUERY_PROGRESS_TIMEOUT_MS || '120000',
    10,
  );
  if (Number.isNaN(parsed) || parsed < 30000) {
    return 120000;
  }
  return parsed;
}

function isStatusOutput(output: ContainerOutput): boolean {
  return (
    output.event?.type === 'status' && typeof output.event.text === 'string'
  );
}

function isQueryStartStatusOutput(output: ContainerOutput): boolean {
  return (
    isStatusOutput(output) && output.event!.text === QUERY_START_STATUS_TEXT
  );
}

function isHeartbeatStatusOutput(output: ContainerOutput): boolean {
  return (
    isStatusOutput(output) &&
    output.event!.text.startsWith(HEARTBEAT_STATUS_PREFIX)
  );
}

function isMeaningfulContainerOutput(output: ContainerOutput): boolean {
  if (output.result) return true;
  if (output.queryCompleted) return true;
  return output.event?.type === 'assistant';
}

function isMeaningfulStreamEvent(event: StreamEvent): boolean {
  return [
    'thinking',
    'plan',
    'plan_step',
    'tool_start',
    'tool_progress',
    'tool_complete',
    'content',
    'complete',
  ].includes(event.type);
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function escapeLogChunk(chunk: string): string {
  return chunk.replace(/\r\n/g, '\n');
}

function isTerminalTestMode(): boolean {
  return process.env.NANOCLAW_TERMINAL_TEST_MODE === 'true';
}

function extractLatestUserMessage(prompt: string): string {
  const matches = [
    ...prompt.matchAll(/<message\b[^>]*>([\s\S]*?)<\/message>/g),
  ];
  const raw = matches.at(-1)?.[1] || prompt;
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function buildFakeAgentResponse(prompt: string): string {
  const latestMessage = extractLatestUserMessage(prompt);
  const normalized = latestMessage.toLowerCase();

  if (
    normalized.includes('苏州天气') ||
    normalized.includes('suzhou weather')
  ) {
    return '苏州天气测试响应：多云，25°C，东南风 2 级。';
  }

  if (
    normalized.includes('hi') ||
    normalized.includes('hello') ||
    normalized.includes('hihihi') ||
    normalized.includes('你好')
  ) {
    return '你好！我是 NanoHarness 终端测试助手。';
  }

  return `测试响应：${latestMessage || '已收到。'}`;
}

async function runFakeContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onStreamEvent?: (event: StreamEvent) => Promise<void>,
): Promise<ContainerOutput> {
  const sessionId = input.sessionId || `fake-session-${group.folder}`;
  const lastAssistantUuid = `fake-msg-${Date.now()}`;
  const response = buildFakeAgentResponse(input.prompt);

  await onOutput?.({
    status: 'success',
    result: null,
    newSessionId: sessionId,
    lastAssistantUuid,
    event: {
      type: 'status',
      text: 'Starting Deep Agents query...',
      replace: true,
    },
  });

  await onStreamEvent?.({
    type: 'decision',
    timestamp: new Date().toISOString(),
    data: {
      description: 'Fake terminal backend',
      choice: 'deterministic test response',
    },
  });

  await onStreamEvent?.({
    type: 'content',
    timestamp: new Date().toISOString(),
    data: {
      text: response,
      replace: true,
    },
  });

  return {
    status: 'success',
    result: response,
    newSessionId: sessionId,
    lastAssistantUuid,
    queryCompleted: true,
  };
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    fs.rmSync(skillsDst, { recursive: true, force: true });
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      force: true,
    });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  const provider = detectProvider();
  args.push('-e', `MODEL_PROVIDER=${provider}`);

  // Route provider traffic through the credential proxy (containers never see real secrets)
  if (provider === 'openai') {
    args.push(
      '-e',
      `OPENAI_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );
    args.push('-e', 'OPENAI_API_KEY=placeholder');
  } else {
    args.push(
      '-e',
      `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );

    // Mirror the host's auth method with a placeholder value.
    // API key mode: SDK sends x-api-key, proxy replaces with real key.
    // OAuth mode:   SDK exchanges placeholder token for temp API key,
    //               proxy injects real OAuth token on that exchange request.
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    } else {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
  }

  const passthroughEnv = [
    ['ANTHROPIC_MODEL', ANTHROPIC_MODEL],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', ANTHROPIC_DEFAULT_OPUS_MODEL],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', ANTHROPIC_DEFAULT_SONNET_MODEL],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', ANTHROPIC_DEFAULT_HAIKU_MODEL],
    ['OPENAI_MODEL', OPENAI_MODEL],
    ['CLAUDE_CODE_SUBAGENT_MODEL', CLAUDE_CODE_SUBAGENT_MODEL],
    ['MODEL_API_FORMAT', MODEL_API_FORMAT],
    ['NANOCLAW_HEARTBEAT_MS', process.env.NANOCLAW_HEARTBEAT_MS],
    ['NANOCLAW_RECURSION_LIMIT', process.env.NANOCLAW_RECURSION_LIMIT],
    ['NANOCLAW_AUTO_CONTINUE_LIMIT', process.env.NANOCLAW_AUTO_CONTINUE_LIMIT],
    [
      'NANOCLAW_AUTO_CONTINUE_SCHEDULED',
      process.env.NANOCLAW_AUTO_CONTINUE_SCHEDULED,
    ],
    ['NANOCLAW_AGENT_MAX_RETRIES', process.env.NANOCLAW_AGENT_MAX_RETRIES],
    ['NANOCLAW_AGENT_RETRY_BASE_MS', process.env.NANOCLAW_AGENT_RETRY_BASE_MS],
    ['NANOCLAW_MCP_SERVERS_JSON', process.env.NANOCLAW_MCP_SERVERS_JSON],
    ['NANOCLAW_ENABLE_SUMMARIZATION', NANOCLAW_ENABLE_SUMMARIZATION],
    [
      'NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE',
      NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE,
    ],
    [
      'NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS',
      NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS,
    ],
    ['NANOCLAW_USE_NATIVE_MEMORY', NANOCLAW_USE_NATIVE_MEMORY],
    ['NANOCLAW_INTERRUPT_ON_JSON', NANOCLAW_INTERRUPT_ON_JSON],
    [
      'NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS',
      NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS,
    ],
    [
      'NANOCLAW_SUBAGENT_RESEARCHER_SKILLS',
      NANOCLAW_SUBAGENT_RESEARCHER_SKILLS,
    ],
    ['NANOCLAW_SUBAGENT_CODER_SKILLS', NANOCLAW_SUBAGENT_CODER_SKILLS],
    ['NANOCLAW_SUBAGENT_REVIEWER_SKILLS', NANOCLAW_SUBAGENT_REVIEWER_SKILLS],
    ['NANOCLAW_SUBAGENT_RESEARCHER_MODEL', NANOCLAW_SUBAGENT_RESEARCHER_MODEL],
    ['NANOCLAW_RESEARCHER_MODEL', NANOCLAW_RESEARCHER_MODEL],
    ['NANOCLAW_SUBAGENT_CODER_MODEL', NANOCLAW_SUBAGENT_CODER_MODEL],
    ['NANOCLAW_CODER_MODEL', NANOCLAW_CODER_MODEL],
    ['NANOCLAW_SUBAGENT_REVIEWER_MODEL', NANOCLAW_SUBAGENT_REVIEWER_MODEL],
    ['NANOCLAW_REVIEWER_MODEL', NANOCLAW_REVIEWER_MODEL],
    ['NANOCLAW_STREAMING', process.env.NANOCLAW_STREAMING],
    ['NANOCLAW_SHOW_THINKING', process.env.NANOCLAW_SHOW_THINKING],
    ['NANOCLAW_SHOW_PLAN', process.env.NANOCLAW_SHOW_PLAN],
    ['NANOCLAW_SHOW_TOOLS', process.env.NANOCLAW_SHOW_TOOLS],
    ['NANOCLAW_THINKING_COLLAPSED', process.env.NANOCLAW_THINKING_COLLAPSED],
    ['NANOCLAW_STREAM_BUFFER_SIZE', process.env.NANOCLAW_STREAM_BUFFER_SIZE],
    ['NANOCLAW_USE_NATIVE_STREAMING', NANOCLAW_USE_NATIVE_STREAMING],
    [
      'NANOCLAW_STREAM_CONTENT_FROM_NATIVE',
      NANOCLAW_STREAM_CONTENT_FROM_NATIVE,
    ],
    ['NANOCLAW_DEBUG_NATIVE_STREAM', NANOCLAW_DEBUG_NATIVE_STREAM],
    [
      'NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK',
      NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK,
    ],
    [
      'NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT',
      NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT,
    ],
  ] as const;
  for (const [key, value] of passthroughEnv) {
    if (value) args.push('-e', `${key}=${value}`);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // On native Windows, process.getuid is unavailable and Docker Desktop bind
  // mounts are more reliable when the container runs as root.
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  } else if (hostUid == null && process.platform === 'win32') {
    args.push('--user', '0:0');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onStreamEvent?: (event: StreamEvent) => Promise<void>, // New streaming callback
): Promise<ContainerOutput> {
  const startTime = Date.now();

  if (isTerminalTestMode()) {
    logger.debug({ group: group.name }, 'Using fake terminal test backend');
    return runFakeContainerAgent(group, input, onOutput, onStreamEvent);
  }

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const streamLogFile = path.join(
    logsDir,
    `container-${logTimestamp}.stream.log`,
  );
  fs.writeFileSync(
    streamLogFile,
    [
      '=== Live Container Stream ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `Container: ${containerName}`,
      `Session ID: ${input.sessionId || 'new'}`,
      '',
    ].join('\n') + '\n',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
      streamLogFile,
    },
    'Spawning container agent',
  );

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const queryProgressTimeoutMs = getQueryProgressTimeoutMs();
    let queryActive = false;
    let queryProgressTimedOut = false;
    let queryProgressTimer: ReturnType<typeof setTimeout> | null = null;

    // Initialize streaming processor if streaming is enabled
    const streamingEnabled =
      input.enableStreaming !== false && STREAMING_CONFIG.ENABLED;
    let streamProcessor: StreamProcessor | null = null;
    const streamEvents: StreamEvent[] = [];

    const lifecycle = createContainerLifecycleState(
      input.sessionId,
      input.resumeAt,
    );

    if (streamingEnabled) {
      const processorOptions: ProcessOptions = {
        sessionId: input.sessionId || `new-${Date.now()}`,
        groupName: group.name,
        showThinking: STREAMING_CONFIG.SHOW_THINKING,
        showPlan: STREAMING_CONFIG.SHOW_PLAN,
        showTools: STREAMING_CONFIG.SHOW_TOOLS,
        collapseThinking: STREAMING_CONFIG.THINKING_COLLAPSED,
        maxEvents: STREAMING_CONFIG.MAX_EVENTS,
        emitResidualBufferErrors: false,
      };
      streamProcessor = new StreamProcessor(processorOptions, false);
    }

    const appendStreamLog = (source: 'stdout' | 'stderr', chunk: string) => {
      try {
        fs.appendFileSync(
          streamLogFile,
          `[${new Date().toISOString()}] [${source}] ${escapeLogChunk(chunk)}`,
        );
      } catch (err) {
        logger.warn(
          { group: group.name, streamLogFile, err },
          'Failed to append live container stream log',
        );
      }
    };

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let outputChain = Promise.resolve();
    const forwardStreamEvents = (
      events: StreamEvent[],
      options?: { resetTimer?: boolean },
    ) => {
      for (const event of events) {
        streamEvents.push(event);
        if (onStreamEvent) {
          outputChain = outputChain.then(() => onStreamEvent(event));
        }
        trackContainerStreamEvent(lifecycle, event);
        if (queryActive && isMeaningfulStreamEvent(event)) {
          resetQueryProgressTimeout();
        }
        if (options?.resetTimer !== false) {
          resetTimeout();
        }
      }
    };

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      appendStreamLog('stdout', chunk);

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers (legacy format)
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            trackContainerOutput(lifecycle, parsed);
            if (isQueryStartStatusOutput(parsed)) {
              queryActive = true;
              resetQueryProgressTimeout();
            } else if (parsed.queryCompleted) {
              queryActive = false;
              clearQueryProgressTimeout();
            } else if (
              queryActive &&
              isMeaningfulContainerOutput(parsed) &&
              !isHeartbeatStatusOutput(parsed)
            ) {
              resetQueryProgressTimeout();
            }
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }

      // Parse streaming events if enabled
      if (streamProcessor) {
        const events = streamProcessor.processChunk(chunk);
        forwardStreamEvents(events);
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      appendStreamLog('stderr', chunk);
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const clearQueryProgressTimeout = () => {
      if (queryProgressTimer) {
        clearTimeout(queryProgressTimer);
        queryProgressTimer = null;
      }
    };

    const killOnQueryProgressTimeout = () => {
      queryProgressTimedOut = true;
      timedOut = true;
      logger.error(
        { group: group.name, containerName, queryProgressTimeoutMs },
        'Container query made no meaningful progress, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop after query progress timeout failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    const resetQueryProgressTimeout = () => {
      clearQueryProgressTimeout();
      queryProgressTimer = setTimeout(
        killOnQueryProgressTimeout,
        queryProgressTimeoutMs,
      );
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      clearQueryProgressTimeout();
      // Flush any remaining stream events and cleanup
      if (streamProcessor) {
        const remainingEvents = streamProcessor.flush();
        forwardStreamEvents(remainingEvents, { resetTimer: false });
        streamProcessor.dispose();
      }
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${lifecycle.hadOutputActivity}`,
          ].join('\n'),
        );
        try {
          fs.appendFileSync(
            streamLogFile,
            `\n[${new Date().toISOString()}] [system] Container timed out after ${duration}ms${queryProgressTimedOut ? ' (query progress timeout)' : ''}\n`,
          );
        } catch {
          // ignore
        }

        if (queryProgressTimedOut) {
          logger.error(
            { group: group.name, containerName, duration, code },
            'Container query progress timeout triggered',
          );
          outputChain.then(() => {
            resolve({
              status: 'error',
              result: null,
              error: `Container query made no meaningful progress for ${queryProgressTimeoutMs}ms`,
              streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
            });
          });
          return;
        }

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (lifecycle.hadOutputActivity) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId: lifecycle.newSessionId,
              lastAssistantUuid: lifecycle.lastAssistantUuid,
              streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Container timed out after ${configTimeout}ms`,
            streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
          });
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      try {
        fs.appendFileSync(
          streamLogFile,
          `\n[${new Date().toISOString()}] [system] Container closed with code ${code}\n`,
        );
      } catch {
        // ignore
      }
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
            streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
          });
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            {
              group: group.name,
              duration,
              newSessionId: lifecycle.newSessionId,
            },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId: lifecycle.newSessionId,
            lastAssistantUuid: lifecycle.lastAssistantUuid,
            streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        // Add streaming events to output
        if (streamEvents.length > 0) {
          output.streamEvents = streamEvents;
        }

        outputChain.then(() => resolve(output));
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
            streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
          });
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      // Flush any remaining stream events
      if (streamProcessor) {
        const remainingEvents = streamProcessor.flush();
        forwardStreamEvents(remainingEvents, { resetTimer: false });
        streamProcessor.dispose();
      }
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      outputChain.then(() => {
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
          streamEvents: streamEvents.length > 0 ? streamEvents : undefined,
        });
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

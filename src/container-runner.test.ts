import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
  ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
  ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
  ANTHROPIC_MODEL: undefined,
  CLAUDE_CODE_SUBAGENT_MODEL: undefined,
  CONTAINER_IMAGE: 'nanoharness-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  MODEL_API_FORMAT: 'anthropic',
  MODEL_PROVIDER: 'anthropic',
  OPENAI_MODEL: undefined,
  TIMEZONE: 'America/Los_Angeles',
  STREAMING_CONFIG: {
    ENABLED: true,
    SHOW_THINKING: true,
    THINKING_COLLAPSED: false,
    SHOW_PLAN: true,
    SHOW_TOOLS: true,
    BUFFER_SIZE: 1000,
    MAX_EVENTS: 10000,
  },
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  detectProvider: vi.fn(() => 'anthropic'),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
      lastAssistantUuid: 'assistant-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(result.lastAssistantUuid).toBe('assistant-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'Here is my response',
        lastAssistantUuid: 'assistant-123',
      }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('status markers keep a long-running query alive', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      event: {
        type: 'status',
        text: 'Starting Deep Agents query...',
        replace: true,
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(1820000);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      event: {
        type: 'status',
        text: 'Still working inside the container. Elapsed 30m 20s.',
        replace: true,
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(1820000);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'status',
          text: 'Still working inside the container. Elapsed 30m 20s.',
        }),
      }),
    );
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
      lastAssistantUuid: 'assistant-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
    expect(result.lastAssistantUuid).toBe('assistant-456');
  });

  it('forwards structured stream events through onStreamEvent', async () => {
    const onOutput = vi.fn(async () => {});
    const onStreamEvent = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onStreamEvent,
    );

    fakeProc.stdout.push('<<<THINKING>>>{"content":"reasoning"}<<<THINKING_END>>>');
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onStreamEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'reasoning',
      }),
    );
  });

  it('passes query completion markers through streaming callbacks', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-789',
      queryCompleted: true,
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        queryCompleted: true,
        newSessionId: 'session-789',
      }),
    );
  });

  it('writes a live stream log while the container is still running', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.stdout.push('hello from stdout\n');
    fakeProc.stderr.push('hello from stderr\n');
    await vi.advanceTimersByTimeAsync(10);

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.stream.log'),
      expect.stringContaining('[stdout] hello from stdout'),
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.stream.log'),
      expect.stringContaining('[stderr] hello from stderr'),
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('parses markers split across stdout chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    const payload = `${OUTPUT_START_MARKER}\n${JSON.stringify({
      status: 'success',
      result: 'chunked',
      newSessionId: 'split-session',
    })}\n${OUTPUT_END_MARKER}\n`;
    fakeProc.stdout.push(payload.slice(0, 25));
    fakeProc.stdout.push(payload.slice(25, 70));
    fakeProc.stdout.push(payload.slice(70));

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(result.newSessionId).toBe('split-session');
  });

  it('parses multiple markers from a single stdout chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    const first = `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: null, event: { type: 'status', text: 'step 1' } })}\n${OUTPUT_END_MARKER}`;
    const second = `${OUTPUT_START_MARKER}\n${JSON.stringify({ status: 'success', result: 'final', newSessionId: 'multi-session' })}\n${OUTPUT_END_MARKER}`;
    fakeProc.stdout.push(`${first}${second}`);

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(result.newSessionId).toBe('multi-session');
  });

  it('ignores malformed markers and still parses later valid output', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    fakeProc.stdout.push(`${OUTPUT_START_MARKER}\n{not-json}\n${OUTPUT_END_MARKER}`);
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'recovered',
      newSessionId: 'recover-session',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(result.result).toBeNull();
    expect(result.newSessionId).toBe('recover-session');
  });

  it('returns error when container exits with non-zero code', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    fakeProc.stderr.push('fatal issue\n');
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 2);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Container exited with code 2');
  });

  it('times out even if only stderr is active', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(testGroup, testInput, () => {}, onOutput);

    fakeProc.stderr.push('still logging\n');
    await vi.advanceTimersByTimeAsync(1829000);
    fakeProc.stderr.push('more logs\n');
    await vi.advanceTimersByTimeAsync(2000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(onOutput).not.toHaveBeenCalled();
  });
});

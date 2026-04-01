import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

type Provider = 'anthropic' | 'openai';
type AuthMode = 'api-key' | 'oauth' | 'bearer';

function getSpawnArgs(spawnMock: ReturnType<typeof vi.fn>): string[] {
  const calls = spawnMock.mock.calls as unknown[][];
  expect(calls.length).toBeGreaterThan(0);
  return (calls[0]?.[1] as string[] | undefined) ?? [];
}

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

async function loadRunner(provider: Provider, authMode: AuthMode) {
  vi.resetModules();

  const fakeProc = createFakeProcess();
  const spawnMock = vi.fn(() => fakeProc);

  vi.doMock('./config.js', () => ({
    ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
    ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
    ANTHROPIC_MODEL: 'claude-test-model',
    CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    CREDENTIAL_PROXY_PORT: 3001,
    DATA_DIR: '/tmp/nanoclaw-test-data',
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    IDLE_TIMEOUT: 1800000,
    OPENAI_MODEL: 'gpt-test-model',
    TIMEZONE: 'America/Los_Angeles',
  }));

  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('./credential-proxy.js', () => ({
    detectAuthMode: vi.fn(() => authMode),
    detectProvider: vi.fn(() => provider),
  }));

  vi.doMock('fs', async () => {
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
      },
    };
  });

  vi.doMock('./mount-security.js', () => ({
    validateAdditionalMounts: vi.fn(() => []),
  }));

  vi.doMock('./container-runtime.js', () => ({
    CONTAINER_HOST_GATEWAY: 'host.docker.internal',
    CONTAINER_RUNTIME_BIN: 'docker',
    hostGatewayArgs: vi.fn(() => []),
    readonlyMountArgs: vi.fn((host: string, container: string) => [
      '-v',
      `${host}:${container}:ro`,
    ]),
    stopContainer: vi.fn((name: string) => `docker stop -t 1 ${name}`),
  }));

  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
      exec: vi.fn(
        (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
          if (cb) cb(null);
          return new EventEmitter();
        },
      ),
    };
  });

  const mod = await import('./container-runner.js');
  return { mod, fakeProc, spawnMock };
}

describe('container-runner provider env injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('injects anthropic proxy env when provider is anthropic', async () => {
    const { mod, fakeProc, spawnMock } = await loadRunner('anthropic', 'api-key');

    const promise = mod.runContainerAgent(
      {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      {
        prompt: 'Hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    const args = getSpawnArgs(spawnMock);
    expect(args).toContain('-e');
    expect(args).toContain('MODEL_PROVIDER=anthropic');
    expect(args).toContain(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    );
    expect(args).toContain('ANTHROPIC_API_KEY=placeholder');
    expect(args).not.toContain(
      'OPENAI_BASE_URL=http://host.docker.internal:3001',
    );

    fakeProc.stdout.push(
      '---NANOCLAW_OUTPUT_START---\n{"status":"success","result":"ok"}\n---NANOCLAW_OUTPUT_END---\n',
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;
  });

  it('injects openai proxy env when provider is openai', async () => {
    const { mod, fakeProc, spawnMock } = await loadRunner('openai', 'bearer');

    const promise = mod.runContainerAgent(
      {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      {
        prompt: 'Hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    const args = getSpawnArgs(spawnMock);
    expect(args).toContain('MODEL_PROVIDER=openai');
    expect(args).toContain(
      'OPENAI_BASE_URL=http://host.docker.internal:3001',
    );
    expect(args).toContain('OPENAI_API_KEY=placeholder');
    expect(args).not.toContain(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    );
    expect(args).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=placeholder');

    fakeProc.stdout.push(
      '---NANOCLAW_OUTPUT_START---\n{"status":"success","result":"ok"}\n---NANOCLAW_OUTPUT_END---\n',
    );
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await promise;
  });
});

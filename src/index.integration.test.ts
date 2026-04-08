import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const configState = {
    agentMaxRetries: 0,
    agentRetryBaseMs: 1,
    credentialProxyPort: 3001,
  };
  const sessions: Record<
    string,
    { sessionId: string; resumeAt?: string | null }
  > = {};
  const routerState: Record<string, string> = {};
  const registeredGroupsStore: Record<string, any> = {};
  const channel = {
    sendMessage: vi.fn(async () => {}),
    sendAgentEvent: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
  } as any;
  const queue = {
    registerProcess: vi.fn(),
    notifyIdle: vi.fn(),
    closeStdin: vi.fn(),
    isGroupActive: vi.fn(() => false),
    getGroupRuntimeStatus: vi.fn(() => ({
      active: false,
      idleWaiting: false,
      isTaskContainer: false,
      containerName: null,
    })),
    sendMessage: vi.fn(() => false),
    enqueueMessageCheck: vi.fn(),
    setProcessMessagesFn: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
  const db = {
    getAllChats: vi.fn(() => []),
    getAllRegisteredGroups: vi.fn(() => registeredGroupsStore),
    getAllSessions: vi.fn(() => sessions),
    getAllTasks: vi.fn(() => []),
    deleteRegisteredGroup: vi.fn(),
    deleteSession: vi.fn((folder: string) => {
      delete sessions[folder];
    }),
    getMessagesSince: vi.fn(() => []),
    getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
    getRouterState: vi.fn((key: string) => routerState[key] || null),
    initDatabase: vi.fn(),
    setRegisteredGroup: vi.fn((jid: string, group: any) => {
      registeredGroupsStore[jid] = group;
    }),
    setRouterState: vi.fn((key: string, value: string) => {
      routerState[key] = value;
    }),
    setSession: vi.fn((folder: string, session: any) => {
      sessions[folder] = session;
    }),
    storeChatMetadata: vi.fn(),
    storeMessage: vi.fn(),
  };
  const containerRunner = {
    runContainerAgent: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    writeTasksSnapshot: vi.fn(),
  };
  const transientRetry = vi.fn(
    (_input: {
      attempt: number;
      maxAttempts: number;
      error?: string | null;
      sentVisibleResult?: boolean;
      observedCompletion?: boolean;
    }) => false,
  );
  return {
    configState,
    sessions,
    routerState,
    registeredGroupsStore,
    channel,
    queue,
    db,
    containerRunner,
    transientRetry,
  };
});

vi.mock('./config.js', () => ({
  get AGENT_MAX_RETRIES() {
    return state.configState.agentMaxRetries;
  },
  get AGENT_RETRY_BASE_MS() {
    return state.configState.agentRetryBaseMs;
  },
  ASSISTANT_NAME: 'Andy',
  get CREDENTIAL_PROXY_PORT() {
    return state.configState.credentialProxyPort;
  },
  DATA_DIR: '/tmp/nanoharness-test-data',
  GROUPS_DIR: '/tmp/nanoharness-test-groups',
  IDLE_TIMEOUT: 1000,
  POLL_INTERVAL: 1000,
  setCredentialProxyPort: vi.fn((port: number) => {
    state.configState.credentialProxyPort = port;
  }),
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /@Andy/i,
}));

vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn(async () => ({ close: vi.fn() })),
}));

vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(() => () => state.channel),
  getRegisteredChannelNames: vi.fn(() => []),
}));
vi.mock('./container-runner.js', () => state.containerRunner);
vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
  PROXY_BIND_HOST: '127.0.0.1',
}));
vi.mock('./db.js', () => state.db);
vi.mock('./group-queue.js', () => ({
  GroupQueue: class MockGroupQueue {
    constructor() {
      return state.queue;
    }
  },
}));
vi.mock('./group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
  resolveGroupFolderPath: vi.fn((folder: string) => `/groups/${folder}`),
  resolveGroupIpcPath: vi.fn((folder: string) => `/ipc/${folder}`),
}));
vi.mock('./ipc.js', () => ({ startIpcWatcher: vi.fn() }));
vi.mock('./compact/index.js', () => ({ compactEngine: {} }));
vi.mock('./router.js', () => ({
  findChannel: vi.fn(() => state.channel),
  formatMessages: vi.fn(
    (_messages: any[], _timezone: string, sessionId: string) =>
      `formatted:${sessionId}`,
  ),
  formatOutbound: vi.fn(),
  escapeXml: vi.fn(),
}));
vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));
vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({})),
  shouldDropMessage: vi.fn(() => false),
}));
vi.mock('./mount-security.js', () => ({ ensureMountAllowlist: vi.fn() }));
vi.mock('./service-lock.js', () => ({
  acquireServiceLock: vi.fn(),
  releaseServiceLock: vi.fn(),
}));
vi.mock('./task-scheduler.js', () => ({ startSchedulerLoop: vi.fn() }));
vi.mock('./transient-retry.js', () => ({
  shouldRetryTransientAttempt: state.transientRetry,
}));
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./terminal-channel.js', () => ({
  TerminalChannel: vi.fn(),
}));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

import { __testInternals, _setRegisteredGroups } from './index.js';

describe('index orchestration integration', () => {
  const group = {
    name: 'Local Agent',
    folder: 'local-1',
    trigger: '@Andy',
    added_at: '2026-04-02T00:00:00.000Z',
    requiresTrigger: false,
  };

  beforeEach(() => {
    state.configState.agentMaxRetries = 0;
    state.configState.agentRetryBaseMs = 1;
    state.configState.credentialProxyPort = 3001;
    Object.keys(state.sessions).forEach((key) => delete state.sessions[key]);
    Object.keys(state.routerState).forEach(
      (key) => delete state.routerState[key],
    );
    Object.keys(state.registeredGroupsStore).forEach(
      (key) => delete state.registeredGroupsStore[key],
    );
    delete state.channel.handleStreamEvent;
    vi.clearAllMocks();
    state.transientRetry.mockReset();
    state.transientRetry.mockReturnValue(false);
    _setRegisteredGroups({ 'local:1': group as any });
    state.registeredGroupsStore['local:1'] = group;
  });

  it('persists session and clears resumeAt for missing resume point', () => {
    __testInternals.persistSessionFromOutput(
      'local-1',
      {
        status: 'error',
        error: 'No message found with message.uuid abc',
        newSessionId: 'session-2',
        result: null,
      } as any,
      'session-1',
    );

    expect(state.sessions['local-1']).toEqual({
      sessionId: 'session-2',
      resumeAt: null,
    });
  });

  it('forwards structured stream events to channel handlers', async () => {
    state.db.getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'local:1',
        sender: 'user',
        sender_name: 'User',
        content: 'hi',
        timestamp: '2026-04-02T01:00:00.000Z',
        is_from_me: false,
      },
    ] as any);
    const handleStreamEvent = vi.fn(async () => {});
    state.channel.handleStreamEvent = handleStreamEvent;
    state.containerRunner.runContainerAgent.mockImplementation(
      async (
        _group: any,
        _input: any,
        _register: any,
        _onOutput: any,
        onStreamEvent: any,
      ) => {
        await onStreamEvent({
          type: 'thinking',
          timestamp: 't1',
          data: { content: 'working' },
        });
        return { status: 'error', error: 'late error', result: null };
      },
    );

    await __testInternals.processGroupMessages('local:1');

    expect(state.containerRunner.runContainerAgent).toHaveBeenCalled();
  });

  it('preserves advanced cursor when query completed before later error', async () => {
    state.db.getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'local:1',
        sender: 'user',
        sender_name: 'User',
        content: 'hi',
        timestamp: '2026-04-02T01:00:00.000Z',
        is_from_me: false,
      },
    ] as any);
    state.containerRunner.runContainerAgent.mockImplementation(
      async (_group: any, _input: any, _register: any, onOutput: any) => {
        await onOutput({
          status: 'success',
          result: null,
          queryCompleted: true,
        });
        return { status: 'error', error: 'late error', result: null };
      },
    );

    const processed = await __testInternals.processGroupMessages('local:1');

    expect(processed).toBe(true);
    expect(state.queue.notifyIdle).toHaveBeenCalledWith('local:1');
  });

  it('completes in one pass when summarization middleware path succeeds', async () => {
    state.db.getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'local:1',
        sender: 'user',
        sender_name: 'User',
        content: 'please continue',
        timestamp: '2026-04-02T01:00:00.000Z',
        is_from_me: false,
      },
    ] as any);
    state.containerRunner.runContainerAgent.mockImplementation(
      async (_group: any, input: any, _register: any, onOutput: any) => {
        expect(input).toEqual(
          expect.objectContaining({
            prompt: 'formatted:session-2',
            sessionId: 'session-2',
            resumeAt: undefined,
          }),
        );

        await onOutput({
          status: 'success',
          result: 'summarized final answer',
          newSessionId: 'session-native-2',
          lastAssistantUuid: 'assistant-native-2',
        });

        return {
          status: 'success',
          result: null,
          newSessionId: 'session-native-2',
          lastAssistantUuid: 'assistant-native-2',
        };
      },
    );

    const processed = await __testInternals.processGroupMessages('local:1');

    expect(processed).toBe(true);
    expect(state.containerRunner.runContainerAgent).toHaveBeenCalledTimes(1);
    expect(state.channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.channel.sendMessage).toHaveBeenCalledWith(
      'local:1',
      'summarized final answer',
    );
    expect(state.sessions['local-1']).toEqual({
      sessionId: 'session-native-2',
      resumeAt: 'assistant-native-2',
    });
  });

  it('does not retry a host fallback run when legacy nativeCompact metadata is present', async () => {
    state.db.getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'local:1',
        sender: 'user',
        sender_name: 'User',
        content: 'please continue',
        timestamp: '2026-04-02T01:00:00.000Z',
        is_from_me: false,
      },
    ] as any);
    state.containerRunner.runContainerAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'legacy native compact marker',
      nativeCompact: {
        attempted: true,
        succeeded: false,
        fallbackToRuleCompact: true,
        reason: 'legacy signal',
      },
    });

    const processed = await __testInternals.processGroupMessages('local:1');

    expect(processed).toBe(false);
    expect(state.containerRunner.runContainerAgent).toHaveBeenCalledTimes(1);
  });

  it('falls back to a free credential proxy port when the preferred port is busy', async () => {
    const close = vi.fn();
    const error = Object.assign(new Error('listen EADDRINUSE'), {
      code: 'EADDRINUSE',
    });
    const { startCredentialProxy } = await import('./credential-proxy.js');

    vi.mocked(startCredentialProxy)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ close } as any);

    const server = await __testInternals.startCredentialProxyWithFallback(3001);

    expect(startCredentialProxy).toHaveBeenCalledTimes(2);
    expect(startCredentialProxy).toHaveBeenNthCalledWith(1, 3001, '127.0.0.1');
    expect(startCredentialProxy).toHaveBeenNthCalledWith(
      2,
      expect.any(Number),
      '127.0.0.1',
    );
    expect(state.configState.credentialProxyPort).not.toBe(3001);
    expect(server.close).toBe(close);
  });

  it('retries transient 429 errors even when stream emits error followed by complete', async () => {
    state.configState.agentMaxRetries = 1;
    state.db.getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'local:1',
        sender: 'user',
        sender_name: 'User',
        content: 'hi',
        timestamp: '2026-04-02T01:00:00.000Z',
        is_from_me: false,
      },
    ] as any);
    state.transientRetry.mockImplementation(
      ({
        attempt,
        maxAttempts,
        error,
        sentVisibleResult,
        observedCompletion,
      }) =>
        attempt < maxAttempts &&
        !sentVisibleResult &&
        !observedCompletion &&
        /429/.test(String(error ?? '')),
    );

    let attempts = 0;
    state.containerRunner.runContainerAgent.mockImplementation(
      async (
        _group: any,
        _input: any,
        _register: any,
        onOutput: any,
        onStreamEvent: any,
      ) => {
        attempts += 1;
        if (attempts === 1) {
          await onStreamEvent({
            type: 'error',
            timestamp: 't-error',
            data: { message: '429 Provider returned error' },
          });
          await onStreamEvent({
            type: 'complete',
            timestamp: 't-complete',
            data: {},
          });
          return {
            status: 'error',
            error: '429 Provider returned error',
            result: null,
          };
        }

        await onOutput({
          status: 'success',
          result: 'retry recovered',
          newSessionId: 'session-recovered',
          lastAssistantUuid: 'assistant-recovered',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-recovered',
          lastAssistantUuid: 'assistant-recovered',
        };
      },
    );

    const processed = await __testInternals.processGroupMessages('local:1');

    expect(processed).toBe(true);
    expect(state.containerRunner.runContainerAgent).toHaveBeenCalledTimes(2);
    expect(state.channel.sendMessage).toHaveBeenCalledWith(
      'local:1',
      'retry recovered',
    );
    expect(state.transientRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        error: '429 Provider returned error',
        observedCompletion: false,
      }),
    );
  });
});

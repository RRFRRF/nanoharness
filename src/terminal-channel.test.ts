import { beforeEach, describe, expect, it, vi } from 'vitest';

const inkState = vi.hoisted(() => ({
  mountedProps: null as any,
  unmount: vi.fn(),
  subscribedHandler: null as ((item: any) => void) | null,
}));

const storeState = vi.hoisted(() => ({
  messages: [] as any[],
  completedMessages: [] as any[],
  context: null as any,
  disposed: false,
  flushCount: 0,
}));

vi.mock('./terminal-ink.js', () => ({
  TerminalInkStore: class MockTerminalInkStore {
    addMessage = vi.fn((message: any) => {
      storeState.messages.push(message);
    });
    completeMessage = vi.fn((message: any) => {
      storeState.completedMessages.push(message);
    });
    flushLiveMessage = vi.fn(() => {
      storeState.flushCount += 1;
    });
    setContext = vi.fn((context: any) => {
      storeState.context = context;
    });
    dispose = vi.fn(() => {
      storeState.disposed = true;
    });
  },
  mountTerminalInkApp: vi.fn((props: any) => {
    inkState.mountedProps = props;
    return { unmount: inkState.unmount };
  }),
}));

vi.mock('./terminal-log-sink.js', () => ({
  subscribeTerminalLogs: vi.fn((handler: (item: any) => void) => {
    inkState.subscribedHandler = handler;
    return vi.fn();
  }),
}));

vi.mock('./terminal-options.js', () => ({
  getTerminalOptions: vi.fn(() => ({
    enabled: true,
    logLevel: 'error',
    logView: 'ink',
  })),
}));

vi.mock('./terminal/stream-commands.js', () => ({
  STREAM_COMMANDS: [
    {
      name: '/view-mode',
      usage: '/view-mode <smart|full|minimal>',
      description: 'switch display mode for streaming',
    },
    {
      name: '/show-thinking',
      usage: '/show-thinking <on|off>',
      description: 'show or hide thinking process',
    },
    {
      name: '/show-plan',
      usage: '/show-plan <on|off>',
      description: 'show or hide execution plan',
    },
    {
      name: '/show-tools',
      usage: '/show-tools <on|off>',
      description: 'show or hide tool calls',
    },
    {
      name: '/collapse-thinking',
      usage: '/collapse-thinking',
      description: 'toggle thinking collapsed state',
    },
    {
      name: '/stream-status',
      usage: '/stream-status',
      description: 'show streaming configuration',
    },
  ],
  isStreamCommand: vi.fn((command: string) => {
    const cmd = command.trim().split(/\s+/)[0]?.toLowerCase();
    return [
      '/view-mode',
      '/show-thinking',
      '/show-plan',
      '/show-tools',
      '/collapse-thinking',
      '/stream-status',
    ].includes(cmd);
  }),
  handleStreamCommand: vi.fn((command: string) => {
    const parts = command.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const arg = parts[1]?.toLowerCase();

    if (cmd === '/show-thinking' && arg) {
      storeState.messages.push({ text: `Thinking display: ${arg}` });
      return true;
    }

    if (cmd === '/stream-status') {
      storeState.messages.push({
        text: 'Streaming Configuration:\n  Show thinking: false',
      });
      return true;
    }

    return false;
  }),
  getStreamConfig: vi.fn(() => ({
    viewMode: 'smart',
    showThinking: true,
    showPlan: true,
    showTools: true,
    collapseThinking: false,
  })),
}));

vi.mock('./config.js', () => ({
  STREAMING_CONFIG: {
    ENABLED: true,
    SHOW_THINKING: true,
    SHOW_PLAN: true,
    SHOW_TOOLS: true,
    THINKING_COLLAPSED: false,
    MAX_EVENTS: 100,
  },
}));

vi.mock('./streaming/index.js', () => ({
  StreamProcessor: class MockStreamProcessor {
    constructor(_options: any) {}
    processChunk(chunk: string) {
      return [JSON.parse(chunk)];
    }
    dispose = vi.fn();
  },
}));

import {
  TerminalChannel,
  getTerminalCompletions,
  parseTerminalCommand,
} from './terminal-channel.js';
import type { AgentStreamEvent } from './types.js';

describe('parseTerminalCommand', () => {
  it('parses /new', () => {
    expect(parseTerminalCommand('/new analyst')).toEqual({
      type: 'new',
      name: 'analyst',
      mounts: [],
      readWrite: false,
    });
  });

  it('parses /new with mount and rw', () => {
    expect(
      parseTerminalCommand('/new analyst --mount "C:\\repo path" --rw'),
    ).toEqual({
      type: 'new',
      name: 'analyst',
      mounts: ['C:\\repo path'],
      readWrite: true,
    });
  });

  it('parses /switch alias /attach', () => {
    expect(parseTerminalCommand('/attach worker')).toEqual({
      type: 'switch',
      target: 'worker',
    });
  });

  it('parses /send with quoted target and message', () => {
    expect(parseTerminalCommand('/send "agent-one" review this repo')).toEqual({
      type: 'send',
      target: 'agent-one',
      message: 'review this repo',
    });
  });

  it('returns usage for malformed commands', () => {
    expect(parseTerminalCommand('/send only-target')).toEqual({
      type: 'unknown',
      message: 'Usage: /send <agent-name> <message>',
    });
  });

  it('returns explicit errors for bad /new options', () => {
    expect(parseTerminalCommand('/new analyst --mount')).toEqual({
      type: 'unknown',
      message: 'Usage: /new <agent-name> [--mount <path>] [--rw]',
    });
    expect(parseTerminalCommand('/new analyst --bad')).toEqual({
      type: 'unknown',
      message: 'Unknown /new option: --bad',
    });
  });

  it('completes slash commands', () => {
    expect(getTerminalCompletions('/sw', [])[0]).toContain('/switch');
  });

  it('completes agent targets for switch-like commands', () => {
    const [matches] = getTerminalCompletions('/switch re', [
      {
        jid: 'local:repo',
        name: 'repo',
        folder: 'local-repo',
        active: false,
      },
    ]);
    expect(matches).toContain('repo');
  });

  it('completes /new flags and returns empty for non-commands', () => {
    expect(getTerminalCompletions('/new analyst --', [])[0]).toContain(
      '--mount',
    );
    expect(getTerminalCompletions('hello', [])[0]).toEqual([]);
  });
});

describe('TerminalChannel', () => {
  const agents = [
    {
      jid: 'local:one',
      name: 'one',
      folder: 'local-one',
      active: false,
      status: 'idle',
      sessionId: 's1',
      containerName: 'c1',
    },
    {
      jid: 'local:two',
      name: 'two',
      folder: 'local-two',
      active: true,
      status: 'running',
      sessionId: 's2',
      containerName: 'c2',
      mounts: ['/repo'],
    },
  ];

  const deps = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    listAgents: vi.fn(() => agents),
    createAgent: vi.fn((input: any) => ({
      created: true,
      agent: {
        jid: 'local:new',
        name: input.name,
        folder: `local-${input.name}`,
        active: false,
      },
    })),
    deleteAgent: vi.fn((query: string) =>
      query === 'two' ? { agent: agents[1] } : null,
    ),
    resolveAgent: vi.fn(
      (query: string) =>
        agents.find(
          (agent) => agent.name === query || agent.folder === query,
        ) || null,
    ),
  };

  beforeEach(() => {
    storeState.messages = [];
    storeState.completedMessages = [];
    storeState.context = null;
    storeState.disposed = false;
    storeState.flushCount = 0;
    inkState.mountedProps = null;
    inkState.subscribedHandler = null;
    inkState.unmount.mockClear();
    deps.onMessage.mockClear();
    deps.onChatMetadata.mockClear();
    deps.listAgents.mockClear();
    deps.createAgent.mockClear();
    deps.deleteAgent.mockClear();
    deps.resolveAgent.mockClear();
  });

  it('connects, selects initial agent, and renders streaming events', async () => {
    const channel = new TerminalChannel(deps as any);
    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(channel.ownsJid('local:one')).toBe(true);
    expect(channel.ownsJid('tg:one')).toBe(false);
    expect(storeState.context).toMatchObject({
      agentLabel: 'local-one',
      status: 'idle',
      sessionId: 's1',
      containerName: 'c1',
    });

    await channel.handleStreamEvent('local:one', {
      type: 'thinking',
      timestamp: 't1',
      data: { content: 'a'.repeat(220) },
    } as any);
    await channel.handleStreamEvent('local:one', {
      type: 'tool_start',
      timestamp: 't2',
      data: { name: 'Read' },
    } as any);
    await channel.handleStreamEvent('local:one', {
      type: 'tool_complete',
      timestamp: 't3',
      data: { name: 'Read', duration: 12 },
    } as any);
    await channel.handleStreamEvent('local:one', {
      type: 'decision',
      timestamp: 't3b',
      data: {
        description: 'Container startup',
        choice: 'Workspace initialized',
      },
    } as any);
    await channel.handleStreamEvent('local:one', {
      type: 'error',
      timestamp: 't4',
      data: { message: 'bad' },
    } as any);

    expect(storeState.messages.some((m) => m.text === 'Starting: Read')).toBe(
      true,
    );
    expect(storeState.messages.some((m) => m.text === '✓ Read (12ms)')).toBe(
      true,
    );
    expect(
      storeState.messages.some(
        (m) => m.text === 'Container startup: Workspace initialized',
      ),
    ).toBe(true);
    expect(
      storeState.messages.some((m) => m.tone === 'error' && m.text === 'bad'),
    ).toBe(true);
  });

  it('handles stream slash commands from raw input', async () => {
    const channel = new TerminalChannel(deps as any);
    await channel.connect();

    await inkState.mountedProps.onSubmit('/show-thinking off');
    await inkState.mountedProps.onSubmit('/stream-status');

    expect(
      storeState.messages.some((m) => m.text === 'Thinking display: off'),
    ).toBe(true);
    expect(
      storeState.messages.some(
        (m) =>
          typeof m.text === 'string' &&
          m.text.includes('Streaming Configuration:'),
      ),
    ).toBe(true);
  });

  it('routes direct messages and assistant events through ink store', async () => {
    const channel = new TerminalChannel(deps as any);
    await channel.connect();

    await channel.sendMessage('local:one', 'hello back');
    await channel.sendAgentEvent('local:one', {
      type: 'assistant',
      text: 'partial',
      replace: true,
    } as AgentStreamEvent);
    await channel.sendAgentEvent('local:one', {
      type: 'status',
      text: 'working',
    } as AgentStreamEvent);

    expect(storeState.completedMessages.at(-1)).toMatchObject({
      label: 'agent:one',
      text: 'hello back',
      tone: 'agent',
    });
    expect(
      storeState.messages.some(
        (m) => m.label === 'agent:one' && m.text === 'partial',
      ),
    ).toBe(true);
    expect(
      storeState.messages.some(
        (m) => m.label === 'status:one' && m.text === 'working',
      ),
    ).toBe(true);
  });

  it('submits normal input and command input through mounted handlers', async () => {
    const channel = new TerminalChannel(deps as any);
    await channel.connect();

    await inkState.mountedProps.onSubmit('hello agent');
    expect(deps.onChatMetadata).toHaveBeenCalledWith(
      'local:one',
      expect.any(String),
      'one',
      'terminal',
      false,
    );
    expect(deps.onMessage).toHaveBeenCalledWith(
      'local:one',
      expect.objectContaining({ content: 'hello agent', sender_name: 'You' }),
    );

    await inkState.mountedProps.onSubmit('/switch two');
    expect(
      storeState.messages.some((m) => m.text === 'Attached to two (local-two)'),
    ).toBe(true);

    await inkState.mountedProps.onSubmit('/send two background task');
    expect(deps.onMessage).toHaveBeenCalledWith(
      'local:two',
      expect.objectContaining({ content: 'background task' }),
    );
  });

  it('handles new, agents, current, delete, unknown, and missing agent cases', async () => {
    const channel = new TerminalChannel({
      ...deps,
      listAgents: vi.fn(() => []),
      resolveAgent: vi.fn(() => null),
      deleteAgent: vi.fn(() => null),
    } as any);
    await channel.connect();

    await inkState.mountedProps.onSubmit('hello?');
    expect(
      storeState.messages.some((m) => m.text.includes('No agent selected.')),
    ).toBe(true);

    await inkState.mountedProps.onSubmit('/agents');
    expect(
      storeState.messages.some((m) => m.text.includes('No local agents.')),
    ).toBe(true);

    await inkState.mountedProps.onSubmit('/current');
    expect(
      storeState.messages.some((m) => m.text === 'No agent attached.'),
    ).toBe(true);

    await inkState.mountedProps.onSubmit('/new scout --mount /repo --rw');
    expect(
      storeState.messages.some(
        (m) => m.text === 'Created agent scout (local-scout)',
      ),
    ).toBe(true);

    await inkState.mountedProps.onSubmit('/switch missing');
    await inkState.mountedProps.onSubmit('/send missing hi');
    await inkState.mountedProps.onSubmit('/delete missing');
    await inkState.mountedProps.onSubmit('/wat');

    expect(
      storeState.messages.filter((m) => m.tone === 'error').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('disconnects and disposes ink resources', async () => {
    const channel = new TerminalChannel(deps as any);
    await channel.connect();
    await channel.disconnect();

    expect(channel.isConnected()).toBe(false);
    expect(inkState.unmount).toHaveBeenCalled();
    expect(storeState.disposed).toBe(true);
  });
});

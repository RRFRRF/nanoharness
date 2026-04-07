import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => {
  const existingPaths = new Set<string>([
    '/workspace/group',
    '/workspace/ipc',
    '/workspace/project',
    '/workspace/extra',
    '/workspace/group/CLAUDE.md',
    '/workspace/project/CLAUDE.md',
    '/workspace/ipc/current_tasks.json',
  ]);

  return {
    existingPaths,
    existsSync: vi.fn((target: string) => existingPaths.has(target)),
    readFileSync: vi.fn((target: string) => {
      if (target === '/workspace/group/AGENTS.md') {
        return 'group agents memory';
      }
      if (target === '/workspace/project/AGENTS.md') {
        return 'project agents memory';
      }
      if (target === '/workspace/group/CLAUDE.md') {
        return 'group memory';
      }
      if (target === '/workspace/project/CLAUDE.md') {
        return 'project memory';
      }
      if (target === '/workspace/ipc/current_tasks.json') {
        return JSON.stringify([
          {
            id: 'task-1',
            groupFolder: 'local-test',
            prompt: 'daily reminder',
            schedule_type: 'cron',
            schedule_value: '0 9 * * *',
            status: 'active',
            next_run: 'tomorrow',
          },
          {
            id: 'task-2',
            groupFolder: 'other-group',
            prompt: 'other',
            schedule_type: 'interval',
            schedule_value: '300000',
            status: 'paused',
            next_run: 'later',
          },
        ]);
      }
      return '';
    }),
    readdirSync: vi.fn((target: string) => {
      if (target === '/workspace/group') {
        return ['CLAUDE.md', 'outputs'];
      }
      if (target === '/workspace/ipc') {
        return ['input', 'messages', 'tasks'];
      }
      if (target === '/workspace/project') {
        return ['README.md', 'src'];
      }
      if (target === '/workspace/extra') {
        return ['mounted-repo'];
      }
      return [];
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
    cpSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(() => ({
      isDirectory: () => true,
    })),
  };
});

const mcpState = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  listTools: vi.fn(async () => ({ tools: [] })),
  callTool: vi.fn(async () => ({ content: [] })),
  close: vi.fn(async () => {}),
}));

const toolState = vi.hoisted(() => ({
  registrations: [] as Array<{
    fn: (...args: any[]) => any;
    meta: Record<string, any>;
  }>,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      ...fsState,
    },
  };
});

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: class ChatAnthropic {},
}));

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class ChatOpenAI {},
}));

vi.mock('@langchain/core/tools', () => ({
  tool: vi.fn((fn: (...args: any[]) => any, meta: Record<string, any>) => {
    toolState.registrations.push({ fn, meta });
    return { invoke: fn, ...meta };
  }),
}));

vi.mock('@langchain/langgraph-checkpoint-sqlite', () => ({
  SqliteSaver: {
    fromConnString: vi.fn(),
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mcpState.connect;
    listTools = mcpState.listTools;
    callTool = mcpState.callTool;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockTransport {
    stderr = { on: vi.fn() };
    close = mcpState.close;
  },
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolResultSchema: {},
  CompatibilityCallToolResultSchema: {},
}));

vi.mock('deepagents', () => ({
  createDeepAgent: vi.fn(),
  LocalShellBackend: {
    create: vi.fn(),
  },
}));

describe('agent runner runtime diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    toolState.registrations = [];
    mcpState.connect.mockClear();
    mcpState.listTools.mockClear();
    mcpState.callTool.mockClear();
    fsState.writeFileSync.mockClear();
    fsState.existingPaths.clear();
    for (const target of [
      '/workspace/group',
      '/workspace/ipc',
      '/workspace/project',
      '/workspace/extra',
      '/workspace/group/CLAUDE.md',
      '/workspace/project/CLAUDE.md',
      '/workspace/ipc/current_tasks.json',
    ]) {
      fsState.existingPaths.add(target);
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function loadRuntimeModule() {
    const modPath = '../container/agent-runner/src/index.ts';
    return (await import(modPath)) as {
      buildRuntimePromptBundle: (
        basePrompt: string,
        containerInput: {
          prompt: string;
          groupFolder: string;
          chatJid: string;
          isMain: boolean;
          isScheduledTask?: boolean;
        },
        options?: {
          sessionId?: string;
          resumeAt?: string;
          pendingIpcMessages?: string[];
        },
      ) => {
        runtimePrompt: string;
        snapshot: {
          pendingIpcMessages: string[];
          workspaceManifestPath: string;
          memories: {
            group: {
              path: string;
              included: boolean;
              content: string | null;
            };
            global: {
              path: string;
              included: boolean;
              content: string | null;
            };
            project: {
              path: string;
              included: boolean;
              content: string | null;
            };
          };
        };
      };
      buildWorkspaceManifest: (containerInput: {
        prompt: string;
        groupFolder: string;
        chatJid: string;
        isMain: boolean;
      }) => {
        writableRoot: string;
        requiredOutputRoot: string;
        rules: string[];
        mounts: Array<{
          path: string;
          mode: string;
          entries?: string[];
        }>;
      };
      buildDeepAgentsMemoryPaths: (containerInput: {
        isMain: boolean;
      }) => string[];
      getDeepAgentName: (containerInput: {
        assistantName?: string;
        isMain: boolean;
      }) => string;
      getAutoContinueConfig: (env?: NodeJS.ProcessEnv) => {
        limit: number;
        allowScheduledTasks: boolean;
      };
      getAutoContinueReason: (
        queryResult: {
          closedDuringQuery: boolean;
          lastAssistantText: string;
          lastResultText: string | null;
          lastResultSubtype?: string;
          sawStatusEvent: boolean;
        },
        isScheduledTask: boolean,
        autoContinueCount: number,
        config?: {
          limit: number;
          allowScheduledTasks: boolean;
        },
      ) => string | null;
      parseConfiguredMcpServers: (raw?: string) => Array<{
        name: string;
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }>;
      renderMcpToolResult: (result: Record<string, unknown>) => string;
      validateScheduleValue: (
        scheduleType: 'cron' | 'interval' | 'once',
        scheduleValue: string,
      ) => string | null;
      createNanoClawTools: (
        containerInput: {
          prompt: string;
          groupFolder: string;
          chatJid: string;
          isMain: boolean;
        },
        emitStatus: (text: string, replace?: boolean) => void,
      ) => any[];
      loadConfiguredMcpTools: (
        emitStatus: (text: string, replace?: boolean) => void,
      ) => Promise<{
        tools: any[];
        cleanup: () => Promise<void>;
        servers: Array<{ name: string }>;
      }>;
      buildPredefinedSubagents: (options: {
        provider: 'anthropic' | 'openai';
        primaryModelName: string;
        skills: string[];
        tools: any[];
      }) => Array<{
        name: string;
        description: string;
        systemPrompt: string;
        tools: any[];
        skills: string[];
        model: unknown;
      }>;
      buildDelegationPolicyLines: () => string[];
      extractStreamChunkText: (chunk: unknown) => string;
      normalizeNativeStreamChunk: (part: unknown) => {
        namespace: string[];
        mode: string;
        data: unknown;
        metadata?: unknown;
      };
      mapNativeStreamChunkToBridgeEvents: (
        part: unknown,
      ) => Array<{
        type: string;
        key?: string;
        name?: string;
        input?: unknown;
        message?: string;
        percent?: number;
        result?: unknown;
        description?: string;
        choice?: string;
        text?: string;
      }>;
      shouldUseNativeStreaming: (agent: {
        invoke: (input: unknown, config?: unknown) => Promise<unknown>;
        stream?: (
          input: unknown,
          config?: unknown,
        ) => Promise<AsyncIterable<unknown>>;
      }) => boolean;
      extractInterruptPayload: (result: unknown) => unknown | null;
      formatHumanInLoopPrompt: (interrupt: unknown) => string;
      parseHumanInLoopResumeInput: (
        message: string,
        interrupt: unknown,
      ) => unknown;
      parseInterruptOnConfig: (
        raw?: string,
      ) =>
        | Record<string, boolean | { allowedDecisions?: string[] }>
        | undefined;
    };
  }

  it('builds a runtime prompt bundle with injected memories and diagnostics', async () => {
    const mod = await loadRuntimeModule();

    const bundle = mod.buildRuntimePromptBundle(
      '<context timezone="Asia/Shanghai" />\n<messages>\n<message sender="user" time="2026-04-01 10:00">test</message>\n</messages>',
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: true,
      },
      {
        sessionId: 'session-1',
        resumeAt: 'checkpoint-1',
        pendingIpcMessages: ['follow-up message'],
      },
    );

    expect(bundle.runtimePrompt).toContain(
      'Write all new files, screenshots, reports, logs, and generated outputs under /workspace/group.',
    );
    expect(bundle.runtimePrompt).toContain(
      'NanoHarness platform orchestration tools remain available as mcp__nanoclaw__* and should be used only for messaging, scheduling, and group management.',
    );
    expect(bundle.runtimePrompt).toContain(
      'When progress depends on the user, use mcp__nanoclaw__ask_user to pause natively and wait for approval, confirmation, codes, or additional instructions.',
    );
    expect(bundle.runtimePrompt).toContain(
      'Persist intermediate artifacts to disk for long workflows instead of emitting huge inline outputs.',
    );
    expect(bundle.runtimePrompt).not.toContain(
      'Deep Agents compatibility mapping for older Claude-style skills:',
    );
    expect(bundle.runtimePrompt).not.toContain(
      'For multi-step or stateful work, create and maintain a todo list with write_todos/read_todos.',
    );
    expect(bundle.runtimePrompt).toContain(
      'Available predefined subagents: researcher for investigation, coder for implementation, reviewer for findings-first review.',
    );
    expect(bundle.runtimePrompt).toContain(
      'Delegate to researcher for codebase investigation or option comparison, coder for concrete implementation, and reviewer for regression-focused critique.',
    );
    expect(bundle.runtimePrompt).toContain(
      'When delegating, prefer the exact task names researcher, coder, or reviewer before falling back to general-purpose delegation.',
    );
    expect(bundle.runtimePrompt).toContain('<group_memory>');
    expect(bundle.runtimePrompt).toContain('group memory');
    expect(bundle.runtimePrompt).toContain('<project_memory>');
    expect(bundle.runtimePrompt).toContain('project memory');
    expect(bundle.snapshot.pendingIpcMessages).toEqual(['follow-up message']);
    expect(bundle.snapshot.workspaceManifestPath).toBe(
      '/workspace/group/.nanoclaw/workspace-manifest.json',
    );
  });

  it('can switch CLAUDE.md files to native deepagents memory paths', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.buildDeepAgentsMemoryPaths({
        isMain: true,
      }),
    ).toEqual([
      './group/CLAUDE.md',
      './project/CLAUDE.md',
    ]);

    process.env.NANOCLAW_USE_NATIVE_MEMORY = 'true';

    const bundle = mod.buildRuntimePromptBundle(
      '<messages>\n<message sender="user">test</message>\n</messages>',
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: true,
      },
      {
        sessionId: 'session-1',
      },
    );

    expect(bundle.runtimePrompt).not.toContain('<group_memory>');
    expect(bundle.runtimePrompt).not.toContain('<project_memory>');

    delete process.env.NANOCLAW_USE_NATIVE_MEMORY;
  });

  it('prefers AGENTS.md over CLAUDE.md for native and prompt memory resolution', async () => {
    const mod = await loadRuntimeModule();

    fsState.existingPaths.add('/workspace/group/AGENTS.md');
    fsState.existingPaths.add('/workspace/project/AGENTS.md');

    expect(
      mod.buildDeepAgentsMemoryPaths({
        isMain: true,
      }),
    ).toEqual([
      './group/AGENTS.md',
      './project/AGENTS.md',
    ]);

    const bundle = mod.buildRuntimePromptBundle(
      '<messages>\n<message sender="user">test</message>\n</messages>',
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: true,
      },
      {
        sessionId: 'session-1',
      },
    );

    expect(bundle.runtimePrompt).toContain('group agents memory');
    expect(bundle.runtimePrompt).toContain('project agents memory');
    expect(bundle.snapshot.memories.group.path).toBe('/workspace/group/AGENTS.md');
    expect(bundle.snapshot.memories.project.path).toBe(
      '/workspace/project/AGENTS.md',
    );
  });

  it('builds a workspace manifest centered on the group workspace', async () => {
    const mod = await loadRuntimeModule();

    const manifest = mod.buildWorkspaceManifest({
      prompt: 'ignored',
      groupFolder: 'local-test',
      chatJid: 'local:test',
      isMain: true,
    });

    expect(manifest.writableRoot).toBe('/workspace/group');
    expect(manifest.requiredOutputRoot).toBe('/workspace/group/outputs');
    expect(manifest.rules).toContain(
      'Write all new artifacts under /workspace/group.',
    );
    expect(manifest.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/workspace/group',
          mode: 'rw',
          entries: ['CLAUDE.md', 'outputs'],
        }),
        expect.objectContaining({
          path: '/workspace/extra',
          mode: 'host-configured',
          entries: ['mounted-repo'],
        }),
      ]),
    );
  });

  it('derives a stable deep agent name from assistant identity or role', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.getDeepAgentName({
        assistantName: 'Andy',
        isMain: true,
      }),
    ).toBe('Andy');

    expect(
      mod.getDeepAgentName({
        isMain: true,
      }),
    ).toBe('nanoharness-main');

    expect(
      mod.getDeepAgentName({
        isMain: false,
      }),
    ).toBe('nanoharness-agent');
  });

  it('reads auto-continue config from env and can include scheduled tasks', async () => {
    const mod = await loadRuntimeModule();

    const config = mod.getAutoContinueConfig({
      NANOCLAW_AUTO_CONTINUE_LIMIT: '9',
      NANOCLAW_AUTO_CONTINUE_SCHEDULED: 'true',
    } as NodeJS.ProcessEnv);

    expect(config).toEqual({
      limit: 9,
      allowScheduledTasks: true,
    });

    const reason = mod.getAutoContinueReason(
      {
        closedDuringQuery: false,
        lastAssistantText: 'I will start by checking the repository.',
        lastResultText: null,
        lastResultSubtype: 'success',
        sawStatusEvent: false,
      },
      true,
      0,
      config,
    );

    expect(reason).toBe('planning output emitted without a final result');
  });

  it('parses configured MCP stdio servers from env JSON', async () => {
    const mod = await loadRuntimeModule();

    const servers = mod.parseConfiguredMcpServers(
      JSON.stringify([
        {
          name: 'playwright',
          command: 'node',
          args: ['./mcp/playwright.js'],
          cwd: '/workspace/group',
          env: {
            FOO: 'bar',
          },
        },
      ]),
    );

    expect(servers).toEqual([
      {
        name: 'playwright',
        command: 'node',
        args: ['./mcp/playwright.js'],
        cwd: '/workspace/group',
        env: {
          FOO: 'bar',
        },
      },
    ]);
  });

  it('ignores invalid MCP server entries and bad JSON', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.parseConfiguredMcpServers(
        JSON.stringify([
          null,
          { name: '', command: 'node' },
          {
            name: 'ok',
            command: 'node',
            args: ['server.js'],
            env: { A: '1', B: 2 },
          },
        ]),
      ),
    ).toEqual([
      {
        name: 'ok',
        command: 'node',
        args: ['server.js'],
        env: { A: '1' },
      },
    ]);

    expect(mod.parseConfiguredMcpServers('{bad json')).toEqual([]);
  });

  it('parses interruptOn config from JSON', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.parseInterruptOnConfig(
        JSON.stringify({
          write_file: true,
          edit_file: {
            allowedDecisions: ['approve', 'reject'],
          },
          ignored_tool: 'nope',
        }),
      ),
    ).toEqual({
      write_file: true,
      edit_file: {
        allowedDecisions: ['approve', 'reject'],
      },
    });

    expect(mod.parseInterruptOnConfig('{bad json')).toBeUndefined();
  });

  it('validates auto-continue reasons across delegation, status, and limits', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.getAutoContinueReason(
        {
          closedDuringQuery: false,
          lastAssistantText: '',
          lastResultText: '{"tool":"Agent","subagent_type":"Explore"}',
          lastResultSubtype: 'success',
          sawStatusEvent: false,
        },
        false,
        0,
        { limit: 3, allowScheduledTasks: true },
      ),
    ).toBe('delegation envelope emitted without execution');

    expect(
      mod.getAutoContinueReason(
        {
          closedDuringQuery: false,
          lastAssistantText: '',
          lastResultText: null,
          lastResultSubtype: 'success',
          sawStatusEvent: true,
        },
        false,
        0,
        { limit: 3, allowScheduledTasks: true },
      ),
    ).toBe('tooling status emitted without a final result');

    expect(
      mod.getAutoContinueReason(
        {
          closedDuringQuery: false,
          lastAssistantText: 'done',
          lastResultText: 'final answer',
          lastResultSubtype: 'error',
          sawStatusEvent: false,
        },
        false,
        0,
        { limit: 3, allowScheduledTasks: true },
      ),
    ).toBeNull();

    expect(
      mod.getAutoContinueReason(
        {
          closedDuringQuery: false,
          lastAssistantText: 'I will continue',
          lastResultText: null,
          lastResultSubtype: 'success',
          sawStatusEvent: false,
        },
        false,
        3,
        { limit: 3, allowScheduledTasks: true },
      ),
    ).toBeNull();
  });

  it('renders MCP tool results from text, links, and structured content', async () => {
    const mod = await loadRuntimeModule();

    const rendered = mod.renderMcpToolResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'resource_link', name: 'doc', uri: 'https://example.com' },
        { type: 'image' },
      ],
      structuredContent: { ok: true },
    });

    expect(rendered).toContain('hello');
    expect(rendered).toContain('doc: https://example.com');
    expect(rendered).toContain('[image]');
    expect(rendered).toContain('"ok": true');
  });

  it('returns fallback text for empty MCP tool results and errors', async () => {
    const mod = await loadRuntimeModule();

    expect(mod.renderMcpToolResult({} as any)).toBe('MCP tool completed.');
    expect(mod.renderMcpToolResult({ isError: true } as any)).toBe(
      'MCP tool returned an error.',
    );
  });

  it('validates schedule values across cron interval and once modes', async () => {
    const mod = await loadRuntimeModule();

    expect(mod.validateScheduleValue('cron', '0 9 * * *')).toBeNull();
    expect(mod.validateScheduleValue('interval', '300000')).toBeNull();
    expect(mod.validateScheduleValue('once', '2026-04-02T10:00:00')).toBeNull();
    expect(mod.validateScheduleValue('interval', '-1')).toContain(
      'Invalid interval',
    );
    expect(mod.validateScheduleValue('once', '2026-04-02T10:00:00Z')).toContain(
      'without timezone suffix',
    );
  });

  it('creates NanoClaw tools that emit status and write IPC payloads', async () => {
    const mod = await loadRuntimeModule();
    const emitStatus = vi.fn();

    const tools = mod.createNanoClawTools(
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: false,
      },
      emitStatus,
    );

    const askUserTool = tools.find(
      (tool) => tool.name === 'mcp__nanoclaw__ask_user',
    );
    const sendMessageTool = tools.find(
      (tool) => tool.name === 'mcp__nanoclaw__send_message',
    );
    const listTasksTool = tools.find(
      (tool) => tool.name === 'mcp__nanoclaw__list_tasks',
    );
    const scheduleTaskTool = tools.find(
      (tool) => tool.name === 'mcp__nanoclaw__schedule_task',
    );

    await sendMessageTool.invoke({
      text: 'progress update',
      sender: 'Researcher',
    });
    const tasksText = await listTasksTool.invoke({});
    await scheduleTaskTool.invoke({
      prompt: 'Do thing',
      schedule_type: 'interval',
      schedule_value: '60000',
    });

    expect(askUserTool).toBeTruthy();
    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__nanoclaw__send_message: progress update',
    );
    expect(tasksText).toContain('task-1');
    expect(tasksText).not.toContain('task-2');
    expect(fsState.writeFileSync).toHaveBeenCalled();
  });

  it('creates NanoClaw task management tools for main-only and update flows', async () => {
    const mod = await loadRuntimeModule();
    const emitStatus = vi.fn();

    const memberTools = mod.createNanoClawTools(
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: false,
      },
      emitStatus,
    );
    const mainTools = mod.createNanoClawTools(
      {
        prompt: 'ignored',
        groupFolder: 'main-group',
        chatJid: 'main:test',
        isMain: true,
      },
      emitStatus,
    );

    const pauseTaskTool = memberTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__pause_task',
    );
    const resumeTaskTool = memberTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__resume_task',
    );
    const cancelTaskTool = memberTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__cancel_task',
    );
    const updateTaskTool = memberTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__update_task',
    );
    const registerGroupTool = memberTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__register_group',
    );
    const mainScheduleTaskTool = mainTools.find(
      (tool) => tool.name === 'mcp__nanoclaw__schedule_task',
    );

    await pauseTaskTool.invoke({ task_id: 'task-1' });
    await resumeTaskTool.invoke({ task_id: 'task-1' });
    await cancelTaskTool.invoke({ task_id: 'task-1' });
    await updateTaskTool.invoke({
      task_id: 'task-1',
      prompt: 'updated',
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
    });
    await expect(
      registerGroupTool.invoke({
        jid: 'local:new',
        name: 'New Group',
        folder: 'local-new',
        trigger: '@Andy',
      }),
    ).rejects.toThrow('Only the main group can register new groups.');
    await mainScheduleTaskTool.invoke({
      prompt: 'Cross-group task',
      schedule_type: 'interval',
      schedule_value: '60000',
      target_group_jid: 'local:other',
    });

    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__nanoclaw__pause_task: task-1',
    );
    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__nanoclaw__resume_task: task-1',
    );
    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__nanoclaw__cancel_task: task-1',
    );
    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__nanoclaw__update_task: task-1',
    );
    expect(fsState.writeFileSync).toHaveBeenCalled();
  });

  it('propagates MCP tool errors and skips failed server initialization', async () => {
    const mod = await loadRuntimeModule();
    const emitStatus = vi.fn();

    mcpState.connect.mockRejectedValueOnce(new Error('spawn failed'));
    mcpState.listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'failing-tool',
          description: 'Fails loudly',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    } as any);
    mcpState.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'boom' } as any],
    } as any);

    process.env.NANOCLAW_MCP_SERVERS_JSON = JSON.stringify([
      { name: 'broken', command: 'node', args: ['broken.js'] },
      { name: 'docs', command: 'node', args: ['server.js'] },
    ]);

    const loaded = await mod.loadConfiguredMcpTools(emitStatus);
    expect(loaded.tools).toHaveLength(1);

    await expect(loaded.tools[0].invoke({})).rejects.toThrow('boom');
    expect(emitStatus).toHaveBeenCalledWith(
      'mcp__docs__failing-tool: executing',
    );
  });

  it('builds predefined subagents with isolated skills by default and without NanoClaw orchestration tools', async () => {
    const mod = await loadRuntimeModule();

    process.env.NANOCLAW_SUBAGENT_REVIEWER_MODEL = 'claude-haiku-4-5';

    const subagents = mod.buildPredefinedSubagents({
      provider: 'anthropic',
      primaryModelName: 'claude-sonnet-4-5',
      skills: ['/workspace/group/.deepagents-skills'],
      tools: [
        { name: 'mcp__nanoclaw__ask_user' },
        { name: 'mcp__nanoclaw__send_message' },
        { name: 'mcp__nanoclaw__schedule_task' },
        { name: 'mcp__docs__lookup' },
        { name: 'mcp__repo__write_patch' },
      ],
    });

    expect(subagents.map((subagent) => subagent.name)).toEqual([
      'researcher',
      'coder',
      'reviewer',
    ]);
    expect(subagents.every((subagent) => subagent.skills.length === 0)).toBe(
      true,
    );
    expect(subagents.map((subagent) => subagent.tools)).toEqual([
      [{ name: 'mcp__nanoclaw__ask_user' }, { name: 'mcp__docs__lookup' }],
      [
        { name: 'mcp__nanoclaw__ask_user' },
        { name: 'mcp__docs__lookup' },
        { name: 'mcp__repo__write_patch' },
      ],
      [{ name: 'mcp__nanoclaw__ask_user' }, { name: 'mcp__docs__lookup' }],
    ]);
    expect(subagents[0].systemPrompt).toContain('researcher subagent');
    expect(subagents[1].systemPrompt).toContain('exact task identity coder');
    expect(subagents[2].systemPrompt).toContain(
      'Return findings first, ordered by severity',
    );

    delete process.env.NANOCLAW_SUBAGENT_REVIEWER_MODEL;
  });

  it('can opt predefined subagents into main or role-specific skills explicitly', async () => {
    const mod = await loadRuntimeModule();

    process.env.NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS = 'true';
    process.env.NANOCLAW_SUBAGENT_REVIEWER_SKILLS =
      '/skills/reviewer,/skills/shared';

    const subagents = mod.buildPredefinedSubagents({
      provider: 'anthropic',
      primaryModelName: 'claude-sonnet-4-5',
      skills: ['/workspace/group/.deepagents-skills'],
      tools: [{ name: 'mcp__docs__lookup' }],
    });

    expect(subagents[0].skills).toEqual(['/workspace/group/.deepagents-skills']);
    expect(subagents[1].skills).toEqual(['/workspace/group/.deepagents-skills']);
    expect(subagents[2].skills).toEqual([
      '/workspace/group/.deepagents-skills',
      '/skills/reviewer',
      '/skills/shared',
    ]);

    delete process.env.NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS;
    delete process.env.NANOCLAW_SUBAGENT_REVIEWER_SKILLS;
  });

  it('can disable predefined subagents with an environment flag', async () => {
    const mod = await loadRuntimeModule();

    process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS = 'false';

    const subagents = mod.buildPredefinedSubagents({
      provider: 'anthropic',
      primaryModelName: 'claude-sonnet-4-5',
      skills: ['/workspace/group/.deepagents-skills'],
      tools: [{ name: 'mcp__docs__lookup' }],
    });

    expect(subagents).toEqual([]);

    delete process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS;
  });

  it('switches delegation guidance when predefined subagents are disabled', async () => {
    const mod = await loadRuntimeModule();

    process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS = 'false';

    expect(mod.buildDelegationPolicyLines()).toEqual([
      'Use task delegation only when extra context isolation is clearly helpful.',
      'Prefer solving straightforward work in the main agent before delegating.',
    ]);

    const bundle = mod.buildRuntimePromptBundle(
      '<messages>\n</messages>',
      {
        prompt: 'ignored',
        groupFolder: 'local-test',
        chatJid: 'local:test',
        isMain: true,
      },
      {
        sessionId: 'session-1',
      },
    );

    expect(bundle.runtimePrompt).not.toContain(
      'Available predefined subagents: researcher for investigation, coder for implementation, reviewer for findings-first review.',
    );
    expect(bundle.runtimePrompt).toContain(
      'Use task delegation only when extra context isolation is clearly helpful.',
    );

    delete process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS;
  });

  it('extracts useful text from generic native stream chunks', async () => {
    const mod = await loadRuntimeModule();

    expect(mod.extractStreamChunkText('hello')).toBe('hello');
    expect(
      mod.extractStreamChunkText({
        text: 'partial answer',
      }),
    ).toBe('partial answer');
    expect(
      mod.extractStreamChunkText({
        content: [{ text: 'chunk ' }, { text: 'output' }],
      }),
    ).toBe('chunk output');
    expect(
      mod.extractStreamChunkText({
        messages: [{ role: 'assistant', content: 'final answer' }],
      }),
    ).toBe('final answer');
  });

  it('normalizes native stream tuples with namespace and explicit mode', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.normalizeNativeStreamChunk([
        ['tools:call_abc123'],
        'messages',
        [{ text: 'hello' }, { langgraph_node: 'model_request' }],
      ]),
    ).toEqual({
      namespace: ['tools:call_abc123'],
      mode: 'messages',
      data: [{ text: 'hello' }, { langgraph_node: 'model_request' }],
    });
  });

  it('maps updates stream chunks into decision and tool lifecycle bridge events', async () => {
    const mod = await loadRuntimeModule();

    const events = mod.mapNativeStreamChunkToBridgeEvents([
      [],
      'updates',
      {
        model_request: {
          messages: [
            {
              tool_calls: [
                {
                  id: 'call_task_1',
                  name: 'task',
                  args: { subagent_type: 'researcher' },
                },
              ],
            },
          ],
        },
        tools: {
          messages: [
            {
              type: 'tool',
              tool_call_id: 'call_task_1',
              name: 'task',
              content: 'subagent result',
            },
          ],
        },
      },
    ]);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'decision',
          description: 'Native stream update',
          choice: 'model_request',
        }),
        expect.objectContaining({
          type: 'decision',
          description: 'Native stream update',
          choice: 'tools',
        }),
        expect.objectContaining({
          type: 'tool_start',
          key: 'main:call_task_1',
          name: 'task',
          input: { subagent_type: 'researcher' },
        }),
        expect.objectContaining({
          type: 'tool_complete',
          key: 'main:call_task_1',
          name: 'task',
          result: 'subagent result',
        }),
      ]),
    );
  });

  it('maps messages stream chunks into tool and content bridge events', async () => {
    const mod = await loadRuntimeModule();

    const toolEvents = mod.mapNativeStreamChunkToBridgeEvents([
      ['tools:call_abc123'],
      'messages',
      [
        {
          tool_call_chunks: [
            {
              id: 'tool_1',
              name: 'grep',
              args: '{"pattern":"TODO"}',
            },
          ],
        },
        {
          langgraph_node: 'tools',
        },
      ],
    ]);

    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'decision',
          choice: 'tools',
        }),
        expect.objectContaining({
          type: 'tool_start',
          key: 'tools:call_abc123:tool_1',
          name: 'grep',
          input: { pattern: 'TODO' },
        }),
        expect.objectContaining({
          type: 'tool_progress',
          key: 'tools:call_abc123:tool_1',
          message: '{"pattern":"TODO"}',
        }),
      ]),
    );

    const contentEvents = mod.mapNativeStreamChunkToBridgeEvents([
      [],
      'messages',
      [
        {
          text: 'final token',
        },
        {
          langgraph_node: 'model_request',
        },
      ],
    ]);

    expect(contentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'decision',
          choice: 'model_request',
        }),
        expect.objectContaining({
          type: 'content',
          text: 'final token',
        }),
      ]),
    );
  });

  it('maps custom stream chunks into tool progress bridge events', async () => {
    const mod = await loadRuntimeModule();

    const events = mod.mapNativeStreamChunkToBridgeEvents([
      ['tools:call_abc123'],
      'custom',
      {
        status: 'analyzing',
        progress: 50,
      },
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_progress',
        key: 'tools:call_abc123:custom',
        name: 'tools:call_abc123',
        message: 'analyzing',
        percent: 50,
      }),
    ]);
  });

  it('uses the native streaming path only when explicitly enabled and supported', async () => {
    const mod = await loadRuntimeModule();

    process.env.NANOCLAW_USE_NATIVE_STREAMING = 'true';

    expect(
      mod.shouldUseNativeStreaming({
        invoke: async () => ({}),
        stream: async () =>
          ({
            async *[Symbol.asyncIterator]() {},
          }) as AsyncIterable<unknown>,
      }),
    ).toBe(true);
    expect(
      mod.shouldUseNativeStreaming({
        invoke: async () => ({}),
      }),
    ).toBe(false);

    delete process.env.NANOCLAW_USE_NATIVE_STREAMING;
  });

  it('extracts interrupt payloads from LangGraph-style results', async () => {
    const mod = await loadRuntimeModule();

    expect(
      mod.extractInterruptPayload({
        __interrupt__: [
          {
            value: {
              message: 'Need approval',
            },
          },
        ],
      }),
    ).toEqual({
      message: 'Need approval',
    });
  });

  it('formats action-review interrupts and parses approve/edit replies', async () => {
    const mod = await loadRuntimeModule();

    const interrupt = {
      actionRequests: [
        {
          name: 'write_file',
          args: {
            path: '/workspace/group/report.md',
          },
        },
      ],
      reviewConfigs: [
        {
          actionName: 'write_file',
          allowedDecisions: ['approve', 'edit', 'reject'],
        },
      ],
    };

    expect(mod.formatHumanInLoopPrompt(interrupt)).toContain(
      'Human review required before the agent can continue.',
    );
    expect(mod.formatHumanInLoopPrompt(interrupt)).toContain(
      'Reply with approve/yes, reject/no, or edit {"field":"value"}.',
    );

    expect(mod.parseHumanInLoopResumeInput('yes', interrupt)).toEqual({
      decisions: [{ type: 'approve' }],
    });

    expect(
      mod.parseHumanInLoopResumeInput(
        'edit {"path":"/workspace/group/approved.md"}',
        interrupt,
      ),
    ).toEqual({
      decisions: [
        {
          type: 'edit',
          editedAction: {
            name: 'write_file',
            args: {
              path: '/workspace/group/approved.md',
            },
          },
        },
      ],
    });
  });

  it('parses multi-action and generic human-in-the-loop resume payloads', async () => {
    const mod = await loadRuntimeModule();

    const actionInterrupt = {
      actionRequests: [
        { name: 'write_file', args: { path: 'a.md' } },
        { name: 'delete_file', args: { path: 'b.md' } },
      ],
      reviewConfigs: [
        {
          actionName: 'write_file',
          allowedDecisions: ['approve', 'reject'],
        },
        {
          actionName: 'delete_file',
          allowedDecisions: ['approve', 'reject'],
        },
      ],
    };

    expect(
      mod.parseHumanInLoopResumeInput('approve\nreject', actionInterrupt),
    ).toEqual({
      decisions: [{ type: 'approve' }, { type: 'reject' }],
    });

    expect(
      mod.parseHumanInLoopResumeInput('{"approved":true,"code":"123456"}', {
        message: 'Need code',
      }),
    ).toEqual({
      approved: true,
      code: '123456',
    });

    expect(
      mod.parseHumanInLoopResumeInput('captcha is 7788', {
        message: 'Need code',
      }),
    ).toEqual({
      response: 'captcha is 7788',
      text: 'captcha is 7788',
      value: 'captcha is 7788',
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => {
  const exists = new Set<string>([
    '/workspace/group',
    '/workspace/ipc',
    '/workspace/project',
    '/workspace/extra',
    '/workspace/group/CLAUDE.md',
    '/workspace/project/CLAUDE.md',
    '/workspace/ipc/current_tasks.json',
  ]);

  return {
    existsSync: vi.fn((target: string) => exists.has(target)),
    readFileSync: vi.fn((target: string) => {
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
  registrations: [] as Array<{ fn: (...args: any[]) => any; meta: Record<string, any> }>,
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
      validateScheduleValue: (scheduleType: 'cron' | 'interval' | 'once', scheduleValue: string) => string | null;
      createNanoClawTools: (
        containerInput: {
          prompt: string;
          groupFolder: string;
          chatJid: string;
          isMain: boolean;
        },
        emitStatus: (text: string, replace?: boolean) => void,
      ) => any[];
      loadConfiguredMcpTools: (emitStatus: (text: string, replace?: boolean) => void) => Promise<{
        tools: any[];
        cleanup: () => Promise<void>;
        servers: Array<{ name: string }>;
      }>;
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
    expect(bundle.runtimePrompt).toContain('<group_memory>');
    expect(bundle.runtimePrompt).toContain('group memory');
    expect(bundle.runtimePrompt).toContain('<project_memory>');
    expect(bundle.runtimePrompt).toContain('project memory');
    expect(bundle.snapshot.pendingIpcMessages).toEqual(['follow-up message']);
    expect(bundle.snapshot.workspaceManifestPath).toBe(
      '/workspace/group/.nanoclaw/workspace-manifest.json',
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
          { name: 'ok', command: 'node', args: ['server.js'], env: { A: '1', B: 2 } },
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
    expect(mod.validateScheduleValue('interval', '-1')).toContain('Invalid interval');
    expect(mod.validateScheduleValue('once', '2026-04-02T10:00:00Z')).toContain('without timezone suffix');
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

    const sendMessageTool = tools.find((tool) => tool.name === 'mcp__nanoclaw__send_message');
    const listTasksTool = tools.find((tool) => tool.name === 'mcp__nanoclaw__list_tasks');
    const scheduleTaskTool = tools.find((tool) => tool.name === 'mcp__nanoclaw__schedule_task');

    await sendMessageTool.invoke({ text: 'progress update', sender: 'Researcher' });
    const tasksText = await listTasksTool.invoke({});
    await scheduleTaskTool.invoke({
      prompt: 'Do thing',
      schedule_type: 'interval',
      schedule_value: '60000',
    });

    expect(emitStatus).toHaveBeenCalledWith('mcp__nanoclaw__send_message: progress update');
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

    const pauseTaskTool = memberTools.find((tool) => tool.name === 'mcp__nanoclaw__pause_task');
    const resumeTaskTool = memberTools.find((tool) => tool.name === 'mcp__nanoclaw__resume_task');
    const cancelTaskTool = memberTools.find((tool) => tool.name === 'mcp__nanoclaw__cancel_task');
    const updateTaskTool = memberTools.find((tool) => tool.name === 'mcp__nanoclaw__update_task');
    const registerGroupTool = memberTools.find((tool) => tool.name === 'mcp__nanoclaw__register_group');
    const mainScheduleTaskTool = mainTools.find((tool) => tool.name === 'mcp__nanoclaw__schedule_task');

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

    expect(emitStatus).toHaveBeenCalledWith('mcp__nanoclaw__pause_task: task-1');
    expect(emitStatus).toHaveBeenCalledWith('mcp__nanoclaw__resume_task: task-1');
    expect(emitStatus).toHaveBeenCalledWith('mcp__nanoclaw__cancel_task: task-1');
    expect(emitStatus).toHaveBeenCalledWith('mcp__nanoclaw__update_task: task-1');
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
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    expect(emitStatus).toHaveBeenCalledWith('mcp__docs__failing-tool: executing');

  });
});
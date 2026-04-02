import { mountTerminalInkApp, TerminalInkStore } from './terminal-ink.js';
import { subscribeTerminalLogs, TerminalLogItem } from './terminal-log-sink.js';
import { getTerminalOptions } from './terminal-options.js';
import { AgentStreamEvent, Channel, NewMessage } from './types.js';
import {
  StreamEvent,
  StreamProcessor,
  ProcessOptions,
} from './streaming/index.js';
import { mapStreamEventToRenderItems } from './terminal/stream-renderer.js';
import { resolveTerminalStreamOptions } from './terminal/stream-options.js';
import {
  handleStreamCommand,
  isStreamCommand,
  getStreamConfig,
  STREAM_COMMANDS,
} from './terminal/stream-commands.js';
import { STREAMING_CONFIG } from './config.js';

export interface TerminalAgentSummary {
  jid: string;
  name: string;
  folder: string;
  active: boolean;
  status?: string;
  sessionId?: string | null;
  containerName?: string | null;
  mounts?: string[];
}

export interface CreateTerminalAgentInput {
  name: string;
  mounts?: string[];
  readWrite?: boolean;
}

export interface TerminalChannelDeps {
  onMessage: (chatJid: string, message: NewMessage) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  listAgents: () => TerminalAgentSummary[];
  createAgent: (input: CreateTerminalAgentInput) => {
    agent: TerminalAgentSummary;
    created: boolean;
  };
  deleteAgent: (query: string) => { agent: TerminalAgentSummary } | null;
  resolveAgent: (query: string) => TerminalAgentSummary | null;
}

export type TerminalCommand =
  | { type: 'help' }
  | { type: 'agents' }
  | { type: 'current' }
  | { type: 'quit' }
  | { type: 'new'; name: string; mounts: string[]; readWrite: boolean }
  | { type: 'switch'; target: string }
  | { type: 'delete'; target: string }
  | { type: 'send'; target: string; message: string }
  | { type: 'unknown'; message: string };

interface CommandSpec {
  name: string;
  usage: string;
  description: string;
}

interface TransientStatus {
  status: string;
  expiresAt: number;
}

export interface TerminalCommandMenuItem {
  label: string;
  value: string;
  detail: string;
  description: string;
  kind: 'command' | 'agent' | 'option' | 'value';
}

const COMMAND_SPECS: CommandSpec[] = [
  {
    name: '/new',
    usage: '/new <name> [--mount <path>] [--rw]',
    description: 'create or update a local agent',
  },
  {
    name: '/agents',
    usage: '/agents',
    description: 'list local agents',
  },
  {
    name: '/switch',
    usage: '/switch <name>',
    description: 'attach current chat to an agent',
  },
  {
    name: '/attach',
    usage: '/attach <name>',
    description: 'alias for /switch',
  },
  {
    name: '/send',
    usage: '/send <name> <message>',
    description: 'send without switching',
  },
  {
    name: '/delete',
    usage: '/delete <name>',
    description: 'delete a local agent',
  },
  {
    name: '/current',
    usage: '/current',
    description: 'show current agent',
  },
  {
    name: '/help',
    usage: '/help',
    description: 'show command help',
  },
  {
    name: '/quit',
    usage: '/quit',
    description: 'exit terminal mode',
  },
  ...STREAM_COMMANDS,
];

function stripQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenize(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g);
  return matches ? matches.map(stripQuotes) : [];
}

function getCommandSpec(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((spec) => spec.name === name);
}

function getAgentQueryOptions(agents: TerminalAgentSummary[]): string[] {
  return [
    ...new Set(agents.flatMap((agent) => [agent.name, agent.folder])),
  ].sort();
}

function padRight(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
}

function formatAgentLine(
  agent: TerminalAgentSummary,
  currentJid: string | null,
): string {
  const current = agent.jid === currentJid ? '*' : ' ';
  const status = agent.status || (agent.active ? 'running' : 'idle');
  const session = agent.sessionId || '-';
  const container = agent.containerName || '-';
  const mounts =
    agent.mounts && agent.mounts.length > 0
      ? ` mounts=${agent.mounts.join(', ')}`
      : '';
  return `${current} ${agent.name} (${agent.folder}) status=${status} session=${session} container=${container}${mounts}`;
}

function getInlineHint(
  input: string,
  agents: TerminalAgentSummary[],
  transientHint?: string | null,
): string {
  if (transientHint) return transientHint;
  if (!input.startsWith('/')) return 'Enter to send. Tab completes commands.';

  const trimmed = input.trim();
  const tokens = tokenize(trimmed);
  const command = tokens[0]?.toLowerCase() || '/';

  if (trimmed === '/' || tokens.length === 0) {
    return 'Commands: /new /agents /switch /send /delete /current /quit';
  }

  if (
    command === '/switch' ||
    command === '/attach' ||
    command === '/send' ||
    command === '/delete'
  ) {
    const options = getAgentQueryOptions(agents);
    if (options.length === 0) {
      return getCommandSpec(command)?.usage || '';
    }
    return `Targets: ${options.slice(0, 6).join(', ')}${options.length > 6 ? ', ...' : ''}`;
  }

  if (command === '/new') {
    return '/new <name> [--mount <path>] [--rw]';
  }

  return getCommandSpec(command)?.usage || 'Tab for command completion';
}

function buildCommandMenuItems(
  line: string,
  agents: TerminalAgentSummary[],
): TerminalCommandMenuItem[] {
  if (!line.startsWith('/')) return [];

  const trimmed = line.trimStart();
  if (!trimmed.startsWith('/')) return [];

  const slashToken = trimmed.split(/\s+/, 1)[0] || '';
  const hasExactCommand = COMMAND_SPECS.some(
    (spec) => spec.name === slashToken,
  );
  const shouldShowTopLevelOnly = !/\s/.test(trimmed) && !hasExactCommand;

  if (!shouldShowTopLevelOnly) {
    return [];
  }

  const commandNames = COMMAND_SPECS.map((spec) => spec.name);
  const matches = commandNames.filter((name) => name.startsWith(slashToken));
  const names = matches.length > 0 ? matches : commandNames;

  const items: TerminalCommandMenuItem[] = [];
  for (const name of names) {
    const spec = getCommandSpec(name);
    if (!spec) continue;
    items.push({
      label: spec.name,
      value: `${spec.name} `,
      detail: spec.usage,
      description: spec.description,
      kind: 'command',
    });
  }
  return items;
}

export function applyTerminalMenuItem(
  line: string,
  item: TerminalCommandMenuItem,
): string {
  if (!line.startsWith('/')) return line;

  const endsWithSpace = /\s$/.test(line);
  const tokens = tokenize(line);
  const command = tokens[0]?.toLowerCase() || '';

  if (item.kind === 'command') {
    return item.value;
  }

  if (
    item.kind === 'agent' ||
    item.kind === 'option' ||
    item.kind === 'value'
  ) {
    if (endsWithSpace) {
      return `${line}${item.value}${item.kind === 'agent' ? ' ' : ''}`;
    }

    if (tokens.length === 0) return item.value;
    tokens[tokens.length - 1] = item.value;
    const next = tokens.join(' ');
    return `${next}${command === '/send' && item.kind === 'agent' ? ' ' : ''}`;
  }

  return line;
}

export function parseTerminalCommand(input: string): TerminalCommand {
  const tokens = tokenize(input.trim());
  const command = tokens[0]?.toLowerCase();

  if (!command) {
    return { type: 'unknown', message: 'Empty command' };
  }

  switch (command) {
    case '/help':
      return { type: 'help' };
    case '/agents':
      return { type: 'agents' };
    case '/current':
      return { type: 'current' };
    case '/quit':
    case '/exit':
      return { type: 'quit' };
    case '/new':
      if (!tokens[1]) {
        return { type: 'unknown', message: 'Usage: /new <agent-name>' };
      }
      {
        const mounts: string[] = [];
        let readWrite = false;

        for (let i = 2; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (token === '--mount') {
            const mountPath = tokens[i + 1];
            if (!mountPath) {
              return {
                type: 'unknown',
                message: 'Usage: /new <agent-name> [--mount <path>] [--rw]',
              };
            }
            mounts.push(mountPath);
            i += 1;
            continue;
          }
          if (token === '--rw') {
            readWrite = true;
            continue;
          }
          return {
            type: 'unknown',
            message: `Unknown /new option: ${token}`,
          };
        }

        return { type: 'new', name: tokens[1], mounts, readWrite };
      }
    case '/switch':
    case '/attach':
      if (!tokens[1]) {
        return {
          type: 'unknown',
          message: 'Usage: /switch <agent-name>',
        };
      }
      return { type: 'switch', target: tokens[1] };
    case '/delete':
      if (!tokens[1]) {
        return {
          type: 'unknown',
          message: 'Usage: /delete <agent-name>',
        };
      }
      return { type: 'delete', target: tokens[1] };
    case '/send':
      if (!tokens[1] || tokens.length < 3) {
        return {
          type: 'unknown',
          message: 'Usage: /send <agent-name> <message>',
        };
      }
      return {
        type: 'send',
        target: tokens[1],
        message: tokens.slice(2).join(' '),
      };
    default:
      return {
        type: 'unknown',
        message: `Unknown command: ${tokens[0]}. Use /help.`,
      };
  }
}

export function getTerminalCompletions(
  line: string,
  agents: TerminalAgentSummary[],
): [string[], string] {
  if (!line.startsWith('/')) return [[], line];

  const endsWithSpace = /\s$/.test(line);
  const tokens = tokenize(line);
  const currentToken = endsWithSpace ? '' : tokens[tokens.length - 1] || '';
  const command = tokens[0]?.toLowerCase() || '';

  if (tokens.length <= 1 && !endsWithSpace) {
    const commandNames = COMMAND_SPECS.map((spec) => spec.name);
    const matches = commandNames.filter((name) =>
      name.startsWith(currentToken),
    );
    return [matches.length > 0 ? matches : commandNames, currentToken];
  }

  if (command === '/switch' || command === '/attach' || command === '/delete') {
    const options = getAgentQueryOptions(agents);
    const matches = options.filter((name) => name.startsWith(currentToken));
    return [matches.length > 0 ? matches : options, currentToken];
  }

  if (command === '/send' && tokens.length <= 2) {
    const options = getAgentQueryOptions(agents);
    const matches = options.filter((name) => name.startsWith(currentToken));
    return [matches.length > 0 ? matches : options, currentToken];
  }

  if (command === '/new') {
    const options = ['--mount', '--rw'];
    if (endsWithSpace && tokens.length >= 2) {
      return [options, ''];
    }
    if (currentToken.startsWith('--')) {
      const matches = options.filter((option) =>
        option.startsWith(currentToken),
      );
      return [matches.length > 0 ? matches : options, currentToken];
    }
  }

  if (command === '/view-mode' && tokens.length <= 2) {
    const options = ['smart', 'full', 'minimal'];
    const matches = options.filter((option) => option.startsWith(currentToken));
    return [matches.length > 0 ? matches : options, currentToken];
  }

  if (
    (command === '/show-thinking' ||
      command === '/show-plan' ||
      command === '/show-tools') &&
    tokens.length <= 2
  ) {
    const options = ['on', 'off'];
    const matches = options.filter((option) => option.startsWith(currentToken));
    return [matches.length > 0 ? matches : options, currentToken];
  }

  return [[], currentToken];
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (let i = 1; i < values.length; i += 1) {
    while (!values[i].startsWith(prefix) && prefix.length > 0) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

function createLocalMessage(chatJid: string, text: string): NewMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: 'terminal-user',
    sender_name: 'You',
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: false,
  };
}

export class TerminalChannel implements Channel {
  name = 'terminal';
  private connected = false;
  private currentJid: string | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private transientHint: string | null = null;
  private transientStatuses = new Map<string, TransientStatus>();
  private readonly terminalOptions = getTerminalOptions();
  private inkStore: TerminalInkStore | null = null;
  private inkApp: { unmount: () => void } | null = null;
  private unsubscribeInkLogs: (() => void) | null = null;
  private streamProcessor: StreamProcessor | null = null;
  private streamEvents: StreamEvent[] = [];

  constructor(private deps: TerminalChannelDeps) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;

    if (STREAMING_CONFIG.ENABLED) {
      const processorOptions: ProcessOptions = resolveTerminalStreamOptions(
        'terminal',
        `terminal-${Date.now()}`,
      );
      this.streamProcessor = new StreamProcessor(processorOptions);
    }

    this.selectInitialAgent();
    this.connectInkMode();
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    if (this.inkApp) {
      this.inkApp.unmount();
      this.inkApp = null;
    }
    if (this.unsubscribeInkLogs) {
      this.unsubscribeInkLogs();
      this.unsubscribeInkLogs = null;
    }
    if (this.inkStore) {
      this.inkStore.dispose();
      this.inkStore = null;
    }
    if (this.streamProcessor) {
      this.streamProcessor.dispose();
      this.streamProcessor = null;
    }
    this.streamEvents = [];
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('local:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const agent = this.agentByJid(jid);
    const label = agent ? agent.name : jid;
    this.setTransientStatus(jid, 'waiting-input', 5000);

    this.inkStore?.completeMessage({
      id: `agent-${jid}-${Date.now()}`,
      label: `agent:${label}`,
      text,
      tone: 'agent',
      mergeKey: jid,
    });
    this.refreshInkContext();
  }

  async sendAgentEvent(jid: string, event: AgentStreamEvent): Promise<void> {
    const agent = this.agentByJid(jid);
    const label = agent ? agent.name : jid;

    if (event.type === 'assistant') {
      this.setTransientStatus(jid, 'running', 15000);
      this.inkStore?.addMessage({
        id: `agent-stream-${jid}-${Date.now()}`,
        label: `agent:${label}`,
        text: event.text,
        tone: 'agent',
        mergeKey: jid,
        mergeMode: event.replace ? 'replace' : 'append',
      });
      this.refreshInkContext();
      return;
    }

    this.inkStore?.addMessage({
      id: `status-${jid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: `status:${label}`,
      text: event.text,
      tone: 'status',
    });
    this.refreshInkContext();
  }

  async handleStreamEvent(_jid: string, event: StreamEvent): Promise<void> {
    this.streamEvents.push(event);

    const current = this.currentAgent();
    const label = current ? current.name : 'agent';
    const items = mapStreamEventToRenderItems(_jid, `agent:${label}`, event);

    for (const item of items) {
      this.inkStore?.addMessage({
        id: `${event.type}-${event.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
        label: item.label,
        text: item.text,
        tone: item.tone,
        mergeKey: item.mergeKey,
      });
    }

    this.refreshInkContext();
  }

  private currentAgent(): TerminalAgentSummary | null {
    if (!this.currentJid) return null;
    return this.agentByJid(this.currentJid);
  }

  private getPromptStatus(current: TerminalAgentSummary | null): string {
    if (!current) return 'idle';

    const runtimeStatus =
      current.status || (current.active ? 'running' : 'idle');
    if (runtimeStatus !== 'idle') return runtimeStatus;

    const transient = this.transientStatuses.get(current.jid);
    if (!transient) return 'idle';
    if (transient.expiresAt <= Date.now()) {
      this.transientStatuses.delete(current.jid);
      return 'idle';
    }
    return transient.status;
  }

  private setTransientStatus(
    jid: string,
    status: string,
    ttlMs: number = 4000,
  ): void {
    this.transientStatuses.set(jid, {
      status,
      expiresAt: Date.now() + ttlMs,
    });
    this.refreshInkContext();
  }

  private connectInkMode(): void {
    if (this.inkApp) return;
    this.inkStore = new TerminalInkStore();
    this.inkStore.addMessage({
      id: `system-${Date.now()}`,
      label: 'system',
      text: 'Terminal mode ready. Type /help for commands.',
      tone: 'system',
    });
    this.refreshInkContext();

    this.statusTimer = setInterval(() => {
      this.refreshInkContext();
    }, 1000);

    if (this.terminalOptions.logView === 'ink') {
      this.unsubscribeInkLogs = subscribeTerminalLogs((item) => {
        this.pushInkLogItem(item);
      });
    }

    this.inkApp = mountTerminalInkApp({
      store: this.inkStore,
      onSubmit: async (line) => {
        await this.submitInkLine(line);
      },
      onExit: () => {
        void this.disconnect();
      },
      getHint: (input) =>
        getInlineHint(input, this.deps.listAgents(), this.transientHint),
      getCompletions: (input) => this.getInkCompletions(input),
      getPreviousHistory: () => this.previousHistory(),
      getNextHistory: () => this.nextHistory(),
      getCommandMenuItems: (input) =>
        buildCommandMenuItems(input, this.deps.listAgents()),
      applyCommandMenuItem: (input, item) => applyTerminalMenuItem(input, item),
    });
  }

  private pushInkLogItem(item: TerminalLogItem): void {
    if (item.type !== 'text') return;
    const current = this.currentAgent();
    if (!current) return;
    if (item.text.includes('[stream]') && this.streamEvents.length > 0) return;
    this.inkStore?.addMessage({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: 'log',
      text: item.text,
      tone: 'system',
    });
  }

  private refreshInkContext(): void {
    if (!this.inkStore) return;
    const current = this.currentAgent();
    this.inkStore.setContext({
      agentLabel: current?.folder || 'no-agent',
      status: this.getPromptStatus(current),
      sessionId: current?.sessionId || null,
      containerName: current?.containerName || null,
      hint: this.transientHint || undefined,
    });
  }

  private selectInitialAgent(): void {
    const agents = this.deps.listAgents();
    this.currentJid = agents[0]?.jid || null;
  }

  private agentByJid(jid: string): TerminalAgentSummary | null {
    return this.deps.listAgents().find((agent) => agent.jid === jid) || null;
  }

  private getInkCompletions(line: string): string[] {
    const [matches, currentToken] = getTerminalCompletions(
      line,
      this.deps.listAgents(),
    );
    if (!line.startsWith('/')) return [];
    if (matches.length === 0) return [];

    const trimmed = /\s$/.test(line)
      ? line
      : line.slice(0, Math.max(0, line.length - currentToken.length));

    return matches.map((match) => {
      if (trimmed.endsWith(' ') || trimmed.length === 0) {
        return `${trimmed}${match}`;
      }
      return `${trimmed}${match}`;
    });
  }

  private previousHistory(): string | null {
    if (this.history.length === 0) return null;

    if (this.historyIndex === null) {
      this.historyDraft = '';
      this.historyIndex = this.history.length - 1;
      return this.history[this.historyIndex];
    }

    if (this.historyIndex <= 0) {
      this.historyIndex = 0;
      return this.history[0];
    }

    this.historyIndex -= 1;
    return this.history[this.historyIndex];
  }

  private nextHistory(): string | null {
    if (this.historyIndex === null) return null;

    if (this.historyIndex >= this.history.length - 1) {
      this.historyIndex = null;
      return this.historyDraft;
    }

    this.historyIndex += 1;
    return this.history[this.historyIndex];
  }

  private rememberHistory(line: string): void {
    if (!line.trim()) return;
    if (this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
    this.historyIndex = null;
    this.historyDraft = '';
  }

  private async submitInkLine(line: string): Promise<void> {
    this.transientHint = null;
    this.rememberHistory(line);

    if (isStreamCommand(line)) {
      if (this.inkStore && handleStreamCommand(line, this.inkStore)) {
        this.refreshInkContext();
        return;
      }
    }

    if (line.startsWith('/')) {
      const command = parseTerminalCommand(line);
      await this.handleInkCommand(command, line);
      this.refreshInkContext();
      return;
    }

    const current = this.currentAgent();
    if (!current) {
      this.transientHint = 'No active agent. Use /new or /switch first.';
      this.refreshInkContext();
      return;
    }

    this.inkStore?.addMessage({
      id: `user-${Date.now()}`,
      label: 'you',
      text: line,
      tone: 'user',
    });

    const localMessage = createLocalMessage(current.jid, line);
    this.deps.onChatMetadata(
      current.jid,
      localMessage.timestamp,
      current.name,
      'terminal',
      false,
    );
    this.deps.onMessage(current.jid, localMessage);
    this.setTransientStatus(current.jid, 'submitted', 4000);
    this.refreshInkContext();
  }

  private async handleInkCommand(
    command: TerminalCommand,
    original: string,
  ): Promise<void> {
    switch (command.type) {
      case 'help': {
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: COMMAND_SPECS.map((spec) => {
            return `${padRight(spec.name, 18)} ${spec.usage} — ${spec.description}`;
          }).join('\n'),
          tone: 'system',
        });
        return;
      }
      case 'agents': {
        const agents = this.deps.listAgents();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text:
            agents.length === 0
              ? 'No local agents.'
              : agents
                  .map((agent) => formatAgentLine(agent, this.currentJid))
                  .join('\n'),
          tone: 'system',
        });
        return;
      }
      case 'current': {
        const current = this.currentAgent();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: current
            ? formatAgentLine(current, this.currentJid)
            : 'No active agent.',
          tone: 'system',
        });
        return;
      }
      case 'quit': {
        await this.disconnect();
        process.exit(0);
      }
      case 'new': {
        const result = this.deps.createAgent({
          name: command.name,
          mounts: command.mounts,
          readWrite: command.readWrite,
        });
        this.currentJid = result.agent.jid;
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: result.created
            ? `Created agent ${result.agent.name} (${result.agent.folder})`
            : `Updated agent ${result.agent.name} (${result.agent.folder})`,
          tone: 'system',
        });
        return;
      }
      case 'switch': {
        const agent = this.deps.resolveAgent(command.target);
        if (!agent) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Unknown agent: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        this.currentJid = agent.jid;
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: `Switched to ${agent.name} (${agent.folder})`,
          tone: 'system',
        });
        return;
      }
      case 'delete': {
        const deleted = this.deps.deleteAgent(command.target);
        if (!deleted) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Unknown agent: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        if (this.currentJid === deleted.agent.jid) {
          this.selectInitialAgent();
        }
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: `Deleted agent ${deleted.agent.name}`,
          tone: 'system',
        });
        return;
      }
      case 'send': {
        const agent = this.deps.resolveAgent(command.target);
        if (!agent) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Unknown agent: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        const localMessage = createLocalMessage(agent.jid, command.message);
        this.inkStore?.addMessage({
          id: `user-${Date.now()}`,
          label: `you -> ${agent.name}`,
          text: command.message,
          tone: 'user',
        });
        this.deps.onChatMetadata(
          agent.jid,
          localMessage.timestamp,
          agent.name,
          'terminal',
          false,
        );
        this.deps.onMessage(agent.jid, localMessage);
        this.setTransientStatus(agent.jid, 'submitted', 4000);
        return;
      }
      case 'unknown':
      default: {
        this.inkStore?.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: command.type === 'unknown' ? command.message : original,
          tone: 'error',
        });
      }
    }
  }
}

export function getTerminalCommandMenuItems(
  line: string,
  agents: TerminalAgentSummary[],
): TerminalCommandMenuItem[] {
  return buildCommandMenuItems(line, agents);
}

export function getTerminalHint(
  input: string,
  agents: TerminalAgentSummary[],
  transientHint?: string | null,
): string {
  return getInlineHint(input, agents, transientHint);
}

export function getSharedCompletionPrefix(values: string[]): string {
  return commonPrefix(values);
}

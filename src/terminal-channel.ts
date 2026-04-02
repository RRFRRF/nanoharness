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

    // Initialize stream processor
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

  /**
   * Handle streaming events from agent execution
   */
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
    durationMs: number,
  ): void {
    this.transientStatuses.set(jid, {
      status,
      expiresAt: Date.now() + durationMs,
    });
  }

  private agentByJid(jid: string): TerminalAgentSummary | null {
    return this.deps.listAgents().find((agent) => agent.jid === jid) || null;
  }

  private connectInkMode(): void {
    this.inkStore = new TerminalInkStore();
    this.inkStore.addMessage({
      id: `system-${Date.now()}`,
      label: 'system',
      text: [
        'NanoClaw terminal ready',
        this.terminalOptions.logView === 'ink'
          ? 'Ink logs mode enabled.'
          : 'Ink chat mode enabled.',
        this.terminalOptions.logView === 'ink'
          ? 'All logs are shown inline for debugging.'
          : 'Logs follow stderr.',
      ].join('\n'),
      tone: 'system',
    });
    this.refreshInkContext();
    this.statusTimer = setInterval(() => this.refreshInkContext(), 300);

    if (this.terminalOptions.logView === 'ink') {
      this.unsubscribeInkLogs = subscribeTerminalLogs((item) => {
        this.pushInkLogItem(item);
      });
    }

    this.inkApp = mountTerminalInkApp({
      store: this.inkStore,
      onSubmit: (line) => this.submitInkLine(line),
      onExit: () => {
        this.disconnect().catch(() => undefined);
      },
      getHint: (input) =>
        getInlineHint(input, this.deps.listAgents(), this.transientHint),
      getCompletions: (input) =>
        this.applyTerminalCompletion(input, this.deps.listAgents()),
      getPreviousHistory: () => this.getPreviousHistoryValue(),
      getNextHistory: () => this.getNextHistoryValue(),
    });
  }

  private pushInkLogItem(item: TerminalLogItem): void {
    if (!this.inkStore) return;

    const shouldSuppressLogText = (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return true;
      return (
        trimmed === '---NANOCLAW_OUTPUT_START---' ||
        trimmed === '---NANOCLAW_OUTPUT_END---' ||
        trimmed.startsWith('<<<') ||
        trimmed.startsWith('{"status":') ||
        trimmed.startsWith('{"type":') ||
        trimmed.startsWith('langsmith/experimental/sandbox is in alpha.') ||
        trimmed.startsWith('[agent-runner] Received input for group:') ||
        trimmed.startsWith('[agent-runner] Starting query') ||
        trimmed.startsWith(
          '[agent-runner] Query ended, waiting for next IPC message...',
        )
      );
    };

    if (item.type === 'text') {
      if (shouldSuppressLogText(item.text)) return;
      this.inkStore.addMessage({
        id: `log-text-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: 'log',
        text: item.text,
        tone: 'system',
      });
      return;
    }

    const record = item.record;
    const levelNum = typeof record.level === 'number' ? record.level : 30;
    const level =
      levelNum >= 60
        ? 'fatal'
        : levelNum >= 50
          ? 'error'
          : levelNum >= 40
            ? 'warn'
            : levelNum >= 30
              ? 'info'
              : 'debug';
    const msg =
      typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : '';
    const details = Object.entries(record)
      .filter(
        ([key]) =>
          !['time', 'level', 'msg', 'message', 'pid', 'hostname'].includes(key),
      )
      .map(
        ([key, value]) =>
          `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
      );
    const text = [msg, ...details].filter(Boolean).join('\n');
    if (shouldSuppressLogText(text)) return;
    this.inkStore.addMessage({
      id: `log-record-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: `log:${level}`,
      text: text || level,
      tone: level === 'error' || level === 'fatal' ? 'error' : 'system',
    });
  }

  private selectInitialAgent(): void {
    const agents = this.deps.listAgents();
    if (agents.length > 0) {
      this.currentJid = agents[0].jid;
    }
  }

  private refreshInkContext(): void {
    if (!this.inkStore) return;
    const current = this.currentAgent();
    this.inkStore.setContext({
      agentLabel: current ? current.folder : 'no-agent',
      status: this.getPromptStatus(current),
      sessionId: current?.sessionId || null,
      containerName: current?.containerName || null,
      hint: '',
    });
  }

  private applyTerminalCompletion(
    input: string,
    agents: TerminalAgentSummary[],
  ): string[] {
    const [matches, token] = getTerminalCompletions(input, agents);
    if (matches.length === 0) return [];

    const prefixText = input.slice(0, input.length - token.length);
    return matches.map((match) => {
      const completed = `${prefixText}${match}`;
      return matches.length === 1 ? `${completed} ` : completed;
    });
  }

  private getPreviousHistoryValue(): string | null {
    if (this.history.length === 0) return null;
    if (this.historyIndex === null) {
      this.historyDraft = '';
      this.historyIndex = this.history.length;
    }
    this.historyIndex = Math.max(0, this.historyIndex - 1);
    return this.history[this.historyIndex];
  }

  private getNextHistoryValue(): string | null {
    if (this.history.length === 0) return null;
    if (this.historyIndex === null) return '';
    this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
    if (this.historyIndex === this.history.length) {
      return this.historyDraft;
    }
    return this.history[this.historyIndex];
  }

  private async submitInkLine(line: string): Promise<void> {
    const trimmed = line.trim();
    this.historyIndex = null;
    this.historyDraft = '';
    if (!trimmed) return;
    this.history.push(trimmed);
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }

    if (trimmed.startsWith('/')) {
      if (this.inkStore && isStreamCommand(trimmed)) {
        const handled = handleStreamCommand(trimmed, this.inkStore);
        if (handled) {
          this.refreshInkContext();
          return;
        }
      }

      const command = parseTerminalCommand(trimmed);
      await this.handleInkCommand(command);
      this.refreshInkContext();
      return;
    }

    const current = this.currentAgent();
    if (!current) {
      this.inkStore?.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: 'No agent selected. Create one with /new <agent-name>.',
        tone: 'system',
      });
      this.refreshInkContext();
      return;
    }

    this.inkStore?.flushLiveMessage();
    this.inkStore?.addMessage({
      id: `user-${Date.now()}`,
      label: `you -> ${current.name}`,
      text: trimmed,
      tone: 'user',
    });
    this.emitMessage(current, trimmed);
    this.refreshInkContext();
  }

  private async handleInkCommand(command: TerminalCommand): Promise<void> {
    switch (command.type) {
      case 'help':
        this.inkStore?.flushLiveMessage();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: COMMAND_SPECS.map(
            (spec) =>
              `${padRight(spec.name, 9)} ${padRight(spec.usage, 36)} ${spec.description}`,
          ).join('\n'),
          tone: 'system',
        });
        return;

      case 'agents': {
        const agents = this.deps.listAgents();
        this.inkStore?.flushLiveMessage();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text:
            agents.length > 0
              ? agents
                  .map((agent) => formatAgentLine(agent, this.currentJid))
                  .join('\n')
              : 'No local agents. Create one with /new <agent-name>.',
          tone: 'system',
        });
        return;
      }

      case 'current': {
        const current = this.currentAgent();
        this.inkStore?.flushLiveMessage();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: current
            ? `Current agent: ${current.name} (${current.folder})`
            : 'No agent attached.',
          tone: 'system',
        });
        return;
      }

      case 'new': {
        const result = this.deps.createAgent({
          name: command.name,
          mounts: command.mounts,
          readWrite: command.readWrite,
        });
        this.currentJid = result.agent.jid;
        this.inkStore?.flushLiveMessage();
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: result.created
            ? `Created agent ${result.agent.name} (${result.agent.folder})`
            : `Attached to existing agent ${result.agent.name} (${result.agent.folder})`,
          tone: 'system',
        });
        return;
      }

      case 'switch': {
        const agent = this.deps.resolveAgent(command.target);
        this.inkStore?.flushLiveMessage();
        if (!agent) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Agent not found: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        this.currentJid = agent.jid;
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: `Attached to ${agent.name} (${agent.folder})`,
          tone: 'system',
        });
        return;
      }

      case 'delete': {
        this.inkStore?.flushLiveMessage();
        const deleted = this.deps.deleteAgent(command.target);
        if (!deleted) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Agent not found: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        if (this.currentJid === deleted.agent.jid) {
          this.currentJid = null;
          this.selectInitialAgent();
        }
        this.inkStore?.addMessage({
          id: `system-${Date.now()}`,
          label: 'system',
          text: `Deleted agent ${deleted.agent.name} (${deleted.agent.folder})`,
          tone: 'system',
        });
        return;
      }

      case 'send': {
        const agent = this.deps.resolveAgent(command.target);
        this.inkStore?.flushLiveMessage();
        if (!agent) {
          this.inkStore?.addMessage({
            id: `error-${Date.now()}`,
            label: 'error',
            text: `Agent not found: ${command.target}`,
            tone: 'error',
          });
          return;
        }
        this.inkStore?.addMessage({
          id: `user-${Date.now()}`,
          label: `you -> ${agent.name}`,
          text: command.message,
          tone: 'user',
        });
        this.emitMessage(agent, command.message);
        return;
      }

      case 'quit':
        await this.disconnect();
        process.exit(0);
        return;

      case 'unknown':
        this.inkStore?.flushLiveMessage();
        this.inkStore?.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: command.message,
          tone: 'error',
        });
        return;
    }
  }

  private emitMessage(agent: TerminalAgentSummary, text: string): void {
    this.setTransientStatus(agent.jid, 'running', 15000);
    const timestamp = new Date().toISOString();
    this.deps.onChatMetadata(
      agent.jid,
      timestamp,
      agent.name,
      'terminal',
      false,
    );
    this.deps.onMessage(agent.jid, createLocalMessage(agent.jid, text));
  }
}

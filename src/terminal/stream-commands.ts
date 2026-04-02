/**
 * Stream Commands for Terminal UI
 * Commands for controlling streaming output display
 */

import { TerminalInkStore } from '../terminal-ink.js';

export interface StreamCommandSpec {
  name: string;
  usage: string;
  description: string;
}

export const STREAM_COMMANDS: StreamCommandSpec[] = [
  {
    name: '/view-mode',
    usage: '/view-mode <smart|full|minimal>',
    description: 'Switch display mode for streaming output',
  },
  {
    name: '/show-thinking',
    usage: '/show-thinking <on|off>',
    description: 'Show or hide thinking process',
  },
  {
    name: '/show-plan',
    usage: '/show-plan <on|off>',
    description: 'Show or hide execution plan',
  },
  {
    name: '/show-tools',
    usage: '/show-tools <on|off>',
    description: 'Show or hide tool calls',
  },
  {
    name: '/collapse-thinking',
    usage: '/collapse-thinking',
    description: 'Toggle thinking process collapsed state',
  },
  {
    name: '/stream-status',
    usage: '/stream-status',
    description: 'Show current streaming configuration',
  },
] as const;

// Runtime stream configuration
interface StreamConfig {
  viewMode: 'smart' | 'full' | 'minimal';
  showThinking: boolean;
  showPlan: boolean;
  showTools: boolean;
  collapseThinking: boolean;
}

// Global stream configuration
let streamConfig: StreamConfig = {
  viewMode: 'smart',
  showThinking: true,
  showPlan: true,
  showTools: true,
  collapseThinking: false,
};

// Get current stream configuration
export function getStreamConfig(): StreamConfig {
  return { ...streamConfig };
}

// Set stream configuration
export function setStreamConfig(config: Partial<StreamConfig>): void {
  streamConfig = { ...streamConfig, ...config };
}

// Reset stream configuration to defaults
export function resetStreamConfig(): void {
  streamConfig = {
    viewMode: 'smart',
    showThinking: true,
    showPlan: true,
    showTools: true,
    collapseThinking: false,
  };
}

// Handle stream commands
export function handleStreamCommand(
  command: string,
  store: TerminalInkStore,
): boolean {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const arg = parts[1]?.toLowerCase();

  switch (cmd) {
    case '/view-mode': {
      if (!arg || !['smart', 'full', 'minimal'].includes(arg)) {
        store.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: 'Usage: /view-mode <smart|full|minimal>',
          tone: 'error',
        });
        return true;
      }
      streamConfig.viewMode = arg as 'smart' | 'full' | 'minimal';
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: `View mode set to: ${arg}`,
        tone: 'system',
      });
      return true;
    }

    case '/show-thinking': {
      if (!arg || !['on', 'off'].includes(arg)) {
        store.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: 'Usage: /show-thinking <on|off>',
          tone: 'error',
        });
        return true;
      }
      streamConfig.showThinking = arg === 'on';
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: `Thinking display: ${arg}`,
        tone: 'system',
      });
      return true;
    }

    case '/show-plan': {
      if (!arg || !['on', 'off'].includes(arg)) {
        store.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: 'Usage: /show-plan <on|off>',
          tone: 'error',
        });
        return true;
      }
      streamConfig.showPlan = arg === 'on';
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: `Plan display: ${arg}`,
        tone: 'system',
      });
      return true;
    }

    case '/show-tools': {
      if (!arg || !['on', 'off'].includes(arg)) {
        store.addMessage({
          id: `error-${Date.now()}`,
          label: 'error',
          text: 'Usage: /show-tools <on|off>',
          tone: 'error',
        });
        return true;
      }
      streamConfig.showTools = arg === 'on';
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: `Tools display: ${arg}`,
        tone: 'system',
      });
      return true;
    }

    case '/collapse-thinking': {
      streamConfig.collapseThinking = !streamConfig.collapseThinking;
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: `Thinking collapsed: ${streamConfig.collapseThinking ? 'yes' : 'no'}`,
        tone: 'system',
      });
      return true;
    }

    case '/stream-status': {
      store.addMessage({
        id: `system-${Date.now()}`,
        label: 'system',
        text: [
          'Streaming Configuration:',
          `  View mode: ${streamConfig.viewMode}`,
          `  Show thinking: ${streamConfig.showThinking}`,
          `  Show plan: ${streamConfig.showPlan}`,
          `  Show tools: ${streamConfig.showTools}`,
          `  Collapse thinking: ${streamConfig.collapseThinking}`,
        ].join('\n'),
        tone: 'system',
      });
      return true;
    }

    default:
      return false;
  }
}

// Check if a command is a stream command
export function isStreamCommand(command: string): boolean {
  const cmd = command.trim().split(/\s+/)[0]?.toLowerCase();
  return STREAM_COMMANDS.some((c) => c.name === cmd);
}

// Get stream command completions
export function getStreamCompletions(partial: string): string[] {
  const commands = STREAM_COMMANDS.map((c) => c.name);
  return commands.filter((c) => c.startsWith(partial));
}

// Default export
export default {
  handleStreamCommand,
  isStreamCommand,
  getStreamCompletions,
  getStreamConfig,
  setStreamConfig,
  resetStreamConfig,
  STREAM_COMMANDS,
};

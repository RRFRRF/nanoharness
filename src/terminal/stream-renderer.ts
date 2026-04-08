import type { StreamEvent } from '../streaming/index.js';
import { getStreamConfig } from './stream-commands.js';

export interface TerminalStreamRenderItem {
  kind: 'message';
  label: string;
  text: string;
  tone: 'system' | 'error' | 'agent';
  mergeKey?: string;
  mergeMode?: 'append' | 'replace';
}

export function mapStreamEventToRenderItems(
  jid: string,
  label: string,
  event: StreamEvent,
): TerminalStreamRenderItem[] {
  const streamConfig = getStreamConfig();
  const items: TerminalStreamRenderItem[] = [];
  const isInternalNativeDecision = (description: string | null | undefined) =>
    typeof description === 'string' && description.startsWith('Native ');
  const push = (
    text: string | null | undefined,
    tone: 'system' | 'error' | 'agent' = 'system',
    mergeKey?: string,
    mergeMode?: 'append' | 'replace',
  ) => {
    if (!text) return;
    items.push({
      kind: 'message',
      label,
      text,
      tone,
      mergeKey,
      mergeMode,
    });
  };

  switch (event.type) {
    case 'thinking': {
      if (streamConfig.showThinking) {
        const data = event.data as { content?: string };
        const content = typeof data?.content === 'string' ? data.content : '';
        if (content) {
          push(
            content.slice(0, 200) + (content.length > 200 ? '...' : ''),
            'system',
          );
        }
      }
      break;
    }
    case 'tool_start': {
      if (streamConfig.showTools) {
        const data = event.data as { name?: string };
        if (typeof data?.name === 'string' && data.name) {
          push(`Starting: ${data.name}`);
        }
      }
      break;
    }
    case 'tool_progress': {
      if (streamConfig.showTools) {
        const data = event.data as {
          name?: string;
          message?: string;
          percent?: number;
        };
        const parts = [
          typeof data?.name === 'string' && data.name ? data.name : null,
          typeof data?.message === 'string' && data.message
            ? data.message
            : null,
          typeof data?.percent === 'number' ? `${data.percent}%` : null,
        ].filter(Boolean);
        if (parts.length > 0) {
          push(parts.join(' — '));
        }
      }
      break;
    }
    case 'tool_complete': {
      if (streamConfig.showTools) {
        const data = event.data as { name?: string; duration?: number };
        if (typeof data?.name === 'string' && data.name) {
          const duration =
            typeof data.duration === 'number' ? ` (${data.duration}ms)` : '';
          push(`✓ ${data.name}${duration}`);
        }
      }
      break;
    }
    case 'decision': {
      const data = event.data as { description?: string; choice?: string };
      if (
        streamConfig.viewMode !== 'full' &&
        isInternalNativeDecision(data?.description)
      ) {
        break;
      }
      const parts = [
        typeof data?.description === 'string' ? data.description : null,
        typeof data?.choice === 'string' ? data.choice : null,
      ].filter(Boolean);
      if (parts.length > 0) {
        push(parts.join(': '));
      }
      break;
    }
    case 'plan': {
      if (streamConfig.showPlan) {
        const data = event.data as {
          steps?: Array<{ description?: string }>;
        };
        const steps = Array.isArray(data?.steps)
          ? data.steps
              .map((step) =>
                typeof step?.description === 'string' ? step.description : null,
              )
              .filter(Boolean)
          : [];
        if (steps.length > 0) {
          push(`Plan: ${steps.join(' | ')}`);
        }
      }
      break;
    }
    case 'plan_step': {
      if (streamConfig.showPlan) {
        const data = event.data as {
          status?: string;
          progress?: number;
          message?: string;
          stepId?: string;
        };
        const parts = [
          typeof data?.stepId === 'string' ? data.stepId : null,
          typeof data?.status === 'string' ? data.status : null,
          typeof data?.message === 'string' ? data.message : null,
          typeof data?.progress === 'number' ? `${data.progress}%` : null,
        ].filter(Boolean);
        if (parts.length > 0) {
          push(`Plan step: ${parts.join(' — ')}`);
        }
      }
      break;
    }
    case 'content': {
      const data = event.data as { text?: string; replace?: boolean };
      if (typeof data?.text === 'string' && data.text) {
        push(
          data.text,
          'agent',
          jid,
          data.replace === true ? 'replace' : 'append',
        );
      }
      break;
    }
    case 'error': {
      const data = event.data as {
        message?: string;
        error?: string;
        details?: unknown;
      };
      const text =
        (typeof data?.message === 'string' && data.message) ||
        (typeof data?.error === 'string' && data.error) ||
        (typeof data?.details === 'string' && data.details) ||
        JSON.stringify(event.data ?? 'Unknown streaming error');
      push(text, 'error');
      break;
    }
    case 'complete':
    default:
      break;
  }

  return items;
}

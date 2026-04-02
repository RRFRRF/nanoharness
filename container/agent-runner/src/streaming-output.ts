/**
 * Streaming Output Module for NanoClaw Agent Runner
 * Provides real-time event streaming from container to host
 */

import crypto from 'crypto';

// Stream Event Types
export type StreamEventType =
  | 'thinking' // Agent thinking process
  | 'plan' // Execution plan
  | 'plan_step' // Plan step update
  | 'tool_start' // Tool call start
  | 'tool_progress' // Tool progress (long tasks)
  | 'tool_complete' // Tool call complete
  | 'decision' // Key decision
  | 'content' // Final content
  | 'complete' // Task complete
  | 'error'; // Error

// Step status type
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// Plan Step interface
export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
  tool?: string;
  progress?: number;
  message?: string;
}

// Stream Event interface
export interface StreamEvent {
  type: StreamEventType;
  timestamp: string;
  sessionId?: string;
  data: unknown;
}

// Stream markers for protocol
export const STREAM_MARKERS = {
  THINKING_START: '<<<THINKING>>>',
  THINKING_END: '<<<THINKING_END>>>',
  PLAN_START: '<<<PLAN>>>',
  PLAN_END: '<<<PLAN_END>>>',
  PLAN_STEP: '<<<STEP:',
  TOOL_START: '<<<TOOL:',
  TOOL_PROGRESS: '<<<PROGRESS:',
  TOOL_COMPLETE: '<<<TOOL_COMPLETE>>>',
  DECISION: '<<<DECISION>>>',
  CONTENT_START: '<<<CONTENT>>>',
  CONTENT_END: '<<<CONTENT_END>>>',
  COMPLETE: '<<<COMPLETE>>>',
  ERROR: '<<<ERROR>>>',
} as const;

// Legacy markers (for backward compatibility)
export const LEGACY_MARKERS = {
  OUTPUT_START: '---NANOCLAW_OUTPUT_START---',
  OUTPUT_END: '---NANOCLAW_OUTPUT_END---',
} as const;

// Configuration from environment
interface StreamingConfig {
  enabled: boolean;
  bufferSize: number;
  showThinking: boolean;
  showPlan: boolean;
  showTools: boolean;
}

function getStreamingConfig(): StreamingConfig {
  return {
    enabled: process.env.NANOCLAW_STREAMING !== 'false',
    bufferSize: parseInt(process.env.NANOCLAW_STREAM_BUFFER_SIZE || '1000', 10),
    showThinking: process.env.NANOCLAW_SHOW_THINKING !== 'false',
    showPlan: process.env.NANOCLAW_SHOW_PLAN !== 'false',
    showTools: process.env.NANOCLAW_SHOW_TOOLS !== 'false',
  };
}

/**
 * Streaming Output Manager
 * Singleton class for managing streaming output from container
 */
export class StreamingOutput {
  private static instance: StreamingOutput | null = null;
  private config: StreamingConfig;
  private enabled: boolean = true;
  private sessionId: string | undefined;
  private currentPlan: PlanStep[] = [];
  private currentThinking: string = '';
  private activeTools: Map<string, { name: string; startTime: number }> = new Map();

  private constructor() {
    this.config = getStreamingConfig();
    this.enabled = this.config.enabled;
  }

  static getInstance(): StreamingOutput {
    if (!StreamingOutput.instance) {
      StreamingOutput.instance = new StreamingOutput();
    }
    return StreamingOutput.instance;
  }

  static resetInstance(): void {
    StreamingOutput.instance = null;
  }

  /**
   * Set session ID for streaming events
   */
  setSessionId(sessionId: string | undefined): void {
    this.sessionId = sessionId;
  }

  /**
   * Enable or disable streaming
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled && this.config.enabled;
  }

  /**
   * Check if streaming is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Emit a raw stream event
   */
  private emitEvent(type: StreamEventType, data: unknown): void {
    if (!this.enabled) return;

    const event: StreamEvent = {
      type,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      data,
    };

    // Output as marker-wrapped JSON
    const marker = this.getMarkerForType(type);
    if (marker) {
      console.log(marker);
      console.log(JSON.stringify(event));
      if (type === 'thinking' || type === 'plan' || type === 'content') {
        console.log(this.getEndMarkerForType(type));
      }
    } else {
      console.log(JSON.stringify(event));
    }
  }

  private getMarkerForType(type: StreamEventType): string | null {
    switch (type) {
      case 'thinking':
        return STREAM_MARKERS.THINKING_START;
      case 'plan':
        return STREAM_MARKERS.PLAN_START;
      case 'plan_step':
        return STREAM_MARKERS.PLAN_STEP;
      case 'tool_start':
        return STREAM_MARKERS.TOOL_START;
      case 'tool_progress':
        return STREAM_MARKERS.TOOL_PROGRESS;
      case 'tool_complete':
        return STREAM_MARKERS.TOOL_COMPLETE;
      case 'decision':
        return STREAM_MARKERS.DECISION;
      case 'content':
        return STREAM_MARKERS.CONTENT_START;
      case 'complete':
        return STREAM_MARKERS.COMPLETE;
      case 'error':
        return STREAM_MARKERS.ERROR;
      default:
        return null;
    }
  }

  private getEndMarkerForType(type: StreamEventType): string | null {
    switch (type) {
      case 'thinking':
        return STREAM_MARKERS.THINKING_END;
      case 'plan':
        return STREAM_MARKERS.PLAN_END;
      case 'content':
        return STREAM_MARKERS.CONTENT_END;
      default:
        return null;
    }
  }

  /**
   * Emit thinking content
   */
  thinking(content: string): void {
    if (!this.config.showThinking) return;

    this.currentThinking = content;
    this.emitEvent('thinking', { content });
  }

  /**
   * Emit plan with steps
   */
  plan(steps: PlanStep[]): void {
    if (!this.config.showPlan) return;

    this.currentPlan = steps;
    this.emitEvent('plan', { steps });
  }

  /**
   * Update a plan step status
   */
  planStepUpdate(stepId: string, status: StepStatus, progress?: number): void {
    if (!this.config.showPlan) return;

    const step = this.currentPlan.find((s) => s.id === stepId);
    if (step) {
      step.status = status;
      if (progress !== undefined) step.progress = progress;
    }

    this.emitEvent('plan_step', { stepId, status, progress, plan: this.currentPlan });
  }

  /**
   * Start a tool call
   */
  toolStart(name: string, input: unknown): string {
    if (!this.config.showTools) return '';

    const toolId = crypto.randomUUID();
    this.activeTools.set(toolId, { name, startTime: Date.now() });

    this.emitEvent('tool_start', { toolId, name, input });
    return toolId;
  }

  /**
   * Update tool progress
   */
  toolProgress(toolId: string, message: string, percent?: number): void {
    if (!this.config.showTools) return;

    const tool = this.activeTools.get(toolId);
    if (tool) {
      this.emitEvent('tool_progress', { toolId, name: tool.name, message, percent });
    }
  }

  /**
   * Complete a tool call
   */
  toolComplete(toolId: string, result: unknown): void {
    if (!this.config.showTools) return;

    const tool = this.activeTools.get(toolId);
    if (tool) {
      const duration = Date.now() - tool.startTime;
      this.emitEvent('tool_complete', {
        toolId,
        name: tool.name,
        duration,
        result,
      });
      this.activeTools.delete(toolId);
    }
  }

  /**
   * Emit a decision
   */
  decision(description: string, choice: string): void {
    this.emitEvent('decision', { description, choice });
  }

  /**
   * Emit final content
   */
  content(text: string): void {
    this.emitEvent('content', { text });
  }

  /**
   * Mark task as complete
   */
  complete(): void {
    this.emitEvent('complete', {});
    this.cleanup();
  }

  /**
   * Emit error
   */
  error(message: string, details?: unknown): void {
    this.emitEvent('error', { message, details });
  }

  /**
   * Get current plan
   */
  getCurrentPlan(): PlanStep[] {
    return [...this.currentPlan];
  }

  /**
   * Get active tools count
   */
  getActiveToolsCount(): number {
    return this.activeTools.size;
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.activeTools.clear();
    this.currentPlan = [];
    this.currentThinking = '';
  }
}

/**
 * Convenience function to get StreamingOutput instance
 */
export function getStreamingOutput(): StreamingOutput {
  return StreamingOutput.getInstance();
}

/**
 * Create a plan step
 */
export function createPlanStep(
  description: string,
  tool?: string,
  progress?: number,
): PlanStep {
  return {
    id: crypto.randomUUID(),
    description,
    status: 'pending',
    tool,
    progress,
  };
}

/**
 * Helper to wrap async function with streaming
 */
export async function withStreaming<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { emitThinking?: boolean },
): Promise<T> {
  const streaming = getStreamingOutput();

  if (options?.emitThinking) {
    streaming.thinking(`Starting: ${operation}`);
  }

  const toolId = streaming.toolStart(operation, {});

  try {
    const result = await fn();
    streaming.toolComplete(toolId, { success: true });
    return result;
  } catch (error) {
    streaming.toolComplete(toolId, { success: false, error: String(error) });
    throw error;
  }
}

// Default export
export default StreamingOutput;
/**
 * Stream Processor for NanoClaw
 * Processes stream events and maintains execution state
 */

import { StreamParser } from './parser.js';
import {
  StreamEvent,
  StreamEventType,
  PlanStep,
  StepStatus,
  isThinkingEvent,
  isPlanEvent,
  isPlanStepEvent,
  isToolStartEvent,
  isToolProgressEvent,
  isToolCompleteEvent,
  isDecisionEvent,
  isContentEvent,
  isCompleteEvent,
  isErrorEvent,
} from './types.js';

// Processor options
export interface ProcessOptions {
  sessionId: string;
  groupName: string;
  showThinking?: boolean;
  showPlan?: boolean;
  showTools?: boolean;
  collapseThinking?: boolean;
  maxEvents?: number;
}

// Current execution status
export interface ExecutionStatus {
  currentStep?: PlanStep;
  activeTool?: string;
  progress?: number;
  isComplete: boolean;
  hasError: boolean;
  errorMessage?: string;
}

// Processor statistics
export interface ProcessorStats {
  totalEvents: number;
  eventsByType: Record<StreamEventType, number>;
  planStepsCompleted: number;
  planStepsTotal: number;
  toolsStarted: number;
  toolsCompleted: number;
  startTime: string;
  lastEventTime?: string;
}

/**
 * Stream Processor
 * Manages stream parsing and event processing
 */
export class StreamProcessor {
  private parser: StreamParser;
  private options: ProcessOptions;
  private events: StreamEvent[] = [];
  private planSteps: Map<string, PlanStep> = new Map();
  private activeTools: Map<string, { name: string; startTime: number }> = new Map();
  private currentStatus: ExecutionStatus;
  private stats: ProcessorStats;
  private eventCallbacks: Map<StreamEventType, Set<(event: StreamEvent) => void>> = new Map();
  private completeCallbacks: Set<() => void> = new Set();
  private errorCallbacks: Set<(error: string) => void> = new Set();

  constructor(options: ProcessOptions, enableLegacyParsing = true) {
    this.options = {
      showThinking: true,
      showPlan: true,
      showTools: true,
      collapseThinking: false,
      maxEvents: 10000,
      ...options,
    };

    this.parser = new StreamParser({
      maxBufferSize: 1024 * 1024,
      enableLegacyParsing,
    });

    this.currentStatus = {
      isComplete: false,
      hasError: false,
    };

    this.stats = {
      totalEvents: 0,
      eventsByType: {
        thinking: 0,
        plan: 0,
        plan_step: 0,
        tool_start: 0,
        tool_progress: 0,
        tool_complete: 0,
        decision: 0,
        content: 0,
        complete: 0,
        error: 0,
      },
      planStepsCompleted: 0,
      planStepsTotal: 0,
      toolsStarted: 0,
      toolsCompleted: 0,
      startTime: new Date().toISOString(),
    };
  }

  /**
   * Process a chunk of stream data
   */
  processChunk(chunk: string): StreamEvent[] {
    const parsedEvents = this.parser.parseChunk(chunk);
    const filteredEvents: StreamEvent[] = [];

    for (const event of parsedEvents) {
      // Apply filters
      if (!this.shouldShowEvent(event)) {
        continue;
      }

      // Update state
      this.updateState(event);

      // Store event
      this.events.push(event);
      if (this.events.length > (this.options.maxEvents || 10000)) {
        this.events = this.events.slice(-this.options.maxEvents!);
      }

      // Update stats
      this.updateStats(event);

      // Trigger callbacks
      this.triggerCallbacks(event);

      filteredEvents.push(event);
    }

    return filteredEvents;
  }

  /**
   * Check if event should be shown based on options
   */
  private shouldShowEvent(event: StreamEvent): boolean {
    switch (event.type) {
      case 'thinking':
        return this.options.showThinking !== false;
      case 'plan':
      case 'plan_step':
        return this.options.showPlan !== false;
      case 'tool_start':
      case 'tool_progress':
      case 'tool_complete':
        return this.options.showTools !== false;
      default:
        return true;
    }
  }

  /**
   * Update internal state based on event
   */
  private updateState(event: StreamEvent): void {
    if (isPlanEvent(event)) {
      const { steps } = event.data as { steps: PlanStep[] };
      this.planSteps.clear();
      for (const step of steps) {
        this.planSteps.set(step.id, { ...step });
      }
      this.stats.planStepsTotal = steps.length;
      this.stats.planStepsCompleted = steps.filter((s) => s.status === 'completed').length;
    }

    if (isPlanStepEvent(event)) {
      const { stepId, status } = event.data as { stepId: string; status: StepStatus };
      const step = this.planSteps.get(stepId);
      if (step) {
        step.status = status;
        this.planSteps.set(stepId, step);
      }
      this.stats.planStepsCompleted = Array.from(this.planSteps.values())
        .filter((s) => s.status === 'completed').length;
    }

    if (isToolStartEvent(event)) {
      const { toolId, name } = event.data as { toolId: string; name: string };
      this.activeTools.set(toolId, { name, startTime: Date.now() });
      this.currentStatus.activeTool = name;
      this.stats.toolsStarted++;
    }

    if (isToolCompleteEvent(event)) {
      const { toolId } = event.data as { toolId: string };
      const tool = this.activeTools.get(toolId);
      if (tool) {
        this.activeTools.delete(toolId);
        this.stats.toolsCompleted++;
      }
      if (this.activeTools.size === 0) {
        this.currentStatus.activeTool = undefined;
      }
    }

    if (isToolProgressEvent(event)) {
      const { percent } = event.data as { percent?: number };
      if (percent !== undefined) {
        this.currentStatus.progress = percent;
      }
    }

    if (isCompleteEvent(event)) {
      this.currentStatus.isComplete = true;
    }

    if (isErrorEvent(event)) {
      const { message } = event.data as { message: string };
      this.currentStatus.hasError = true;
      this.currentStatus.errorMessage = message;
    }

    // Update current step
    const pendingSteps = Array.from(this.planSteps.values())
      .filter((s) => s.status === 'in_progress');
    if (pendingSteps.length > 0) {
      this.currentStatus.currentStep = pendingSteps[0];
    }
  }

  /**
   * Update statistics
   */
  private updateStats(event: StreamEvent): void {
    this.stats.totalEvents++;
    this.stats.eventsByType[event.type]++;
    this.stats.lastEventTime = new Date().toISOString();
  }

  /**
   * Trigger registered callbacks
   */
  private triggerCallbacks(event: StreamEvent): void {
    const callbacks = this.eventCallbacks.get(event.type);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(event);
        } catch (err) {
          // Ignore callback errors
        }
      }
    }

    if (isCompleteEvent(event)) {
      for (const callback of this.completeCallbacks) {
        try {
          callback();
        } catch (err) {
          // Ignore callback errors
        }
      }
    }

    if (isErrorEvent(event)) {
      const { message } = event.data as { message: string };
      for (const callback of this.errorCallbacks) {
        try {
          callback(message);
        } catch (err) {
          // Ignore callback errors
        }
      }
    }
  }

  /**
   * Register event callback
   */
  onEvent(type: StreamEventType, callback: (event: StreamEvent) => void): () => void {
    if (!this.eventCallbacks.has(type)) {
      this.eventCallbacks.set(type, new Set());
    }
    this.eventCallbacks.get(type)!.add(callback);

    return () => {
      this.eventCallbacks.get(type)?.delete(callback);
    };
  }

  /**
   * Register complete callback
   */
  onComplete(callback: () => void): () => void {
    this.completeCallbacks.add(callback);
    return () => {
      this.completeCallbacks.delete(callback);
    };
  }

  /**
   * Register error callback
   */
  onError(callback: (error: string) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => {
      this.errorCallbacks.delete(callback);
    };
  }

  /**
   * Get current execution status
   */
  getCurrentStatus(): ExecutionStatus {
    return { ...this.currentStatus };
  }

  /**
   * Get complete plan
   */
  getPlan(): PlanStep[] {
    return Array.from(this.planSteps.values());
  }

  /**
   * Get all events
   */
  getEvents(): StreamEvent[] {
    return [...this.events];
  }

  /**
   * Get events by type
   */
  getEventsByType(type: StreamEventType): StreamEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /**
   * Get recent events
   */
  getRecentEvents(count: number): StreamEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Get processor statistics
   */
  getStats(): ProcessorStats {
    return { ...this.stats };
  }

  /**
   * Check if execution is complete
   */
  isComplete(): boolean {
    return this.currentStatus.isComplete;
  }

  /**
   * Check if there was an error
   */
  hasError(): boolean {
    return this.currentStatus.hasError;
  }

  /**
   * Get active tools
   */
  getActiveTools(): Array<{ name: string; duration: number }> {
    const now = Date.now();
    return Array.from(this.activeTools.values())
      .map((tool) => ({ name: tool.name, duration: now - tool.startTime }));
  }

  /**
   * Get current thinking content (from parser)
   */
  getCurrentThinking(): string {
    return this.parser.getCurrentThinking();
  }

  /**
   * Flush remaining buffer
   */
  flush(): StreamEvent[] {
    const events = this.parser.flush();
    const filteredEvents: StreamEvent[] = [];

    for (const event of events) {
      if (this.shouldShowEvent(event)) {
        this.updateState(event);
        this.updateStats(event);
        this.triggerCallbacks(event);
        filteredEvents.push(event);
      }
    }

    return filteredEvents;
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.parser.clear();
    this.events = [];
    this.planSteps.clear();
    this.activeTools.clear();
    this.currentStatus = {
      isComplete: false,
      hasError: false,
    };
    this.stats = {
      totalEvents: 0,
      eventsByType: {
        thinking: 0,
        plan: 0,
        plan_step: 0,
        tool_start: 0,
        tool_progress: 0,
        tool_complete: 0,
        decision: 0,
        content: 0,
        complete: 0,
        error: 0,
      },
      planStepsCompleted: 0,
      planStepsTotal: 0,
      toolsStarted: 0,
      toolsCompleted: 0,
      startTime: new Date().toISOString(),
    };
    this.eventCallbacks.clear();
    this.completeCallbacks.clear();
    this.errorCallbacks.clear();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.clear();
  }
}

// Default export
export default StreamProcessor;
/**
 * Processor Tests for Streaming Module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamProcessor, ProcessOptions } from '../processor.js';
import { PlanStep, StepStatus } from '../types.js';

// Helper to create raw stream chunks with markers
function createEventChunk(type: string, data: unknown): string {
  const event = {
    type,
    timestamp: '2024-01-01T00:00:00Z',
    data,
  };

  // Map event types to their marker names (for single-line markers)
  const singleLineMarkers: Record<string, string> = {
    plan_step: 'STEP:',
    tool_start: 'TOOL:',
    tool_progress: 'PROGRESS:',
    tool_complete: 'TOOL_COMPLETE>>>',
    decision: 'DECISION>>>',
    complete: 'COMPLETE>>>',
    error: 'ERROR>>>',
  };

  // For block-based events (thinking, plan, content), we need end markers
  const needsEndMarker = ['thinking', 'plan', 'content'].includes(type);

  if (needsEndMarker) {
    return `<<<${type.toUpperCase()}>>>
${JSON.stringify(event)}
<<<${type.toUpperCase()}_END>>>`;
  }

  // For single-line markers
  if (singleLineMarkers[type]) {
    return `<<<${singleLineMarkers[type]}${JSON.stringify(event)}`;
  }

  // Default case
  return `<<<${type.toUpperCase()}>>>${JSON.stringify(event)}`;
}

describe('StreamProcessor', () => {
  let processor: StreamProcessor;
  const defaultOptions: ProcessOptions = {
    sessionId: 'test-session',
    groupName: 'test-group',
    showThinking: true,
    showPlan: true,
    showTools: true,
    collapseThinking: false,
    maxEvents: 100,
  };

  beforeEach(() => {
    processor = new StreamProcessor(defaultOptions);
  });

  describe('basic processing', () => {
    it('should process thinking event', () => {
      const chunk = createEventChunk('thinking', { content: 'Test thinking' });

      const events = processor.processChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('thinking');
    });

    it('should process plan event', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'pending' },
        { id: '2', description: 'Step 2', status: 'in_progress' },
      ];
      const chunk = createEventChunk('plan', { steps });

      const events = processor.processChunk(chunk);
      expect(events).toHaveLength(1);
      expect(processor.getPlan()).toHaveLength(2);
    });

    it('should process tool events', () => {
      const startChunk = createEventChunk('tool_start', {
        toolId: 't1',
        name: 'test_tool',
        input: {},
      });

      processor.processChunk(startChunk);
      expect(processor.getActiveTools()).toHaveLength(1);

      const completeChunk = createEventChunk('tool_complete', {
        toolId: 't1',
        name: 'test_tool',
        duration: 100,
        result: null,
      });

      processor.processChunk(completeChunk);
      expect(processor.getActiveTools()).toHaveLength(0);
    });
  });

  describe('state tracking', () => {
    it('should track current step', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'pending' },
        { id: '2', description: 'Step 2', status: 'in_progress' },
      ];

      processor.processChunk(createEventChunk('plan', { steps }));

      const status = processor.getCurrentStatus();
      expect(status.currentStep).toBeDefined();
      expect(status.currentStep?.id).toBe('2');
    });

    it('should track active tool', () => {
      processor.processChunk(
        createEventChunk('tool_start', {
          toolId: 't1',
          name: 'active_tool',
          input: {},
        }),
      );

      const status = processor.getCurrentStatus();
      expect(status.activeTool).toBe('active_tool');
    });

    it('should track progress', () => {
      processor.processChunk(
        createEventChunk('tool_progress', {
          toolId: 't1',
          name: 'tool',
          message: 'Progress',
          percent: 75,
        }),
      );

      const status = processor.getCurrentStatus();
      expect(status.progress).toBe(75);
    });

    it('should track completion', () => {
      processor.processChunk(createEventChunk('complete', {}));

      expect(processor.isComplete()).toBe(true);
      expect(processor.getCurrentStatus().isComplete).toBe(true);
    });

    it('should track errors', () => {
      processor.processChunk(
        createEventChunk('error', { message: 'Test error' }),
      );

      expect(processor.hasError()).toBe(true);
      expect(processor.getCurrentStatus().hasError).toBe(true);
      expect(processor.getCurrentStatus().errorMessage).toBe('Test error');
    });
  });

  describe('plan updates', () => {
    it('should update plan step status', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'pending' },
      ];

      processor.processChunk(createEventChunk('plan', { steps }));

      processor.processChunk(
        createEventChunk('plan_step', {
          stepId: '1',
          status: 'completed',
          plan: steps,
        }),
      );

      const plan = processor.getPlan();
      expect(plan[0].status).toBe('completed');
    });

    it('should calculate plan progress', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'completed' },
        { id: '2', description: 'Step 2', status: 'completed' },
        { id: '3', description: 'Step 3', status: 'pending' },
      ];

      processor.processChunk(createEventChunk('plan', { steps }));

      const stats = processor.getStats();
      expect(stats.planStepsTotal).toBe(3);
      expect(stats.planStepsCompleted).toBe(2);
    });
  });

  describe('event filtering', () => {
    it('should filter thinking events when disabled', () => {
      const filteredProcessor = new StreamProcessor({
        ...defaultOptions,
        showThinking: false,
      });

      const chunk = createEventChunk('thinking', { content: 'Hidden' });

      const events = filteredProcessor.processChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it('should filter plan events when disabled', () => {
      const filteredProcessor = new StreamProcessor({
        ...defaultOptions,
        showPlan: false,
      });

      const chunk = createEventChunk('plan', { steps: [] });

      const events = filteredProcessor.processChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it('should filter tool events when disabled', () => {
      const filteredProcessor = new StreamProcessor({
        ...defaultOptions,
        showTools: false,
      });

      const chunk = createEventChunk('tool_start', {
        toolId: 't1',
        name: 'tool',
        input: {},
      });

      const events = filteredProcessor.processChunk(chunk);
      expect(events).toHaveLength(0);
    });
  });

  describe('event callbacks', () => {
    it('should call event callback', () => {
      const callback = vi.fn();
      processor.onEvent('thinking', callback);

      processor.processChunk(createEventChunk('thinking', { content: 'test' }));

      expect(callback).toHaveBeenCalled();
    });

    it('should call complete callback', () => {
      const callback = vi.fn();
      processor.onComplete(callback);

      processor.processChunk(createEventChunk('complete', {}));

      expect(callback).toHaveBeenCalled();
    });

    it('should call error callback', () => {
      const callback = vi.fn();
      processor.onError(callback);

      processor.processChunk(createEventChunk('error', { message: 'error' }));

      expect(callback).toHaveBeenCalledWith('error');
    });

    it('should allow unsubscribing callbacks', () => {
      const callback = vi.fn();
      const unsubscribe = processor.onEvent('thinking', callback);

      unsubscribe();

      processor.processChunk(createEventChunk('thinking', { content: 'test' }));

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('event storage', () => {
    it('should store events', () => {
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));

      expect(processor.getEvents()).toHaveLength(1);
    });

    it('should get events by type', () => {
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));
      processor.processChunk(createEventChunk('complete', {}));

      expect(processor.getEventsByType('thinking')).toHaveLength(1);
      expect(processor.getEventsByType('complete')).toHaveLength(1);
    });

    it('should limit stored events', () => {
      const limitedProcessor = new StreamProcessor({
        ...defaultOptions,
        maxEvents: 5,
      });

      for (let i = 0; i < 10; i++) {
        limitedProcessor.processChunk(
          createEventChunk('thinking', { content: `test ${i}` }),
        );
      }

      expect(limitedProcessor.getEvents()).toHaveLength(5);
    });

    it('should get recent events', () => {
      for (let i = 0; i < 5; i++) {
        processor.processChunk(
          createEventChunk('thinking', { content: `test ${i}` }),
        );
      }

      const recent = processor.getRecentEvents(3);
      expect(recent).toHaveLength(3);
    });
  });

  describe('statistics', () => {
    it('should track event counts by type', () => {
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));
      processor.processChunk(
        createEventChunk('thinking', { content: 'test2' }),
      );
      processor.processChunk(createEventChunk('complete', {}));

      const stats = processor.getStats();
      expect(stats.eventsByType.thinking).toBe(2);
      expect(stats.eventsByType.complete).toBe(1);
    });

    it('should track total events', () => {
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));

      const stats = processor.getStats();
      expect(stats.totalEvents).toBe(1);
    });

    it('should track timestamps', () => {
      const before = new Date().toISOString();
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));
      const stats = processor.getStats();

      expect(stats.startTime).toBeDefined();
      expect(stats.lastEventTime).toBeDefined();
    });
  });

  describe('resource cleanup', () => {
    it('stores flushed events in history as well as returning them', () => {
      const partial = `${createEventChunk('thinking', { content: 'buffered' })}garbage`;
      processor.processChunk(partial);

      const flushed = processor.flush();

      expect(flushed.some((event) => event.type === 'error')).toBe(true);
      expect(
        processor.getEvents().some((event) => event.type === 'error'),
      ).toBe(true);
    });

    it('should clear all state', () => {
      processor.processChunk(
        createEventChunk('plan', {
          steps: [{ id: '1', description: 'Step', status: 'pending' }],
        }),
      );
      processor.processChunk(
        createEventChunk('tool_start', {
          toolId: 't1',
          name: 'tool',
          input: {},
        }),
      );

      processor.clear();

      expect(processor.getEvents()).toHaveLength(0);
      expect(processor.getPlan()).toHaveLength(0);
      expect(processor.getActiveTools()).toHaveLength(0);
      expect(processor.getStats().totalEvents).toBe(0);
    });

    it('should dispose resources', () => {
      processor.processChunk(createEventChunk('thinking', { content: 'test' }));

      processor.dispose();

      expect(processor.getEvents()).toHaveLength(0);
    });
  });
});

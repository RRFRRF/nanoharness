/**
 * Parser Tests for Streaming Module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StreamParser } from '../parser.js';
import {
  STREAM_MARKERS,
  LEGACY_MARKERS,
  StreamEvent,
  PlanStep,
} from '../types.js';

describe('StreamParser', () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  describe('thinking parsing', () => {
    it('should parse thinking block', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"I need to analyze this problem"}}
${STREAM_MARKERS.THINKING_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('thinking');
      expect((events[0].data as { content: string }).content).toBe(
        'I need to analyze this problem',
      );
    });

    it('should handle incomplete thinking block', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"incomplete`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(0);

      // Complete the block
      const events2 = parser.parseChunk(` content"}}
${STREAM_MARKERS.THINKING_END}`);
      expect(events2).toHaveLength(1);
    });

    it('should parse multiple thinking blocks', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"First thought"}}
${STREAM_MARKERS.THINKING_END}
${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:01Z","data":{"content":"Second thought"}}
${STREAM_MARKERS.THINKING_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(2);
      expect((events[0].data as { content: string }).content).toBe('First thought');
      expect((events[1].data as { content: string }).content).toBe('Second thought');
    });

    it('should update current thinking', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"Updated thought"}}
${STREAM_MARKERS.THINKING_END}`;

      parser.parseChunk(chunk);
      expect(parser.getCurrentThinking()).toBe('Updated thought');
    });
  });

  describe('plan parsing', () => {
    it('should parse plan with steps', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'pending' },
        { id: '2', description: 'Step 2', status: 'in_progress' },
      ];
      const chunk = `${STREAM_MARKERS.PLAN_START}
{"type":"plan","timestamp":"2024-01-01T00:00:00Z","data":{"steps":${JSON.stringify(steps)}}}
${STREAM_MARKERS.PLAN_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('plan');
      expect((events[0].data as { steps: PlanStep[] }).steps).toHaveLength(2);
    });

    it('should update current plan', () => {
      const steps: PlanStep[] = [
        { id: '1', description: 'Step 1', status: 'completed' },
      ];
      const chunk = `${STREAM_MARKERS.PLAN_START}
{"type":"plan","timestamp":"2024-01-01T00:00:00Z","data":{"steps":${JSON.stringify(steps)}}}
${STREAM_MARKERS.PLAN_END}`;

      parser.parseChunk(chunk);
      const plan = parser.getCurrentPlan();
      expect(plan).toHaveLength(1);
      expect(plan[0].description).toBe('Step 1');
    });

    it('should parse plan step update', () => {
      const chunk = `${STREAM_MARKERS.PLAN_STEP}{"type":"plan_step","timestamp":"2024-01-01T00:00:00Z","data":{"stepId":"1","status":"completed","plan":[]}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('plan_step');
    });
  });

  describe('tool events parsing', () => {
    it('should parse tool start event', () => {
      const chunk = `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t1","name":"read_file","input":{"path":"/test"}}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_start');
      expect((events[0].data as { name: string }).name).toBe('read_file');
    });

    it('should parse tool progress event', () => {
      const chunk = `${STREAM_MARKERS.TOOL_PROGRESS}{"type":"tool_progress","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t1","name":"read_file","message":"Reading...","percent":50}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_progress');
      expect((events[0].data as { percent: number }).percent).toBe(50);
    });

    it('should parse tool complete event', () => {
      const chunk = `${STREAM_MARKERS.TOOL_COMPLETE}{"type":"tool_complete","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t1","name":"read_file","duration":100,"result":"content"}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('tool_complete');
    });
  });

  describe('decision parsing', () => {
    it('should parse decision event', () => {
      const chunk = `${STREAM_MARKERS.DECISION}{"type":"decision","timestamp":"2024-01-01T00:00:00Z","data":{"description":"Choose action","choice":"use_tool"}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('decision');
      expect((events[0].data as { choice: string }).choice).toBe('use_tool');
    });
  });

  describe('content parsing', () => {
    it('should parse content block', () => {
      const chunk = `${STREAM_MARKERS.CONTENT_START}
{"type":"content","timestamp":"2024-01-01T00:00:00Z","data":{"text":"Final result"}}
${STREAM_MARKERS.CONTENT_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('content');
      expect((events[0].data as { text: string }).text).toBe('Final result');
    });
  });

  describe('complete and error parsing', () => {
    it('should parse complete event', () => {
      const chunk = `${STREAM_MARKERS.COMPLETE}{"type":"complete","timestamp":"2024-01-01T00:00:00Z","data":{}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('complete');
    });

    it('should parse error event', () => {
      const chunk = `${STREAM_MARKERS.ERROR}{"type":"error","timestamp":"2024-01-01T00:00:00Z","data":{"message":"Something went wrong"}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect((events[0].data as { message: string }).message).toBe('Something went wrong');
    });
  });

  describe('mixed event streams', () => {
    it('should parse mixed event stream', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"Analyzing"}}
${STREAM_MARKERS.THINKING_END}
${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:01Z","data":{"toolId":"t1","name":"tool","input":{}}}
${STREAM_MARKERS.TOOL_COMPLETE}{"type":"tool_complete","timestamp":"2024-01-01T00:00:02Z","data":{"toolId":"t1","name":"tool","duration":100,"result":null}}
${STREAM_MARKERS.COMPLETE}{"type":"complete","timestamp":"2024-01-01T00:00:03Z","data":{}}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(4);
      expect(events[0].type).toBe('thinking');
      expect(events[1].type).toBe('tool_start');
      expect(events[2].type).toBe('tool_complete');
      expect(events[3].type).toBe('complete');
    });

    it('"should handle events split across chunks"', () => {
      const chunk1 = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"First part`;
      const chunk2 = ` of content"}}
${STREAM_MARKERS.THINKING_END}`;

      const events1 = parser.parseChunk(chunk1);
      expect(events1).toHaveLength(0);

      const events2 = parser.parseChunk(chunk2);
      expect(events2).toHaveLength(1);
      expect((events2[0].data as { content: string }).content).toBe('First part of content');
    });
  });

  describe('"buffer management"', () => {
    it('"should handle buffer size limit"', () => {
      const largeParser = new StreamParser({ maxBufferSize: 100 });
      const largeChunk = '"x"'.repeat(200);

      largeParser.parseChunk(largeChunk);
      expect(largeParser.getBufferSize()).toBeLessThanOrEqual(100);
    });

    it('"should clear buffer on flush"', () => {
      parser.parseChunk('"unparsed content"');
      expect(parser.getBufferSize()).toBeGreaterThan(0);

      parser.flush();
      expect(parser.getBufferSize()).toBe(0);
    });

    it('"should create error event for unparsed content on flush"', () => {
      parser.parseChunk('"unparsed content"');
      const events = parser.flush();

      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].type).toBe('error');
    });
  });

  describe('"clear and reset"', () => {
    it('"should clear all state"', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"test"}}
${STREAM_MARKERS.THINKING_END}`;

      parser.parseChunk(chunk);
      expect(parser.getCurrentThinking()).toBe('test');

      parser.clear();
      expect(parser.getCurrentThinking()).toBe('');
      expect(parser.getCurrentPlan()).toHaveLength(0);
      expect(parser.getBufferSize()).toBe(0);
    });
  });

  describe('"legacy output parsing"', () => {
    it('"should parse legacy output format"', () => {
      const chunk = `${LEGACY_MARKERS.OUTPUT_START}
{"status":"success","result":"Legacy result","newSessionId":"123"}
${LEGACY_MARKERS.OUTPUT_END}`;

      const events = parser.parseChunk(chunk);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('content');
    });

    it('"should ignore legacy status event format"', () => {
      const chunk = `${LEGACY_MARKERS.OUTPUT_START}
{"status":"success","result":null,"event":{"type":"status","text":"Working"}}
${LEGACY_MARKERS.OUTPUT_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(0);
    });
  });

  describe('"error handling"', () => {
    it('"should create error event for invalid JSON"', () => {
      const chunk = `${STREAM_MARKERS.THINKING_START}
invalid json
${STREAM_MARKERS.THINKING_END}`;

      const events = parser.parseChunk(chunk);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
    });

    it('"should limit error content length"', () => {
      const longContent = '"x"'.repeat(1000);
      const chunk = `${STREAM_MARKERS.THINKING_START}
${longContent}
${STREAM_MARKERS.THINKING_END}`;

      const events = parser.parseChunk(chunk);
      const errorEvent = events.find((e) => e.type === 'error');
      if (errorEvent) {
        const content = (errorEvent.data as { content?: string }).content || '';
        expect(content.length).toBeLessThanOrEqual(500);
      }
    });
  });
});

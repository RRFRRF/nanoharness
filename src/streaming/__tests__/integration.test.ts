/**
 * Integration Tests for Streaming Module
 * Tests end-to-end streaming from container to host
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StreamParser, StreamProcessor } from '../index.js';
import { STREAM_MARKERS } from '../types.js';

describe('Streaming Integration', () => {
  let parser: StreamParser;
  let processor: StreamProcessor;

  beforeEach(() => {
    parser = new StreamParser();
    processor = new StreamProcessor({
      sessionId: 'test-session',
      groupName: 'test-group',
      showThinking: true,
      showPlan: true,
      showTools: true,
      maxEvents: 1000,
    });
  });

  describe('end-to-end streaming', () => {
    it('should stream complete agent execution', () => {
      // Simulate container output
      const containerOutput = [
        // Thinking phase
        `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","sessionId":"test-session","data":{"content":"Analyzing the request..."}}
${STREAM_MARKERS.THINKING_END}`,
        // Plan phase
        `${STREAM_MARKERS.PLAN_START}
{"type":"plan","timestamp":"2024-01-01T00:00:01Z","sessionId":"test-session","data":{"steps":[{"id":"1","description":"Read file","status":"pending"},{"id":"2","description":"Process data","status":"pending"}]}}
${STREAM_MARKERS.PLAN_END}`,
        // Tool execution
        `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:02Z","sessionId":"test-session","data":{"toolId":"t1","name":"read_file","input":{"path":"/data.txt"}}}`,
        `${STREAM_MARKERS.TOOL_PROGRESS}{"type":"tool_progress","timestamp":"2024-01-01T00:00:03Z","sessionId":"test-session","data":{"toolId":"t1","name":"read_file","message":"Reading...","percent":50}}`,
        `${STREAM_MARKERS.TOOL_COMPLETE}{"type":"tool_complete","timestamp":"2024-01-01T00:00:04Z","sessionId":"test-session","data":{"toolId":"t1","name":"read_file","duration":500,"result":"File content"}}`,
        // Step update
        `${STREAM_MARKERS.PLAN_STEP}{"type":"plan_step","timestamp":"2024-01-01T00:00:05Z","sessionId":"test-session","data":{"stepId":"1","status":"completed","plan":[]}}`,
        // Content output
        `${STREAM_MARKERS.CONTENT_START}
{"type":"content","timestamp":"2024-01-01T00:00:06Z","sessionId":"test-session","data":{"text":"Here is the result"}}
${STREAM_MARKERS.CONTENT_END}`,
        // Complete
        `${STREAM_MARKERS.COMPLETE}{"type":"complete","timestamp":"2024-01-01T00:00:07Z","sessionId":"test-session","data":{}}`,
      ].join('\n');

      // Parse through parser and process
      const parsedEvents = parser.parseChunk(containerOutput);
      expect(parsedEvents.length).toBeGreaterThan(0);

      // Process raw chunks through processor
      processor.processChunk(containerOutput);

      // Verify final state
      expect(processor.isComplete()).toBe(true);
      expect(processor.getPlan()).toHaveLength(2);
      expect(processor.getStats().totalEvents).toBeGreaterThan(0);
    });

    it('should handle chunked streaming', () => {
      const chunks = [
        `${STREAM_MARKERS.THINKING_START}
{"type":"th`,
        `inking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"First`,
        ` part"}}
${STREAM_MARKERS.THINKING_END}`,
        `${STREAM_MARKERS.TOOL_START}{"type":"tool`,
        `_start","timestamp":"2024-01-01T00:00:01Z","data":{"toolId":"t1","name":"tool","input":{}}}`,
      ];

      let allEvents: any[] = [];
      for (const chunk of chunks) {
        const events = parser.parseChunk(chunk);
        allEvents = allEvents.concat(events);
      }

      expect(allEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle concurrent tool executions', () => {
      const containerOutput = [
        `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t1","name":"tool1","input":{}}}`,
        `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:01Z","data":{"toolId":"t2","name":"tool2","input":{}}}`,
        `${STREAM_MARKERS.TOOL_COMPLETE}{"type":"tool_complete","timestamp":"2024-01-01T00:00:02Z","data":{"toolId":"t2","name":"tool2","duration":100,"result":null}}`,
        `${STREAM_MARKERS.TOOL_COMPLETE}{"type":"tool_complete","timestamp":"2024-01-01T00:00:03Z","data":{"toolId":"t1","name":"tool1","duration":200,"result":null}}`,
      ].join('\n');

      processor.processChunk(containerOutput);

      // Both tools should be completed
      const activeTools = processor.getActiveTools();
      expect(activeTools).toHaveLength(0);
    });

    it('should handle error during execution', () => {
      const containerOutput = [
        `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"Starting..."}}
${STREAM_MARKERS.THINKING_END}`,
        `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:01Z","data":{"toolId":"t1","name":"risky_tool","input":{}}}`,
        `${STREAM_MARKERS.ERROR}{"type":"error","timestamp":"2024-01-01T00:00:02Z","data":{"message":"Tool execution failed"}}`,
      ].join('\n');

      processor.processChunk(containerOutput);

      expect(processor.hasError()).toBe(true);
      expect(processor.getCurrentStatus().errorMessage).toBe('Tool execution failed');
    });
  });

  describe('backward compatibility', () => {
    it('should handle legacy output format', () => {
      const legacyOutput = `
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Legacy result","newSessionId":"123"}
---NANOCLAW_OUTPUT_END---
      `;

      processor.processChunk(legacyOutput);
      const events = processor.getEvents();
      expect(events.length).toBeGreaterThan(0);
    });

    it('should handle mixed legacy and new format', () => {
      const mixedOutput = [
        `${STREAM_MARKERS.THINKING_START}
{"type":"thinking","timestamp":"2024-01-01T00:00:00Z","data":{"content":"Thinking..."}}
${STREAM_MARKERS.THINKING_END}`,
        `---NANOCLAW_OUTPUT_START---
{"status":"success","result":"Legacy","event":{"type":"status","text":"Working"}}
---NANOCLAW_OUTPUT_END---`,
        `${STREAM_MARKERS.COMPLETE}{"type":"complete","timestamp":"2024-01-01T00:00:01Z","data":{}}`,
      ].join('\n');

      processor.processChunk(mixedOutput);
      const events = processor.getEvents();
      expect(events.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('performance', () => {
    it('should handle large event streams efficiently', () => {
      const events: string[] = [];
      for (let i = 0; i < 100; i++) {
        events.push(
          `${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:${i.toString().padStart(2, '0')}Z","data":{"toolId":"t${i}","name":"tool${i}","input":{}}}`,
        );
      }

      const startTime = Date.now();
      processor.processChunk(events.join('\n'));
      const duration = Date.now() - startTime;

      expect(processor.getEvents()).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should complete in less than 1 second
    });

    it('should handle rapid successive chunks', () => {
      const rapidChunks = Array.from({ length: 50 }, (_, i) =>
        `${STREAM_MARKERS.TOOL_PROGRESS}{"type":"tool_progress","timestamp":"2024-01-01T00:00:${i}Z","data":{"toolId":"t1","name":"tool","message
message":"Progress ${i}","percent":${i * 2}}}`);

      let allEvents: any[] = [];
      for (const chunk of rapidChunks) {
        const events = processor.processChunk(chunk);
        allEvents = allEvents.concat(events);
      }

      expect(allEvents).toHaveLength(50);
    });
  });

  describe('memory management', () => {
    it('should not leak memory with many events', () => {
      const limitedProcessor = new StreamProcessor({
        sessionId: 'test',
        groupName: 'test',
        maxEvents: 10,
      });

      // Generate many events
      for (let i = 0; i < 100; i++) {
        limitedProcessor.processChunk(`${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t${i}","name":"tool","input":{}}}`);
      }

      // Should be limited to maxEvents
      expect(limitedProcessor.getEvents()).toHaveLength(10);
    });

    it('should properly cleanup resources', () => {
      processor.processChunk(`${STREAM_MARKERS.PLAN_START}{"type":"plan","timestamp":"2024-01-01T00:00:00Z","data":{"steps":[{"id":"1","description":"Step","status":"pending"}]}}${STREAM_MARKERS.PLAN_END}`);
      processor.processChunk(`${STREAM_MARKERS.TOOL_START}{"type":"tool_start","timestamp":"2024-01-01T00:00:00Z","data":{"toolId":"t1","name":"tool","input":{}}}`);

      // Dispose and verify cleanup
      processor.dispose();

      expect(processor.getEvents()).toHaveLength(0);
    });
  });
});

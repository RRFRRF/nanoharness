/**
 * Stream Parser for NanoClaw
 * Parses stream chunks into structured events
 */

import {
  StreamEvent,
  StreamEventType,
  PlanStep,
  STREAM_MARKERS,
  LEGACY_MARKERS,
  ThinkingEventData,
  PlanEventData,
  PlanStepEventData,
  ToolStartEventData,
  ToolProgressEventData,
  ToolCompleteEventData,
  DecisionEventData,
  ContentEventData,
  ErrorEventData,
} from './types.js';

// Parser configuration
interface ParserConfig {
  maxBufferSize: number;
  enableLegacyParsing: boolean;
  emitResidualBufferErrors: boolean;
}

const DEFAULT_CONFIG: ParserConfig = {
  maxBufferSize: 1024 * 1024, // 1MB
  enableLegacyParsing: true,
  emitResidualBufferErrors: true,
};

/**
 * Stream Parser
 * Parses raw stream output into structured StreamEvent objects
 */
export class StreamParser {
  private buffer: string = '';
  private config: ParserConfig;
  private currentThinking: string = '';
  private currentPlan: PlanStep[] = [];
  private parsingState: 'idle' | 'thinking' | 'plan' | 'content' = 'idle';

  constructor(config: Partial<ParserConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Parse a chunk of stream data
   * Returns array of parsed events
   */
  parseChunk(chunk: string): StreamEvent[] {
    this.buffer += chunk;

    // Check for buffer overflow
    if (this.buffer.length > this.config.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.config.maxBufferSize);
    }

    const events: StreamEvent[] = [];

    // Process buffer until no more complete events
    while (true) {
      const event = this.tryParseNextEvent();
      if (!event) break;
      events.push(event);
    }

    return events;
  }

  /**
   * Try to parse the next event from buffer
   */
  private tryParseNextEvent(): StreamEvent | null {
    if (this.parsingState !== 'idle') {
      return null;
    }

    const nextMarker = this.findNextMarker();
    if (!nextMarker) {
      return null;
    }

    if (nextMarker.kind === 'legacy') {
      return this.parseLegacyOutput();
    }

    if (nextMarker.kind === 'block') {
      if (nextMarker.type === 'thinking') return this.parseThinkingBlock();
      if (nextMarker.type === 'plan') return this.parsePlanBlock();
      return this.parseContentBlock();
    }

    return this.parseSingleLineEvent(nextMarker.marker, nextMarker.type);
  }

  private findNextMarker():
    | {
        kind: 'block';
        marker: string;
        type: 'thinking' | 'plan' | 'content';
      }
    | { kind: 'single'; marker: string; type: StreamEventType }
    | { kind: 'legacy'; marker: string; type: 'legacy' }
    | null {
    const candidates: Array<{
      index: number;
      marker: string;
      kind: 'block' | 'single' | 'legacy';
      type: StreamEventType | 'legacy';
    }> = [];

    const blockMarkers = [
      {
        marker: STREAM_MARKERS.THINKING_START,
        type: 'thinking' as const,
      },
      {
        marker: STREAM_MARKERS.PLAN_START,
        type: 'plan' as const,
      },
      {
        marker: STREAM_MARKERS.CONTENT_START,
        type: 'content' as const,
      },
    ];

    for (const { marker, type } of blockMarkers) {
      const index = this.buffer.indexOf(marker);
      if (index !== -1) {
        candidates.push({ index, marker, kind: 'block', type });
      }
    }

    const singleLineMarkers = [
      {
        marker: STREAM_MARKERS.PLAN_STEP,
        type: 'plan_step' as StreamEventType,
      },
      {
        marker: STREAM_MARKERS.TOOL_START,
        type: 'tool_start' as StreamEventType,
      },
      {
        marker: STREAM_MARKERS.TOOL_PROGRESS,
        type: 'tool_progress' as StreamEventType,
      },
      {
        marker: STREAM_MARKERS.TOOL_COMPLETE,
        type: 'tool_complete' as StreamEventType,
      },
      {
        marker: STREAM_MARKERS.DECISION,
        type: 'decision' as StreamEventType,
      },
      {
        marker: STREAM_MARKERS.COMPLETE,
        type: 'complete' as StreamEventType,
      },
      { marker: STREAM_MARKERS.ERROR, type: 'error' as StreamEventType },
    ];

    for (const { marker, type } of singleLineMarkers) {
      const index = this.buffer.indexOf(marker);
      if (index !== -1) {
        candidates.push({ index, marker, kind: 'single', type });
      }
    }

    if (this.config.enableLegacyParsing) {
      const index = this.buffer.indexOf(LEGACY_MARKERS.OUTPUT_START);
      if (index !== -1) {
        candidates.push({
          index,
          marker: LEGACY_MARKERS.OUTPUT_START,
          kind: 'legacy',
          type: 'legacy',
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a.index - b.index);
    return candidates[0] as
      | {
          kind: 'block';
          marker: string;
          type: 'thinking' | 'plan' | 'content';
        }
      | { kind: 'single'; marker: string; type: StreamEventType }
      | { kind: 'legacy'; marker: string; type: 'legacy' };
  }

  /**
   * Parse a thinking block
   */
  private parseThinkingBlock(): StreamEvent | null {
    const startIdx = this.buffer.indexOf(STREAM_MARKERS.THINKING_START);
    if (startIdx === -1) return null;

    const endIdx = this.buffer.indexOf(STREAM_MARKERS.THINKING_END, startIdx);
    if (endIdx === -1) {
      // Incomplete block, wait for more data
      return null;
    }

    const jsonStr = this.buffer
      .slice(startIdx + STREAM_MARKERS.THINKING_START.length, endIdx)
      .trim();

    this.buffer =
      this.buffer.slice(0, startIdx) +
      this.buffer.slice(endIdx + STREAM_MARKERS.THINKING_END.length);

    try {
      const event = JSON.parse(jsonStr) as StreamEvent;
      if (event.type === 'thinking') {
        const data = event.data as ThinkingEventData;
        this.currentThinking = data.content;
      }
      return event;
    } catch (err) {
      return this.createParseErrorEvent('thinking', jsonStr, err);
    }
  }

  /**
   * Parse a plan block
   */
  private parsePlanBlock(): StreamEvent | null {
    const startIdx = this.buffer.indexOf(STREAM_MARKERS.PLAN_START);
    if (startIdx === -1) return null;

    const endIdx = this.buffer.indexOf(STREAM_MARKERS.PLAN_END, startIdx);
    if (endIdx === -1) {
      return null;
    }

    const jsonStr = this.buffer
      .slice(startIdx + STREAM_MARKERS.PLAN_START.length, endIdx)
      .trim();

    this.buffer =
      this.buffer.slice(0, startIdx) +
      this.buffer.slice(endIdx + STREAM_MARKERS.PLAN_END.length);

    try {
      const event = JSON.parse(jsonStr) as StreamEvent;
      if (event.type === 'plan') {
        const data = event.data as PlanEventData;
        this.currentPlan = data.steps || [];
      }
      return event;
    } catch (err) {
      return this.createParseErrorEvent('plan', jsonStr, err);
    }
  }

  /**
   * Parse a content block
   */
  private parseContentBlock(): StreamEvent | null {
    const startIdx = this.buffer.indexOf(STREAM_MARKERS.CONTENT_START);
    if (startIdx === -1) return null;

    const endIdx = this.buffer.indexOf(STREAM_MARKERS.CONTENT_END, startIdx);
    if (endIdx === -1) {
      return null;
    }

    const jsonStr = this.buffer
      .slice(startIdx + STREAM_MARKERS.CONTENT_START.length, endIdx)
      .trim();

    this.buffer =
      this.buffer.slice(0, startIdx) +
      this.buffer.slice(endIdx + STREAM_MARKERS.CONTENT_END.length);

    try {
      return JSON.parse(jsonStr) as StreamEvent;
    } catch (err) {
      return this.createParseErrorEvent('content', jsonStr, err);
    }
  }

  /**
   * Parse a single-line event (marker + JSON on same/next line)
   */
  private parseSingleLineEvent(
    marker: string,
    type: StreamEventType,
  ): StreamEvent | null {
    const markerIdx = this.buffer.indexOf(marker);
    if (markerIdx === -1) return null;

    let jsonStart = markerIdx + marker.length;
    while (
      jsonStart < this.buffer.length &&
      /\s/.test(this.buffer[jsonStart] || '')
    ) {
      jsonStart += 1;
    }

    if (jsonStart >= this.buffer.length) {
      return null;
    }

    const firstChar = this.buffer[jsonStart];
    if (firstChar !== '{' && firstChar !== '[') {
      return null;
    }

    const jsonEnd = this.findJsonBoundary(jsonStart);
    if (jsonEnd === null) return null;

    const jsonStr = this.buffer.slice(jsonStart, jsonEnd);
    let endPos = jsonEnd;
    while (
      endPos < this.buffer.length &&
      /\s/.test(this.buffer[endPos] || '')
    ) {
      endPos += 1;
    }

    this.buffer = this.buffer.slice(0, markerIdx) + this.buffer.slice(endPos);

    try {
      const event = JSON.parse(jsonStr) as StreamEvent;

      // Update internal state based on event type
      switch (type) {
        case 'plan_step': {
          const data = event.data as PlanStepEventData;
          if (data.plan) {
            this.currentPlan = data.plan;
          }
          break;
        }
      }

      return event;
    } catch (err) {
      return this.createParseErrorEvent(type, jsonStr, err);
    }
  }

  private findJsonBoundary(startIdx: number): number | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{' || char === '[') {
        depth += 1;
        continue;
      }
      if (char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) {
          return i + 1;
        }
      }
    }

    return null;
  }

  /**
   * Parse legacy output format
   */
  private parseLegacyOutput(): StreamEvent | null {
    const startIdx = this.buffer.indexOf(LEGACY_MARKERS.OUTPUT_START);
    if (startIdx === -1) return null;

    const endIdx = this.buffer.indexOf(LEGACY_MARKERS.OUTPUT_END, startIdx);
    if (endIdx === -1) {
      return null;
    }

    const jsonStr = this.buffer
      .slice(startIdx + LEGACY_MARKERS.OUTPUT_START.length, endIdx)
      .trim();

    this.buffer =
      this.buffer.slice(0, startIdx) +
      this.buffer.slice(endIdx + LEGACY_MARKERS.OUTPUT_END.length);

    try {
      const legacyData = JSON.parse(jsonStr) as {
        status: string;
        result: string | null;
        newSessionId?: string;
        event?: { type: string; text: string };
        error?: string;
      };

      // Convert legacy format to stream event
      if (legacyData.event) {
        if (legacyData.event.type === 'assistant') {
          return {
            type: 'content',
            timestamp: new Date().toISOString(),
            data: { text: legacyData.event.text },
          };
        }
        if (legacyData.event.type === 'status') {
          return null;
        }
      }

      if (legacyData.result) {
        return {
          type: 'content',
          timestamp: new Date().toISOString(),
          data: { text: legacyData.result },
        };
      }

      if (legacyData.error) {
        return {
          type: 'error',
          timestamp: new Date().toISOString(),
          data: { message: legacyData.error },
        };
      }

      return null;
    } catch (err) {
      return this.createParseErrorEvent('legacy', jsonStr, err);
    }
  }

  /**
   * Create a parse error event
   */
  private createParseErrorEvent(
    expectedType: string,
    content: string,
    error: unknown,
  ): StreamEvent {
    return {
      type: 'error',
      timestamp: new Date().toISOString(),
      data: {
        message: `Failed to parse ${expectedType} event`,
        parseError: error instanceof Error ? error.message : String(error),
        content: content.slice(0, 500), // Limit content in error
      },
    };
  }

  /**
   * Get current thinking content
   */
  getCurrentThinking(): string {
    return this.currentThinking;
  }

  /**
   * Get current plan
   */
  getCurrentPlan(): PlanStep[] {
    return [...this.currentPlan];
  }

  /**
   * Flush any remaining content in buffer as events
   */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];

    // Try to parse any remaining complete events
    while (true) {
      const event = this.tryParseNextEvent();
      if (!event) break;
      events.push(event);
    }

    // Clear remaining buffer
    if (this.config.emitResidualBufferErrors && this.buffer.trim()) {
      // Check if there's any content that might be a partial event
      const trimmed = this.buffer.trim();
      if (trimmed.length > 0) {
        events.push({
          type: 'error',
          timestamp: new Date().toISOString(),
          data: {
            message: 'Unparsed content in buffer',
            content: trimmed.slice(0, 500),
          },
        });
      }
    }

    this.buffer = '';
    return events;
  }

  /**
   * Clear the parser state
   */
  clear(): void {
    this.buffer = '';
    this.currentThinking = '';
    this.currentPlan = [];
    this.parsingState = 'idle';
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}

// Default export
export default StreamParser;

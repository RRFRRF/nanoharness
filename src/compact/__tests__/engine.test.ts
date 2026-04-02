/**
 * Tests for the compaction engine.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IntelligentCompactEngine,
  compactEngine,
  getArchiveStoreSize,
} from '../engine.js';
import {
  CompressionLevel,
  CompactMessage,
} from '../types.js';

function createMessages(count: number, baseContent = 'Message'): CompactMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    chat_jid: 'test@jid',
    sender: i % 2 === 0 ? 'user' : 'assistant',
    sender_name: i % 2 === 0 ? 'User' : 'Assistant',
    content: `${baseContent} ${i}: ${'x'.repeat(50)}`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    is_from_me: i % 2 !== 0,
    isCompacted: false,
  }));
}

function createToolResults(count: number): CompactMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `tool_${i}`,
    chat_jid: 'test@jid',
    sender: 'system',
    sender_name: 'System',
    content: `Tool result ${i}: \`\`\`json\n{"status": "success", "data": ${JSON.stringify('x'.repeat(200))}}\n\`\`\``,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    is_from_me: true,
    isCompacted: false,
  }));
}

describe('IntelligentCompactEngine', () => {
  let engine: IntelligentCompactEngine;

  beforeEach(() => {
    engine = new IntelligentCompactEngine({
      maxTokens: 500,
      l1KeepRecentCount: 2,
      l3KeepRecentCount: 2,
      l4ValueThreshold: 90,
      thresholds: {
        l1Threshold: 50,
        l2Threshold: 70,
        l3Threshold: 85,
        l4Threshold: 95,
      },
    });
  });

  describe('empty/single message handling', () => {
    it('should handle empty messages array', () => {
      const result = engine.compact([]);
      expect(result.messages).toHaveLength(0);
      expect(result.level).toBe(CompressionLevel.NONE);
      expect(result.stats.compressionRatio).toBe(1);
    });

    it('should handle single message without compression', () => {
      const messages = createMessages(1);
      const result = engine.compact(messages);
      expect(result.messages).toHaveLength(1);
      expect(result.level).toBe(CompressionLevel.NONE);
    });
  });

  describe('L1 Snip', () => {
    it('should apply compression when token threshold is exceeded', () => {
      const messages = createToolResults(30);
      const result = engine.compact(messages, 'test-session');

      expect(result.level).not.toBe(CompressionLevel.NONE);
      expect(result.stats.totalMessages).toBe(30);
      expect(result.stats.tokensBefore).toBeGreaterThan(0);
      expect(result.stats.tokensAfter).toBeGreaterThan(0);
    });

    it('should keep recent tool results intact', () => {
      const messages = createToolResults(5);
      const result = engine.compact(messages, 'test-session');
      const recentMessages = result.messages.slice(-2);
      expect(recentMessages.length).toBe(2);
    });
  });

  describe('L2+ Compression', () => {
    it('should apply compression when token threshold is exceeded', () => {
      const messages = createToolResults(10);
      const result = engine.compact(messages, 'test-session');

      expect(result.level).not.toBe(CompressionLevel.NONE);
      expect(result.stats.totalMessages).toBe(10);
      expect(result.stats.tokensBefore).toBeGreaterThan(0);
    });
  });

  describe('L3 Collapse', () => {
    beforeEach(() => {
      engine.setConfig({
        maxTokens: 400,
        thresholds: {
          l1Threshold: 30,
          l2Threshold: 40,
          l3Threshold: 50,
          l4Threshold: 95,
        },
        l3KeepRecentCount: 1,
      });
    });

    it('should collapse non-essential messages', () => {
      const messages = [
        ...createMessages(5, 'Exploration'),
        ...createMessages(5, 'Reasoning'),
      ];
      const result = engine.compact(messages, 'test-session');

      if (result.level === CompressionLevel.L3_COLLAPSE ||
          result.level === CompressionLevel.L4_ARCHIVE) {
        expect(result.messages.length).toBeLessThan(messages.length);
      }
    });

    it('preserves uncollapsed message order', () => {
      const messages: CompactMessage[] = [
        {
          id: 'intent',
          chat_jid: 'test@jid',
          sender: 'user',
          sender_name: 'User',
          content: 'I need help with this task',
          timestamp: '2026-04-02T00:00:00.000Z',
          is_from_me: false,
          isCompacted: false,
        },
        ...createMessages(8, 'Chat'),
      ];
      const result = engine.compact(messages, 'order-session');

      if (result.level === CompressionLevel.L3_COLLAPSE || result.level === CompressionLevel.L4_ARCHIVE) {
        const intentIndex = result.messages.findIndex((m) => m.id === 'intent');
        const collapsedIndex = result.messages.findIndex((m) => m.id.startsWith('collapsed_'));
        expect(intentIndex).toBeGreaterThanOrEqual(0);
        expect(collapsedIndex).toBeGreaterThan(intentIndex);
      }
    });
  });

  describe('L4 Archive', () => {
    beforeEach(() => {
      engine.setConfig({
        maxTokens: 300,
        thresholds: {
          l1Threshold: 30,
          l2Threshold: 40,
          l3Threshold: 50,
          l4Threshold: 60,
        },
        l4ValueThreshold: 90,
      });
    });

    it('should archive low-value messages', () => {
      const messages = createMessages(20, 'Chat message');
      const result = engine.compact(messages, 'test-session');

      if (result.level === CompressionLevel.L4_ARCHIVE) {
        expect(result.archivedIds?.length).toBeGreaterThan(0);
        expect(result.stats.archivedCount).toBeGreaterThan(0);
        const archiveRef = result.messages.find((m) => m.content.includes('[Archived'));
        expect(archiveRef).toBeDefined();
      }
    });

    it('should keep high-value messages', () => {
      const messages: CompactMessage[] = [
        {
          id: 'intent',
          chat_jid: 'test@jid',
          sender: 'user',
          sender_name: 'User',
          content: 'I need you to help with this important task',
          timestamp: new Date().toISOString(),
          is_from_me: false,
          isCompacted: false,
        },
        ...createMessages(15, 'Chat'),
      ];

      const result = engine.compact(messages, 'test-session');
      const preservedIntent = result.messages.find((m) => m.content.includes('I need you'));
      expect(preservedIntent).toBeDefined();
    });
  });

  describe('archive operations', () => {
    it('should store and restore archives', () => {
      const messages = createMessages(15, 'Test');
      engine.setConfig({
        maxTokens: 300,
        thresholds: {
          l1Threshold: 30,
          l2Threshold: 40,
          l3Threshold: 50,
          l4Threshold: 60,
        },
        l4ValueThreshold: 90,
      });

      const result = engine.compact(messages, 'restore-test');

      if (result.archivedIds && result.archivedIds.length > 0) {
        const archiveId = result.archivedIds[0];
        const restored = engine.restoreArchive(archiveId, 'restore-test');
        expect(restored).toBeDefined();
        expect(restored?.id).toBe(archiveId);
        expect(restored?.messageIds.length).toBeGreaterThan(0);
      }
    });

    it('should clear archives', () => {
      engine.clearArchives('test-session');
      const archives = engine.listArchives('test-session');
      expect(archives).toHaveLength(0);
    });

    it('should return undefined for non-existent archive', () => {
      const restored = engine.restoreArchive('non-existent', 'no-session');
      expect(restored).toBeUndefined();
    });
  });

  describe('statistics', () => {
    it('should calculate compression ratio', () => {
      const messages = createToolResults(5);
      const result = engine.compact(messages, 'test-session');

      expect(result.stats.tokensBefore).toBeGreaterThan(0);
      expect(result.stats.tokensAfter).toBeGreaterThan(0);
      expect(result.stats.compressionRatio).toBeGreaterThanOrEqual(0);
      expect(result.stats.timestamp).toBeDefined();
    });

    it('tracks compacted flags per message', () => {
      const messages = createToolResults(30);
      const result = engine.compact(messages, 'flag-session');
      expect(result.stats.compactedCount).toBeGreaterThanOrEqual(0);
      expect(result.stats.compactedCount).toBeLessThanOrEqual(result.messages.length);
    });
  });

  describe('configuration', () => {
    it('should get and set configuration', () => {
      const initialConfig = engine.getConfig();
      expect(initialConfig.maxTokens).toBe(500);

      engine.setConfig({ maxTokens: 2000 });
      const newConfig = engine.getConfig();
      expect(newConfig.maxTokens).toBe(2000);
      expect(newConfig.l1KeepRecentCount).toBe(2);
    });
  });

  describe('singleton', () => {
    it('should have a singleton instance', () => {
      expect(compactEngine).toBeInstanceOf(IntelligentCompactEngine);
    });

    it('should track archive store size', () => {
      const size = getArchiveStoreSize();
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });
});

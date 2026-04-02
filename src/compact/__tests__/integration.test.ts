/**
 * Integration tests for the context compaction system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatMessages } from '../../router.js';
import { compactEngine } from '../engine.js';
import { NewMessage } from '../../types.js';

describe('Compaction Integration', () => {
  beforeEach(() => {
    compactEngine.setConfig({
      maxTokens: 1000,
      thresholds: {
        l1Threshold: 50,
        l2Threshold: 70,
        l3Threshold: 85,
        l4Threshold: 95,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should preserve original formatting when no compression is needed', () => {
    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'test@jid',
        sender: 'user',
        sender_name: 'Test User',
        content: 'Hello',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
      {
        id: '2',
        chat_jid: 'test@jid',
        sender: 'assistant',
        sender_name: 'Assistant',
        content: 'Hi there!',
        timestamp: new Date().toISOString(),
        is_from_me: true,
      },
    ];

    const result = formatMessages(messages, 'UTC', 'test-session');
    expect(result).toContain('<messages>');
    expect(result).toContain('sender="Test User"');
    expect(result).toContain('Hello');
    expect(result).toContain('sender="Assistant"');
    expect(result).toContain('Hi there!');
    expect(result).not.toContain('compact_level');
  });

  it('should include compression metadata when compressed', () => {
    vi.spyOn(compactEngine as any, 'calculateTokens').mockReturnValue(800);

    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'test@jid',
        sender: 'system',
        sender_name: 'System',
        content: `Tool result: \`\`\`json\n{"data": "${'x'.repeat(100)}"}\n\`\`\``,
        timestamp: new Date().toISOString(),
        is_from_me: true,
      },
      {
        id: '2',
        chat_jid: 'test@jid',
        sender: 'system',
        sender_name: 'System',
        content: `Tool result: \`\`\`json\n{"data": "${'x'.repeat(100)}"}\n\`\`\``,
        timestamp: new Date().toISOString(),
        is_from_me: true,
      },
      {
        id: '3',
        chat_jid: 'test@jid',
        sender: 'system',
        sender_name: 'System',
        content: `Tool result: \`\`\`json\n{"data": "${'x'.repeat(100)}"}\n\`\`\``,
        timestamp: new Date().toISOString(),
        is_from_me: true,
      },
    ];

    const result = formatMessages(messages, 'UTC', 'test-session');
    expect(result).toContain('compact_level="');
    expect(result).toContain('original_messages="3"');
    expect(result).toContain('compacted="');
    expect(result).toMatch(/\[Snipped Tool Result|\[Summarized\]/);
  });

  it('keeps message order and only marks truly compacted messages', () => {
    vi.spyOn(compactEngine as any, 'calculateTokens').mockReturnValue(960);

    const messages: NewMessage[] = [
      {
        id: 'intent',
        chat_jid: 'test@jid',
        sender: 'user',
        sender_name: 'User',
        content: 'I need help with this task',
        timestamp: '2026-04-02T00:00:00.000Z',
        is_from_me: false,
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `msg_${i}`,
        chat_jid: 'test@jid',
        sender: 'assistant',
        sender_name: 'Assistant',
        content: `Chat message ${i} with enough content to force compression`,
        timestamp: `2026-04-02T00:00:0${i + 1}.000Z`,
        is_from_me: true,
      })),
    ];

    const result = formatMessages(messages, 'UTC', 'test-session-123');
    expect(result.indexOf('I need help with this task')).toBeLessThan(result.indexOf('[Archived'));
    expect(result).toContain('compacted="true"');
  });

  it('should fall back to original messages if compaction throws', () => {
    vi.spyOn(compactEngine, 'compact').mockImplementation(() => {
      throw new Error('Test compaction error');
    });

    const messages: NewMessage[] = [
      {
        id: '1',
        chat_jid: 'test@jid',
        sender: 'user',
        sender_name: 'Test User',
        content: 'Hello',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    ];

    const result = formatMessages(messages, 'UTC', 'test-session');
    expect(result).toContain('sender="Test User"');
    expect(result).toContain('Hello');
  });
});

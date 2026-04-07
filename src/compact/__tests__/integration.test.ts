/**
 * Integration tests for the context compaction system.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { formatMessages } from '../../router.js';
import { NewMessage } from '../../types.js';

describe('Compaction Integration', () => {
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

  it('does not inject host compaction metadata during standard formatting', () => {
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
    expect(result).not.toContain('compact_level="');
    expect(result).not.toContain('original_messages="');
    expect(result).not.toContain('compacted="true"');
  });
});

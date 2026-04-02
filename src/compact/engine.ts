/**
 * Intelligent compaction engine for context compression.
 *
 * Implements four-level compression strategy:
 * - L1: Snip - Replace old tool results with references
 * - L2: Summarize - Create structured summaries
 * - L3: Collapse - Merge non-essential messages
 * - L4: Archive - Archive low-value messages
 */

import { logger } from '../logger.js';
import {
  ContentType,
  CompressionLevel,
  CompressionThresholds,
  DEFAULT_THRESHOLDS,
  EngineConfig,
  DEFAULT_ENGINE_CONFIG,
  CompactResult,
  CompactStats,
  CompactMessage,
  ClassifiedMessage,
  ArchiveEntry,
  ToolResultSummary,
} from './types.js';
import { contentClassifier, estimateTokens } from './classifier.js';

/**
 * In-memory archive storage.
 * Maps sessionId -> archiveId -> ArchiveEntry
 */
const archiveStore = new Map<string, Map<string, ArchiveEntry>>();

/**
 * Archive counter for generating unique IDs.
 */
let archiveCounter = 0;

/**
 * Generates a unique archive ID.
 */
function generateArchiveId(): string {
  archiveCounter += 1;
  return `arch_${Date.now()}_${archiveCounter}`;
}

/**
 * Extracts a structured summary from tool result content.
 */
function summarizeToolResult(content: string): string {
  // Try to extract JSON keys
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const json = JSON.parse(jsonMatch[1]);
      const keys = Object.keys(json);
      return `[JSON: ${keys.length} keys - ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '...' : ''}]`;
    } catch {
      // Not valid JSON, continue to next strategy
    }
  }

  // Try to extract HTML title and links
  if (content.includes('<html') || content.includes('<!DOCTYPE')) {
    const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
    const linkCount = (content.match(/<a\s/g) || []).length;
    return `[Web Page: "${title}" - ${linkCount} links]`;
  }

  // Default: extract first line and indicate truncation
  const lines = content.split('\n').filter((l) => l.trim());
  const firstLine = lines[0]?.trim() || '';
  const truncated = content.length > 200;
  return `[Tool Result: ${firstLine.slice(0, 100)}${firstLine.length > 100 ? '...' : ''}${truncated ? ` (+${content.length - 100} chars)` : ''}]`;
}

/**
 * Extracts key findings from exploration content.
 */
function summarizeExploration(content: string): string {
  // Look for key findings
  const findings: string[] = [];

  // Pattern: "found", "discovered", "结果是"
  const foundMatches = content.match(
    /(?:found|discovered|发现|找到|结果是)[：:]\s*(.+?)(?:\n|$)/gi,
  );
  if (foundMatches) {
    findings.push(...foundMatches.slice(0, 3));
  }

  // Pattern: numbered items
  const numberedMatches = content.match(/\d+\.\s+.+?(?:\n|$)/g);
  if (numberedMatches) {
    findings.push(...numberedMatches.slice(0, 3));
  }

  if (findings.length > 0) {
    return `[Exploration Summary: ${findings.join('; ').slice(0, 200)}]`;
  }

  // Fallback: first sentence
  const firstSentence = content.split(/[.!?。！？]\s+/)[0];
  return `[Exploration: ${firstSentence.slice(0, 100)}${firstSentence.length > 100 ? '...' : ''}]`;
}

/**
 * Creates a timeline summary from multiple messages.
 */
function createTimelineSummary(messages: ClassifiedMessage[]): string {
  const byType = new Map<ContentType, number>();
  const keyEvents: string[] = [];

  for (const msg of messages) {
    // Count by type
    const count = byType.get(msg.metadata.type) || 0;
    byType.set(msg.metadata.type, count + 1);

    // Collect key events (high value messages)
    if (msg.metadata.valueScore >= 70) {
      const content = msg.content.slice(0, 50);
      keyEvents.push(
        `${msg.metadata.type}: ${content}${msg.content.length > 50 ? '...' : ''}`,
      );
    }
  }

  const typeSummary = Array.from(byType.entries())
    .map(([type, count]) => `${type}(${count})`)
    .join(', ');

  return `[Timeline: ${messages.length} messages - ${typeSummary}${keyEvents.length > 0 ? ' | Key: ' + keyEvents.slice(0, 3).join('; ') : ''}]`;
}

/**
 * The intelligent compaction engine.
 */
export class IntelligentCompactEngine {
  private config: EngineConfig;

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
  }

  /**
   * Calculate total estimated tokens for messages.
   */
  private calculateTokens(messages: CompactMessage[]): number {
    return messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  }

  /**
   * Determine the compression level needed based on token usage.
   */
  private determineLevel(tokenCount: number): CompressionLevel {
    const usagePercent = (tokenCount / this.config.maxTokens) * 100;

    if (usagePercent >= this.config.thresholds.l4Threshold) {
      return CompressionLevel.L4_ARCHIVE;
    }
    if (usagePercent >= this.config.thresholds.l3Threshold) {
      return CompressionLevel.L3_COLLAPSE;
    }
    if (usagePercent >= this.config.thresholds.l2Threshold) {
      return CompressionLevel.L2_SUMMARIZE;
    }
    if (usagePercent >= this.config.thresholds.l1Threshold) {
      return CompressionLevel.L1_SNIP;
    }
    return CompressionLevel.NONE;
  }

  /**
   * L1: Snip - Replace old tool results with references.
   * Keeps the most recent N tool results intact.
   */
  private l1Snip(messages: ClassifiedMessage[]): {
    messages: ClassifiedMessage[];
    modified: boolean;
  } {
    const toolResultIndices: number[] = [];

    // Find all tool results
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].metadata.type === ContentType.TOOL_RESULT) {
        toolResultIndices.push(i);
      }
    }

    // Keep the most recent N, snip the rest
    const keepCount = this.config.l1KeepRecentCount;
    if (toolResultIndices.length <= keepCount) {
      return { messages, modified: false };
    }
    const toSnip = toolResultIndices.slice(
      0,
      toolResultIndices.length - keepCount,
    );

    if (toSnip.length === 0) {
      return { messages, modified: false };
    }

    const result = [...messages];
    for (const idx of toSnip) {
      const msg = result[idx];
      const summary = summarizeToolResult(msg.content);
      result[idx] = {
        ...msg,
        content: `[Snipped Tool Result #${idx + 1}] ${summary}`,
        metadata: {
          ...msg.metadata,
          extras: { originalContent: msg.content, snipped: true },
        },
      };
    }

    return { messages: result, modified: true };
  }

  /**
   * L2: Summarize - Create structured summaries.
   */
  private l2Summarize(messages: ClassifiedMessage[]): {
    messages: ClassifiedMessage[];
    modified: boolean;
  } {
    let modified = false;
    const result = [...messages];

    for (let i = 0; i < result.length; i++) {
      const msg = result[i];

      if (
        msg.metadata.type === ContentType.TOOL_RESULT &&
        msg.metadata.isCompressible
      ) {
        // Summarize tool results
        const summary = summarizeToolResult(msg.content);
        result[i] = {
          ...msg,
          content: `[Summarized] ${summary}`,
          metadata: {
            ...msg.metadata,
            extras: { originalContent: msg.content, summarized: true },
          },
        };
        modified = true;
      } else if (
        msg.metadata.type === ContentType.EXPLORATION &&
        msg.metadata.isCompressible
      ) {
        // Summarize exploration
        const summary = summarizeExploration(msg.content);
        result[i] = {
          ...msg,
          content: summary,
          metadata: {
            ...msg.metadata,
            extras: { originalContent: msg.content, summarized: true },
          },
        };
        modified = true;
      }
    }

    return { messages: result, modified };
  }

  /**
   * L3: Collapse - Merge non-essential messages.
   */
  private l3Collapse(messages: ClassifiedMessage[]): {
    messages: ClassifiedMessage[];
    modified: boolean;
    collapsedCount: number;
  } {
    const highValueTypes = [
      ContentType.USER_INTENT,
      ContentType.DECISION,
      ContentType.ARTIFACT,
      ContentType.ERROR,
    ];

    const collapsibleIndices: number[] = [];

    // Separate high-value from collapsible, keeping recent messages
    const recentKeepCount = this.config.l3KeepRecentCount;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isRecent = i >= messages.length - recentKeepCount;
      const isHighValue =
        highValueTypes.includes(msg.metadata.type) ||
        msg.metadata.valueScore >= 80;

      if (!isHighValue && !isRecent) {
        collapsibleIndices.push(i);
      }
    }

    if (collapsibleIndices.length === 0) {
      return { messages, modified: false, collapsedCount: 0 };
    }

    const collapsibleMessages = collapsibleIndices.map(
      (index) => messages[index],
    );

    // Create a timeline summary of collapsed messages
    const timelineSummary = createTimelineSummary(collapsibleMessages);

    // Create a collapsed message
    const collapsedMsg: ClassifiedMessage = {
      id: `collapsed_${Date.now()}`,
      chat_jid: collapsibleMessages[0].chat_jid,
      sender: 'system',
      sender_name: 'Compaction System',
      content: timelineSummary,
      timestamp: collapsibleMessages[0].timestamp,
      is_from_me: true,
      metadata: {
        type: ContentType.CHAT,
        valueScore: 50,
        isCompressible: true,
        confidence: 1,
        extras: {
          collapsedMessages: collapsibleMessages.map((m) => m.id),
          originalTypes: collapsibleMessages.map((m) => m.metadata.type),
          compacted: true,
        },
      },
      tokenCount: estimateTokens(timelineSummary),
    };

    const firstCollapsedIndex = collapsibleIndices[0];
    const collapsibleIndexSet = new Set(collapsibleIndices);
    const result: ClassifiedMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (i === firstCollapsedIndex) {
        result.push(collapsedMsg);
      }
      if (!collapsibleIndexSet.has(i)) {
        result.push(messages[i]);
      }
    }

    return {
      messages: result,
      modified: true,
      collapsedCount: collapsibleMessages.length,
    };
  }

  /**
   * L4: Archive - Archive low-value messages, keep only highest value.
   */
  private l4Archive(
    messages: ClassifiedMessage[],
    sessionId?: string,
  ): {
    messages: ClassifiedMessage[];
    modified: boolean;
    archiveEntry?: ArchiveEntry;
  } {
    const highValueThreshold = this.config.l4ValueThreshold;

    const archiveIndices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].metadata.valueScore < highValueThreshold) {
        archiveIndices.push(i);
      }
    }

    if (archiveIndices.length === 0) {
      return { messages, modified: false };
    }

    const archiveMessages = archiveIndices.map((index) => messages[index]);

    // Create archive entry
    const archiveId = generateArchiveId();
    const valueScores: Record<string, number> = {};
    let archivedContent = '';

    for (const msg of archiveMessages) {
      valueScores[msg.id] = msg.metadata.valueScore;
      archivedContent += `[${msg.metadata.type}] ${msg.sender_name}: ${msg.content}\n\n`;
    }

    const archiveEntry: ArchiveEntry = {
      id: archiveId,
      sessionId: sessionId || 'default',
      messageIds: archiveMessages.map((m) => m.id),
      content: archivedContent,
      archivedAt: new Date().toISOString(),
      valueScores,
    };

    // Store in archive
    if (this.config.persistArchives && sessionId) {
      if (!archiveStore.has(sessionId)) {
        archiveStore.set(sessionId, new Map());
      }
      archiveStore.get(sessionId)!.set(archiveId, archiveEntry);
    }

    // Create archive reference message
    const archiveRef: ClassifiedMessage = {
      id: `archive_ref_${Date.now()}`,
      chat_jid: messages[archiveIndices[0]].chat_jid,
      sender: 'system',
      sender_name: 'Compaction System',
      content: `[Archived ${archiveMessages.length} messages - ID: ${archiveId}]`,
      timestamp: messages[archiveIndices[0]].timestamp,
      is_from_me: true,
      metadata: {
        type: ContentType.CHAT,
        valueScore: 60,
        isCompressible: true,
        confidence: 1,
        extras: {
          archiveId,
          archivedCount: archiveMessages.length,
          compacted: true,
        },
      },
      tokenCount: estimateTokens(
        `[Archived ${archiveMessages.length} messages]`,
      ),
    };

    const firstArchivedIndex = archiveIndices[0];
    const archiveIndexSet = new Set(archiveIndices);
    const result: ClassifiedMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (i === firstArchivedIndex) {
        result.push(archiveRef);
      }
      if (!archiveIndexSet.has(i)) {
        result.push(messages[i]);
      }
    }

    return {
      messages: result,
      modified: true,
      archiveEntry,
    };
  }

  /**
   * Main compaction entry point.
   */
  compact(messages: CompactMessage[], sessionId?: string): CompactResult {
    const tokensBefore = this.calculateTokens(messages);
    const requestedLevel = this.determineLevel(tokensBefore);
    const level = requestedLevel;

    logger.debug(
      {
        messageCount: messages.length,
        tokensBefore,
        maxTokens: this.config.maxTokens,
        level,
      },
      'Compacting messages',
    );

    // Handle empty or single message
    if (messages.length <= 1) {
      return {
        messages,
        level: CompressionLevel.NONE,
        stats: {
          totalMessages: messages.length,
          compactedCount: 0,
          archivedCount: 0,
          tokensBefore,
          tokensAfter: tokensBefore,
          compressionRatio: 1,
          level: CompressionLevel.NONE,
          timestamp: new Date().toISOString(),
        },
        diagnostics: {
          sessionId,
          persistArchives: this.config.persistArchives,
          archiveStoreBacked: this.config.persistArchives && !!sessionId,
          requestedLevel,
          appliedLevel: CompressionLevel.NONE,
          archiveIds: [],
        },
      };
    }

    // Classify all messages
    let classified = contentClassifier.classifyBatch(messages);
    let modified = false;
    let archivedIds: string[] = [];

    // Apply compression based on level
    if (level === CompressionLevel.L1_SNIP) {
      const result = this.l1Snip(classified);
      classified = result.messages;
      modified = result.modified;
    } else if (level === CompressionLevel.L2_SUMMARIZE) {
      // Apply L1 first
      const l1Result = this.l1Snip(classified);
      classified = l1Result.messages;

      // Then L2
      const l2Result = this.l2Summarize(classified);
      classified = l2Result.messages;
      modified = l1Result.modified || l2Result.modified;
    } else if (level === CompressionLevel.L3_COLLAPSE) {
      // Apply L1 and L2 first
      const l1Result = this.l1Snip(classified);
      classified = l1Result.messages;
      const l2Result = this.l2Summarize(classified);
      classified = l2Result.messages;

      // Then L3
      const l3Result = this.l3Collapse(classified);
      classified = l3Result.messages;
      modified = l1Result.modified || l2Result.modified || l3Result.modified;
    } else if (level === CompressionLevel.L4_ARCHIVE) {
      // Apply L1, L2, L3 first
      const l1Result = this.l1Snip(classified);
      classified = l1Result.messages;
      const l2Result = this.l2Summarize(classified);
      classified = l2Result.messages;
      const l3Result = this.l3Collapse(classified);
      classified = l3Result.messages;

      // Then L4
      const l4Result = this.l4Archive(classified, sessionId);
      classified = l4Result.messages;
      modified =
        l1Result.modified ||
        l2Result.modified ||
        l3Result.modified ||
        l4Result.modified;

      if (l4Result.archiveEntry) {
        archivedIds = [l4Result.archiveEntry.id];
      }
    }

    // Calculate final stats
    const resultMessages: CompactMessage[] = classified.map((msg) => {
      const isActuallyModified = !!(
        msg.metadata.extras?.snipped ||
        msg.metadata.extras?.summarized ||
        msg.metadata.extras?.collapsedMessages ||
        msg.metadata.extras?.archiveId ||
        msg.metadata.extras?.compacted
      );
      return {
        ...msg,
        isCompacted: isActuallyModified,
        compactLevel: isActuallyModified ? level : undefined,
      };
    });

    const tokensAfter = this.calculateTokens(resultMessages);

    const stats: CompactStats = {
      totalMessages: messages.length,
      compactedCount: resultMessages.filter((m) => m.isCompacted).length,
      archivedCount: archivedIds.length,
      tokensBefore,
      tokensAfter,
      compressionRatio: tokensBefore > 0 ? tokensAfter / tokensBefore : 1,
      level,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      {
        level,
        tokensBefore,
        tokensAfter,
        compressionRatio: stats.compressionRatio,
      },
      'Compaction completed',
    );

    return {
      messages: resultMessages,
      level,
      stats,
      archivedIds,
      diagnostics: {
        sessionId,
        persistArchives: this.config.persistArchives,
        archiveStoreBacked: this.config.persistArchives && !!sessionId,
        requestedLevel,
        appliedLevel: level,
        archiveIds: archivedIds,
      },
    };
  }

  /**
   * Restore archived messages by archive ID.
   */
  restoreArchive(
    archiveId: string,
    sessionId: string,
  ): ArchiveEntry | undefined {
    const sessionArchives = archiveStore.get(sessionId);
    if (!sessionArchives) {
      return undefined;
    }
    return sessionArchives.get(archiveId);
  }

  getDiagnostics(sessionId?: string): {
    sessionId?: string;
    persistArchives: boolean;
    archiveStoreBacked: boolean;
    archiveCount: number;
    archiveIds: string[];
  } {
    const sessionArchives = sessionId ? archiveStore.get(sessionId) : undefined;
    return {
      sessionId,
      persistArchives: this.config.persistArchives,
      archiveStoreBacked: this.config.persistArchives && !!sessionId,
      archiveCount: sessionArchives?.size || 0,
      archiveIds: sessionArchives ? Array.from(sessionArchives.keys()) : [],
    };
  }

  /**
   * List all archives for a session.
   */
  listArchives(sessionId: string): ArchiveEntry[] {
    const sessionArchives = archiveStore.get(sessionId);
    if (!sessionArchives) {
      return [];
    }
    return Array.from(sessionArchives.values());
  }

  /**
   * Clear archives for a session.
   */
  clearArchives(sessionId: string): void {
    archiveStore.delete(sessionId);
  }

  /**
   * Get current configuration.
   */
  getConfig(): EngineConfig {
    return { ...this.config };
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Singleton engine instance for reuse.
 */
export const compactEngine = new IntelligentCompactEngine();

/**
 * Get archive store size for debugging.
 */
export function getArchiveStoreSize(): number {
  let total = 0;
  for (const sessionArchives of archiveStore.values()) {
    total += sessionArchives.size;
  }
  return total;
}

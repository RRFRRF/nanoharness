/**
 * Types for the intelligent context compaction system.
 *
 * This module provides type definitions for classifying, compacting,
 * and managing message context to handle long-running conversations
 * without exceeding token limits.
 */

import { NewMessage } from '../types.js';

/**
 * Types of content that can be identified in messages.
 */
export enum ContentType {
  /** User's original intent or request */
  USER_INTENT = 'user_intent',
  /** Agent's decision or choice made during processing */
  DECISION = 'decision',
  /** Final conclusion or result of a task */
  CONCLUSION = 'conclusion',
  /** Generated artifact (code, document, etc.) */
  ARTIFACT = 'artifact',
  /** Result from a tool execution */
  TOOL_RESULT = 'tool_result',
  /** Exploration or investigation process */
  EXPLORATION = 'exploration',
  /** Reasoning or thinking process */
  REASONING = 'reasoning',
  /** Error message or failure */
  ERROR = 'error',
  /** General chat message */
  CHAT = 'chat',
}

/**
 * Metadata associated with classified content.
 */
export interface ContentMetadata {
  /** The identified content type */
  type: ContentType;
  /** Value score from 0-100 indicating importance */
  valueScore: number;
  /** Whether this content can be compressed */
  isCompressible: boolean;
  /** Confidence of the classification (0-1) */
  confidence: number;
  /** Additional type-specific metadata */
  extras?: Record<string, unknown>;
}

/**
 * A classified message with its metadata.
 */
export interface ClassifiedMessage extends NewMessage {
  /** Classification metadata */
  metadata: ContentMetadata;
  /** Estimated token count */
  tokenCount: number;
}

/**
 * Compression levels from least to most aggressive.
 */
export enum CompressionLevel {
  /** No compression applied */
  NONE = 'NONE',
  /** L1: Snip - Replace old tool results with references */
  L1_SNIP = 'L1_SNIP',
  /** L2: Summarize - Create structured summaries */
  L2_SUMMARIZE = 'L2_SUMMARIZE',
  /** L3: Collapse - Merge non-essential messages */
  L3_COLLAPSE = 'L3_COLLAPSE',
  /** L4: Archive - Archive low-value messages */
  L4_ARCHIVE = 'L4_ARCHIVE',
}

/**
 * Thresholds for triggering each compression level.
 * Values represent percentage of token limit used.
 */
export interface CompressionThresholds {
  /** Trigger L1 Snip at this percentage (default: 75) */
  l1Threshold: number;
  /** Trigger L2 Summarize at this percentage (default: 85) */
  l2Threshold: number;
  /** Trigger L3 Collapse at this percentage (default: 93) */
  l3Threshold: number;
  /** Trigger L4 Archive at this percentage (default: 98) */
  l4Threshold: number;
}

/**
 * Default compression thresholds.
 */
export const DEFAULT_THRESHOLDS: CompressionThresholds = {
  l1Threshold: 75,
  l2Threshold: 85,
  l3Threshold: 93,
  l4Threshold: 98,
};

/**
 * Result of a compaction operation.
 */
export interface CompactResult {
  /** The compressed messages */
  messages: CompactMessage[];
  /** The level of compression applied */
  level: CompressionLevel;
  /** Statistics about the compaction */
  stats: CompactStats;
  /** Archive IDs created during compaction (if any) */
  archivedIds?: string[];
}

/**
 * A message after compaction processing.
 */
export interface CompactMessage extends NewMessage {
  /** Whether this message was modified during compaction */
  isCompacted: boolean;
  /** The original content before compaction (for restoration) */
  originalContent?: string;
  /** The compression level applied to this message */
  compactLevel?: CompressionLevel;
  /** Reference to archived content */
  archiveRef?: string;
}

/**
 * Statistics about a compaction operation.
 */
export interface CompactStats {
  /** Total number of messages processed */
  totalMessages: number;
  /** Number of messages compacted */
  compactedCount: number;
  /** Number of messages archived */
  archivedCount: number;
  /** Estimated tokens before compaction */
  tokensBefore: number;
  /** Estimated tokens after compaction */
  tokensAfter: number;
  /** Compression ratio (after / before) */
  compressionRatio: number;
  /** Level of compression applied */
  level: CompressionLevel;
  /** Timestamp of compaction */
  timestamp: string;
}

/**
 * Configuration for the compaction engine.
 */
export interface EngineConfig {
  /** Maximum context window size in tokens */
  maxTokens: number;
  /** Compression thresholds */
  thresholds: CompressionThresholds;
  /** Whether to persist archives to database */
  persistArchives: boolean;
  /** Number of recent tool results to keep in L1 */
  l1KeepRecentCount: number;
  /** Number of recent messages to keep full in L3 */
  l3KeepRecentCount: number;
  /** Value score threshold for L4 archive retention */
  l4ValueThreshold: number;
}

/**
 * Default engine configuration.
 */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxTokens: 8000,
  thresholds: DEFAULT_THRESHOLDS,
  persistArchives: true,
  l1KeepRecentCount: 3,
  l3KeepRecentCount: 2,
  l4ValueThreshold: 90,
};

/**
 * Stored archive entry for recovered messages.
 */
export interface ArchiveEntry {
  /** Unique archive ID */
  id: string;
  /** Session ID this archive belongs to */
  sessionId: string;
  /** Original message IDs contained in this archive */
  messageIds: string[];
  /** The archived content */
  content: string;
  /** Timestamp when archived */
  archivedAt: string;
  /** Original value scores for recovery prioritization */
  valueScores: Record<string, number>;
}

/**
 * Options for compacting messages.
 */
export interface CompactOptions {
  /** Session ID for archive tracking */
  sessionId?: string;
  /** Whether to force a specific compression level */
  forceLevel?: CompressionLevel;
  /** Optional message to restore from archive */
  restoreArchiveId?: string;
}

/**
 * Summary of tool result for L1 snip.
 */
export interface ToolResultSummary {
  /** Tool name or type */
  tool: string;
  /** Brief status */
  status: 'success' | 'error' | 'partial';
  /** Size of original output */
  originalSize: number;
  /** Timestamp */
  timestamp: string;
}

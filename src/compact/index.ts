/**
 * Intelligent Context Compaction System for NanoHarness.
 *
 * This module provides context compression capabilities to handle long-running
 * conversations without exceeding token limits. It uses a four-level compression
 * strategy that preserves important information while reducing token usage.
 *
 * @example
 * ```typescript
 * import { compactEngine, classifyContent, ContentType } from './compact/index.js';
 *
 * // Compact messages
 * const result = compactEngine.compact(messages, sessionId);
 *
 * // Classify a message
 * const classification = classifyContent(message);
 * ```
 */

// Types
export {
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
  ContentMetadata,
  ArchiveEntry,
  ToolResultSummary,
  CompactOptions,
  CompactDiagnostics,
} from './types.js';

// Classifier
export {
  ContentClassifier,
  contentClassifier,
  estimateTokens,
} from './classifier.js';

// Engine
export {
  IntelligentCompactEngine,
  compactEngine,
  getArchiveStoreSize,
} from './engine.js';

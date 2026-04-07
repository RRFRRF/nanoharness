import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'MODEL_PROVIDER',
  'MODEL_API_FORMAT',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OPENAI_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'NANOCLAW_USE_NATIVE_STREAMING',
  'NANOCLAW_STREAM_CONTENT_FROM_NATIVE',
  'NANOCLAW_DEBUG_NATIVE_STREAM',
  'NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const MODEL_PROVIDER =
  process.env.MODEL_PROVIDER || envConfig.MODEL_PROVIDER || 'anthropic';
export const MODEL_API_FORMAT =
  process.env.MODEL_API_FORMAT || envConfig.MODEL_API_FORMAT || 'anthropic';
export const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || envConfig.ANTHROPIC_MODEL;
export const ANTHROPIC_DEFAULT_OPUS_MODEL =
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  envConfig.ANTHROPIC_DEFAULT_OPUS_MODEL;
export const ANTHROPIC_DEFAULT_SONNET_MODEL =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
  envConfig.ANTHROPIC_DEFAULT_SONNET_MODEL;
export const ANTHROPIC_DEFAULT_HAIKU_MODEL =
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||
  envConfig.ANTHROPIC_DEFAULT_HAIKU_MODEL;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || envConfig.OPENAI_MODEL;
export const CLAUDE_CODE_SUBAGENT_MODEL =
  process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
  envConfig.CLAUDE_CODE_SUBAGENT_MODEL;
export const NANOCLAW_USE_NATIVE_STREAMING =
  process.env.NANOCLAW_USE_NATIVE_STREAMING ||
  envConfig.NANOCLAW_USE_NATIVE_STREAMING;
export const NANOCLAW_STREAM_CONTENT_FROM_NATIVE =
  process.env.NANOCLAW_STREAM_CONTENT_FROM_NATIVE ||
  envConfig.NANOCLAW_STREAM_CONTENT_FROM_NATIVE;
export const NANOCLAW_DEBUG_NATIVE_STREAM =
  process.env.NANOCLAW_DEBUG_NATIVE_STREAM ||
  envConfig.NANOCLAW_DEBUG_NATIVE_STREAM;
export const NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK =
  process.env.NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK ||
  envConfig.NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoharness-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const TASK_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.NANOCLAW_TASK_MAX_RETRIES || '3', 10) || 3,
);
export const TASK_RETRY_BASE_MS = Math.max(
  1000,
  parseInt(process.env.NANOCLAW_TASK_RETRY_BASE_MS || '10000', 10) || 10000,
);
export const AGENT_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.NANOCLAW_AGENT_MAX_RETRIES || '2', 10) || 2,
);
export const AGENT_RETRY_BASE_MS = Math.max(
  1000,
  parseInt(process.env.NANOCLAW_AGENT_RETRY_BASE_MS || '5000', 10) || 5000,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Streaming configuration
export const STREAMING_CONFIG = {
  ENABLED: process.env.NANOCLAW_STREAMING !== 'false',
  SHOW_THINKING: process.env.NANOCLAW_SHOW_THINKING !== 'false',
  THINKING_COLLAPSED: process.env.NANOCLAW_THINKING_COLLAPSED === 'true',
  SHOW_PLAN: process.env.NANOCLAW_SHOW_PLAN !== 'false',
  SHOW_TOOLS: process.env.NANOCLAW_SHOW_TOOLS !== 'false',
  BUFFER_SIZE: parseInt(process.env.NANOCLAW_STREAM_BUFFER_SIZE || '1000', 10),
  MAX_EVENTS: parseInt(process.env.NANOCLAW_STREAM_MAX_EVENTS || '10000', 10),
};

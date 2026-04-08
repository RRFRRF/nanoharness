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
  'NANOCLAW_ENABLE_SUMMARIZATION',
  'NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE',
  'NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS',
  'NANOCLAW_USE_NATIVE_MEMORY',
  'NANOCLAW_INTERRUPT_ON_JSON',
  'NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS',
  'NANOCLAW_SUBAGENT_RESEARCHER_SKILLS',
  'NANOCLAW_SUBAGENT_CODER_SKILLS',
  'NANOCLAW_SUBAGENT_REVIEWER_SKILLS',
  'NANOCLAW_SUBAGENT_RESEARCHER_MODEL',
  'NANOCLAW_SUBAGENT_RESEARCH_MODEL',
  'NANOCLAW_RESEARCHER_MODEL',
  'NANOCLAW_SUBAGENT_CODER_MODEL',
  'NANOCLAW_CODER_MODEL',
  'NANOCLAW_SUBAGENT_REVIEWER_MODEL',
  'NANOCLAW_REVIEWER_MODEL',
  'NANOCLAW_USE_NATIVE_STREAMING',
  'NANOCLAW_STREAM_CONTENT_FROM_NATIVE',
  'NANOCLAW_DEBUG_NATIVE_STREAM',
  'NANOCLAW_DISABLE_NATIVE_STREAM_FALLBACK',
  'NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT',
  'NANOCLAW_STORE_DIR',
  'NANOCLAW_GROUPS_DIR',
  'NANOCLAW_DATA_DIR',
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
export const NANOCLAW_ENABLE_SUMMARIZATION =
  process.env.NANOCLAW_ENABLE_SUMMARIZATION ||
  envConfig.NANOCLAW_ENABLE_SUMMARIZATION;
export const NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE =
  process.env.NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE ||
  envConfig.NANOCLAW_FORCE_LANGCHAIN_SUMMARIZATION_MIDDLEWARE;
export const NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS =
  process.env.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS ||
  envConfig.NANOCLAW_ENABLE_PREDEFINED_SUBAGENTS;
export const NANOCLAW_USE_NATIVE_MEMORY =
  process.env.NANOCLAW_USE_NATIVE_MEMORY ||
  envConfig.NANOCLAW_USE_NATIVE_MEMORY;
export const NANOCLAW_INTERRUPT_ON_JSON =
  process.env.NANOCLAW_INTERRUPT_ON_JSON ||
  envConfig.NANOCLAW_INTERRUPT_ON_JSON;
export const NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS =
  process.env.NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS ||
  envConfig.NANOCLAW_SUBAGENT_SHARE_MAIN_SKILLS;
export const NANOCLAW_SUBAGENT_RESEARCHER_SKILLS =
  process.env.NANOCLAW_SUBAGENT_RESEARCHER_SKILLS ||
  envConfig.NANOCLAW_SUBAGENT_RESEARCHER_SKILLS;
export const NANOCLAW_SUBAGENT_CODER_SKILLS =
  process.env.NANOCLAW_SUBAGENT_CODER_SKILLS ||
  envConfig.NANOCLAW_SUBAGENT_CODER_SKILLS;
export const NANOCLAW_SUBAGENT_REVIEWER_SKILLS =
  process.env.NANOCLAW_SUBAGENT_REVIEWER_SKILLS ||
  envConfig.NANOCLAW_SUBAGENT_REVIEWER_SKILLS;
export const NANOCLAW_SUBAGENT_RESEARCHER_MODEL =
  process.env.NANOCLAW_SUBAGENT_RESEARCHER_MODEL ||
  process.env.NANOCLAW_SUBAGENT_RESEARCH_MODEL ||
  envConfig.NANOCLAW_SUBAGENT_RESEARCHER_MODEL ||
  envConfig.NANOCLAW_SUBAGENT_RESEARCH_MODEL;
export const NANOCLAW_RESEARCHER_MODEL =
  process.env.NANOCLAW_RESEARCHER_MODEL || envConfig.NANOCLAW_RESEARCHER_MODEL;
export const NANOCLAW_SUBAGENT_CODER_MODEL =
  process.env.NANOCLAW_SUBAGENT_CODER_MODEL ||
  envConfig.NANOCLAW_SUBAGENT_CODER_MODEL;
export const NANOCLAW_CODER_MODEL =
  process.env.NANOCLAW_CODER_MODEL || envConfig.NANOCLAW_CODER_MODEL;
export const NANOCLAW_SUBAGENT_REVIEWER_MODEL =
  process.env.NANOCLAW_SUBAGENT_REVIEWER_MODEL ||
  envConfig.NANOCLAW_SUBAGENT_REVIEWER_MODEL;
export const NANOCLAW_REVIEWER_MODEL =
  process.env.NANOCLAW_REVIEWER_MODEL || envConfig.NANOCLAW_REVIEWER_MODEL;
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
export const NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT =
  process.env.NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT ||
  envConfig.NANOCLAW_PERSIST_RUNTIME_CONTEXT_CONTENT;
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
export const STORE_DIR = path.resolve(
  process.env.NANOCLAW_STORE_DIR ||
    envConfig.NANOCLAW_STORE_DIR ||
    path.join(PROJECT_ROOT, 'store'),
);
export const GROUPS_DIR = path.resolve(
  process.env.NANOCLAW_GROUPS_DIR ||
    envConfig.NANOCLAW_GROUPS_DIR ||
    path.join(PROJECT_ROOT, 'groups'),
);
export const DATA_DIR = path.resolve(
  process.env.NANOCLAW_DATA_DIR ||
    envConfig.NANOCLAW_DATA_DIR ||
    path.join(PROJECT_ROOT, 'data'),
);

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
export let CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export function setCredentialProxyPort(port: number): void {
  CREDENTIAL_PROXY_PORT = port;
  process.env.CREDENTIAL_PROXY_PORT = String(port);
}
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

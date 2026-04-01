import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return result;
}

const envPath = path.join(process.cwd(), '.env');
const envFile = parseEnvFile(envPath);
const provider =
  process.env.MODEL_PROVIDER ||
  envFile.MODEL_PROVIDER ||
  (process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY ? 'openai' : 'anthropic');

const hasCredentials =
  provider === 'openai'
    ? !!(process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY)
    : !!(
        process.env.ANTHROPIC_API_KEY ||
        envFile.ANTHROPIC_API_KEY ||
        process.env.CLAUDE_CODE_OAUTH_TOKEN ||
        envFile.CLAUDE_CODE_OAUTH_TOKEN
      );

if (!hasCredentials) {
  console.error(`Missing ${provider} credentials in current .env / process env.`);
  process.exit(1);
}

process.env.CREDENTIAL_PROXY_PORT =
  process.env.CREDENTIAL_PROXY_PORT || '3012';
process.env.CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
process.env.CONTAINER_TIMEOUT =
  process.env.CONTAINER_TIMEOUT || '240000';

const { startCredentialProxy } = await import('../dist/credential-proxy.js');
const { PROXY_BIND_HOST } = await import('../dist/container-runtime.js');
const { runContainerAgent } = await import('../dist/container-runner.js');

const proxy = await startCredentialProxy(
  Number(process.env.CREDENTIAL_PROXY_PORT),
  PROXY_BIND_HOST,
);

const group = {
  name: 'Smoke Test',
  folder: 'terminal_smoke-test',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
  isMain: true,
};

try {
  const output = await runContainerAgent(
    group,
    {
      prompt:
        'Reply with EXACTLY SMOKE_OK and nothing else. Do not use tools unless absolutely required.',
      groupFolder: group.folder,
      chatJid: 'local:smoke-test',
      isMain: true,
      assistantName: 'SmokeTest',
    },
    () => {},
    async (chunk) => {
      if (chunk.event) {
        console.log(`STREAM_EVENT=${JSON.stringify(chunk.event)}`);
      }
      if (chunk.result) {
        console.log(`STREAM_RESULT=${chunk.result}`);
      }
    },
  );

  console.log(`FINAL_OUTPUT=${JSON.stringify(output)}`);

  if (output.status !== 'success') {
    process.exitCode = 1;
  }
} finally {
  await new Promise((resolve) => proxy.close(resolve));
}

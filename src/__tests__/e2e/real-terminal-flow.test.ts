import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { createServer } from 'net';

const PROJECT_ROOT = path.resolve(process.cwd());
const TEST_TIMEOUT = 480000;
const RUN_REAL_E2E = process.env.NANOCLAW_RUN_REAL_E2E === 'true';
let tempRoot = '';

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '\n');
}

function npmCommand(script: string): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', script] }
    : { command: 'sh', args: ['-lc', script] };
}

function runCommandOrThrow(script: string): void {
  const { command, args } = npmCommand(script);
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  });

  if (result.status !== 0) {
    throw new Error(
      [result.stdout, result.stderr].filter(Boolean).join('\n') ||
        `Command failed: ${script}`,
    );
  }
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a TCP port for real e2e'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

const maybeIt = RUN_REAL_E2E ? it : it.skip;

describe('E2E: real terminal flow', () => {
  beforeAll(() => {
    if (!RUN_REAL_E2E) return;
    runCommandOrThrow('npm run build');
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoharness-real-e2e-'));
  });

  afterAll(() => {
    if (!tempRoot) return;
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup issues from prior failed runs
    }
  });

  maybeIt(
    'starts real terminal mode and drives a live conversation through the actual model runtime',
    async () => {
      for (const key of [
        'MODEL_PROVIDER',
        'MODEL_API_FORMAT',
        'OPENAI_BASE_URL',
        'OPENAI_API_KEY',
        'OPENAI_MODEL',
      ]) {
        expect(
          process.env[key],
          `${key} is required for real e2e`,
        ).toBeTruthy();
      }

      const proxyPort = await reserveFreePort();
      const { command, args } = npmCommand('npm run terminal');
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          CREDENTIAL_PROXY_PORT: String(proxyPort),
          NANOCLAW_TERMINAL_PLAIN_MODE: 'true',
          NANOCLAW_STORE_DIR: path.join(tempRoot, 'store'),
          NANOCLAW_GROUPS_DIR: path.join(tempRoot, 'groups'),
          NANOCLAW_DATA_DIR: path.join(tempRoot, 'data'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const transcript = () =>
        stripAnsi(`${stdoutChunks.join('')}\n${stderrChunks.join('')}`);
      const sendLine = (line: string) => {
        child.stdin?.write(`${line}\n`);
      };
      const waitForText = async (text: string, timeoutMs = 30000) => {
        await waitForCondition(
          () => transcript().includes(text),
          timeoutMs,
          `text "${text}"`,
        );
      };
      const waitForAgentMessageCount = async (
        label: string,
        expectedCount: number,
        timeoutMs = 180000,
      ) => {
        await waitForCondition(
          () => {
            const output = transcript();
            const matches = output.match(new RegExp(`^${label}$`, 'gm'));
            return (matches?.length || 0) >= expectedCount;
          },
          timeoutMs,
          `${label} ${expectedCount} times`,
        );
      };
      const waitForExit = () =>
        new Promise<number | null>((resolve) => {
          child.once('exit', (code) => resolve(code));
        });

      child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
      child.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString()));

      try {
        await waitForText(
          'Terminal mode ready. Type /help for commands.',
          60000,
        );

        sendLine('/help');
        await waitForText('/new <name> [--mount <path>] [--rw]');

        sendLine('/new live');
        await waitForText('Created agent live (local-live)');

        sendLine('/current');
        await waitForText('live (local-live) status=idle');

        sendLine('hi');
        await waitForText('Starting Deep Agents query...', 120000);
        await waitForAgentMessageCount('agent:live', 1, 180000);

        sendLine('苏州天气');
        await waitForText('Starting Deep Agents query...', 180000);
        await waitForAgentMessageCount('agent:live', 2, 240000);

        sendLine('/quit');
        const exitCode = await waitForExit();
        expect(exitCode).toBe(0);

        const output = transcript();
        expect(output).toContain('Created agent live (local-live)');
        expect(output).not.toContain('Container exited with error');
      } catch (error) {
        const output = transcript();
        throw new Error(
          [
            error instanceof Error ? error.message : String(error),
            '--- transcript ---',
            output,
          ].join('\n'),
        );
      } finally {
        if (!child.killed && child.exitCode === null) {
          child.kill();
          await waitForCondition(
            () => child.exitCode !== null || child.killed,
            30000,
            'real terminal shutdown',
          ).catch(() => {});
        }
      }
    },
    TEST_TIMEOUT,
  );
});

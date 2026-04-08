import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

const TEST_TIMEOUT = 120000;
const PROJECT_ROOT = path.resolve(process.cwd());
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

function buildTerminalDist(): void {
  const { command, args } = npmCommand('npm run build');
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
      [
        'Failed to build nanoharness before terminal e2e test.',
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n'),
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
      setTimeout(poll, 50);
    };
    poll();
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

describe('E2E: terminal full flow', () => {
  beforeAll(() => {
    buildTerminalDist();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoharness-e2e-'));
  });

  afterAll(() => {
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it(
    'starts terminal mode, manages agents, and handles simple dialog end-to-end',
    async () => {
      const { command, args } = npmCommand('npm run terminal');
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NANOCLAW_TERMINAL_TEST_MODE: 'true',
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
      const waitForText = async (text: string, timeoutMs = 10000) => {
        await waitForCondition(
          () => transcript().includes(text),
          timeoutMs,
          `text "${text}"`,
        );
      };
      const waitForOccurrencesText = async (
        text: string,
        occurrences: number,
        timeoutMs = 10000,
      ) => {
        await waitForCondition(
          () => countOccurrences(transcript(), text) >= occurrences,
          timeoutMs,
          `text "${text}" ${occurrences} times`,
        );
      };
      const waitForExit = () =>
        new Promise<number | null>((resolve) => {
          child.once('exit', (code) => resolve(code));
        });

      child.stdout?.on('data', (chunk) => {
        stdoutChunks.push(chunk.toString());
      });
      child.stderr?.on('data', (chunk) => {
        stderrChunks.push(chunk.toString());
      });

      try {
        await waitForText('Terminal mode ready. Type /help for commands.');

        sendLine('/help');
        await waitForText('/new <name> [--mount <path>] [--rw]');

        sendLine('/agents');
        await waitForText('No local agents.');

        sendLine('/new tester');
        await waitForText('Created agent tester (local-tester)');

        sendLine('/current');
        await waitForText('tester (local-tester) status=idle');

        sendLine('hi');
        await waitForText('Starting Deep Agents query...');
        await waitForText('你好！我是 NanoHarness 终端测试助手。');

        sendLine('苏州天气');
        await waitForText('苏州天气测试响应：多云，25°C，东南风 2 级。');

        sendLine('/new worker');
        await waitForText('Created agent worker (local-worker)');

        sendLine('/switch tester');
        await waitForText('Switched to tester (local-tester)');

        sendLine('/send worker hi');
        await waitForOccurrencesText(
          '你好！我是 NanoHarness 终端测试助手。',
          2,
        );

        sendLine('/delete worker');
        await waitForText('Deleted agent worker');

        sendLine('/quit');
        const exitCode = await waitForExit();
        expect(exitCode).toBe(0);

        const output = transcript();
        expect(output).toContain(
          'Terminal mode ready. Type /help for commands.',
        );
        expect(output).toContain('Created agent tester (local-tester)');
        expect(output).toContain('苏州天气测试响应：多云，25°C，东南风 2 级。');
      } finally {
        if (!child.killed) {
          child.kill();
        }
        await waitForCondition(
          () => child.exitCode !== null || child.killed,
          10000,
          'terminal process shutdown',
        ).catch(() => {});
      }
    },
    TEST_TIMEOUT,
  );
});

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

async function loadConfigWithEnv(envFileValues: Record<string, string>) {
  vi.resetModules();
  vi.doMock('./env.js', () => ({
    readEnvFile: vi.fn(() => ({ ...envFileValues })),
  }));

  return import('./config.js');
}

describe('config provider selection', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('./env.js');
    process.env = { ...originalEnv };
  });

  it('defaults to anthropic when no provider is configured', async () => {
    const config = await loadConfigWithEnv({});

    expect(config.MODEL_PROVIDER).toBe('anthropic');
    expect(config.OPENAI_MODEL).toBeUndefined();
  });

  it('loads openai provider and model from env file', async () => {
    const config = await loadConfigWithEnv({
      MODEL_PROVIDER: 'openai',
      OPENAI_MODEL: 'gpt-4.1-mini',
    });

    expect(config.MODEL_PROVIDER).toBe('openai');
    expect(config.OPENAI_MODEL).toBe('gpt-4.1-mini');
  });

  it('prefers process env over env file values', async () => {
    process.env.MODEL_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-5';

    const config = await loadConfigWithEnv({
      MODEL_PROVIDER: 'anthropic',
      OPENAI_MODEL: 'gpt-4.1-mini',
    });

    expect(config.MODEL_PROVIDER).toBe('openai');
    expect(config.OPENAI_MODEL).toBe('gpt-5');
  });
});

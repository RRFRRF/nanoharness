import { beforeEach, describe, expect, it } from 'vitest';

import { mapStreamEventToRenderItems } from './stream-renderer.js';
import { resetStreamConfig, setStreamConfig } from './stream-commands.js';

describe('mapStreamEventToRenderItems', () => {
  beforeEach(() => {
    resetStreamConfig();
  });

  it('maps native content chunks to mergeable append agent messages', () => {
    const items = mapStreamEventToRenderItems('local:test', 'agent:test', {
      type: 'content',
      timestamp: 't1',
      data: {
        text: 'hello',
        replace: false,
      },
    } as any);

    expect(items).toEqual([
      {
        kind: 'message',
        label: 'agent:test',
        text: 'hello',
        tone: 'agent',
        mergeKey: 'local:test',
        mergeMode: 'append',
      },
    ]);
  });

  it('maps replacing content events to replace mode', () => {
    const items = mapStreamEventToRenderItems('local:test', 'agent:test', {
      type: 'content',
      timestamp: 't1',
      data: {
        text: 'full response',
        replace: true,
      },
    } as any);

    expect(items[0]).toMatchObject({
      tone: 'agent',
      mergeKey: 'local:test',
      mergeMode: 'replace',
    });
  });

  it('hides internal native decision events outside full mode', () => {
    const items = mapStreamEventToRenderItems('local:test', 'agent:test', {
      type: 'decision',
      timestamp: 't1',
      data: {
        description: 'Native message stream',
        choice: 'model_request',
      },
    } as any);

    expect(items).toEqual([]);
  });

  it('shows internal native decision events in full mode', () => {
    setStreamConfig({ viewMode: 'full' });

    const items = mapStreamEventToRenderItems('local:test', 'agent:test', {
      type: 'decision',
      timestamp: 't1',
      data: {
        description: 'Native message stream',
        choice: 'model_request',
      },
    } as any);

    expect(items).toEqual([
      {
        kind: 'message',
        label: 'agent:test',
        text: 'Native message stream: model_request',
        tone: 'system',
      },
    ]);
  });
});

/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  RequestOptions,
  Server,
} from 'http';
import { Agent as HttpsAgent, request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type Provider = 'anthropic' | 'openai';
export type AuthMode = 'api-key' | 'oauth' | 'bearer';

export interface ProxyConfig {
  provider: Provider;
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'MODEL_PROVIDER',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const provider = resolveProvider(secrets);
  const authMode: AuthMode =
    provider === 'openai'
      ? 'bearer'
      : secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    provider === 'openai'
      ? secrets.OPENAI_BASE_URL || 'https://api.openai.com/v1'
      : secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;
  const upstreamAgent = isHttps
    ? new HttpsAgent({ keepAlive: true })
    : new HttpAgent({ keepAlive: true });

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (provider === 'openai') {
          delete headers['authorization'];
          delete headers['x-api-key'];
          if (secrets.OPENAI_API_KEY) {
            headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
          }
        } else if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        let downstreamClosed = false;
        res.on('close', () => {
          downstreamClosed = true;
        });

        const sendUpstream = (attempt: number) => {
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
              agent: upstreamAgent,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          res.once('close', () => {
            if (!upstream.destroyed) {
              upstream.destroy();
            }
          });

          upstream.on('error', (err) => {
            const code =
              err && typeof err === 'object'
                ? 'code' in err
                  ? err.code
                  : undefined
                : undefined;
            const isRetryable =
              !downstreamClosed &&
              !res.headersSent &&
              attempt === 0 &&
              (code === 'ECONNRESET' ||
                code === 'ETIMEDOUT' ||
                code === 'EPIPE');

            if (isRetryable) {
              logger.warn(
                { err, url: req.url, attempt: attempt + 1 },
                'Credential proxy upstream error, retrying once',
              );
              sendUpstream(attempt + 1);
              return;
            }

            if (downstreamClosed) {
              logger.debug(
                { url: req.url, err },
                'Credential proxy downstream closed before upstream completed',
              );
              return;
            }

            logger.error(
              { err, url: req.url, attempt },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        sendUpstream(0);
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, provider, authMode },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

function resolveProvider(secrets: Record<string, string>): Provider {
  if (secrets.MODEL_PROVIDER === 'openai') return 'openai';
  if (secrets.MODEL_PROVIDER === 'anthropic') return 'anthropic';
  if (secrets.OPENAI_API_KEY || secrets.OPENAI_BASE_URL) return 'openai';
  return 'anthropic';
}

/** Detect which model provider the host is configured for. */
export function detectProvider(): Provider {
  const secrets = readEnvFile([
    'MODEL_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);
  return resolveProvider(secrets);
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const provider = detectProvider();
  if (provider === 'openai') return 'bearer';

  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

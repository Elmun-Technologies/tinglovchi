import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { validateProductionEnvironment } from '@suhbat/database/production-env';
import { createRecordingApiFromEnv } from './server';

/**
 * Entry point for the privileged Recording API.
 *
 * This process is the `recording-api` runtime role. It is not the web app and it is not the worker:
 * it owns the Phase 4 recording write path and nothing else. It is expected to be reachable only
 * from the Web gateway over Fly's private network — see `docs/deployment-topology.md`.
 *
 * Run with:
 *
 *   SUHBAT_RUNTIME_ROLE=recording-api node --import tsx apps/recording-api/src/index.ts
 */

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — every payload here is metadata, never audio.

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  response.writeHead(status, headers);
  response.end(body);
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const role = (env.SUHBAT_RUNTIME_ROLE ?? '').trim().toLowerCase();
  if (role !== 'recording-api') {
    throw new Error(
      `This process must run with SUHBAT_RUNTIME_ROLE=recording-api (got "${role || 'unset'}"). ` +
        'The recording API is a distinct deployment from the web app and the worker.',
    );
  }

  // Fail closed at boot. A misconfigured privileged service should refuse to start rather than
  // discover the problem during someone's meeting.
  validateProductionEnvironment(env, { role: 'recording-api', throwOnError: true });

  const api = await createRecordingApiFromEnv(env);
  const port = Number.parseInt(env.PORT ?? '8080', 10);
  const host = env.HOST ?? '0.0.0.0';

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const result = await api.handle({
          method: request.method ?? 'GET',
          // The signature covers path + query exactly as the gateway sent them, so this must be the
          // raw request target — no normalisation, no re-encoding.
          path: request.url ?? '/',
          headers: {
            get: (name: string) => {
              const value = request.headers[name.toLowerCase()];
              if (value === undefined) return null;
              return Array.isArray(value) ? value.join(', ') : value;
            },
          },
          body,
        });
        send(response, result.status, result.headers, result.body);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        send(
          response,
          413,
          { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          JSON.stringify({ error: { code: 'validation_failed', message } }),
        );
      }
    })();
  });

  server.listen(port, host, () => {
    process.stdout.write(
      `${JSON.stringify({ event: 'recording_api.listening', host, port, role: 'recording-api' })}\n`,
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(JSON.stringify({ event: 'recording_api.shutdown', signal }) + '\n');
    server.close();
    const closable = api.db as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') await closable.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only run when invoked directly, so tests can import `main` without starting a listener.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${JSON.stringify({ event: 'recording_api.fatal', message })}\n`);
    process.exit(1);
  });
}

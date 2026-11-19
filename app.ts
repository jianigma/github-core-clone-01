// app.ts — the server: one in-memory store, routing, auth, request ids.
// main.ts owns the lifecycle (bind, register, poll /done); this file is the
// forge itself: REST v3, GraphQL v4, MCP and git smart HTTP on one store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './core.ts';
import { handleRest, type ReqCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The bearer token the env sets; empty means no auth enforcement (local runs). */
const CONFIGURED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

function authorized(req: IncomingMessage): boolean {
  if (CONFIGURED_TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${CONFIGURED_TOKEN}`;
}

function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      const sendJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
        const text = `${JSON.stringify(body)}\n`;
        res.writeHead(status, {
          'content-type': JSON_TYPE,
          'content-length': Buffer.byteLength(text),
          'x-github-request-id': requestId,
          ...extraHeaders,
        });
        res.end(text);
      };
      const sendRaw = (status: number, body: Buffer, contentType: string): void => {
        res.writeHead(status, {
          'content-type': contentType,
          'content-length': body.length,
          'x-github-request-id': requestId,
        });
        res.end(body);
      };
      const sendEmpty = (status: number): void => {
        res.writeHead(status, { 'x-github-request-id': requestId });
        res.end();
      };

      try {
        const { path, query } = parseUrl(req);
        const method = req.method ?? 'GET';

        // The env's boot check: 200 {"ok":true}, no auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(200, { ok: true });
          return;
        }

        if (!authorized(req)) {
          sendJson(401, { message: 'Requires authentication' });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' || method === 'DELETE' && path === '/mcp' ? Buffer.alloc(0) : await readBody(req);
        const segments = path.split('/').filter((s) => s !== '').map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        });
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

        // MCP endpoint.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendEmpty(200);
            return;
          }
          if (method === 'POST') {
            const result = handleMcp({ store, rawBody });
            if (result.body === null) sendEmpty(result.status);
            else sendJson(result.status, result.body);
            return;
          }
          sendJson(405, { message: 'Method Not Allowed' });
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          const result = handleGraphQL({ store, rawBody });
          sendJson(result.status, result.body);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          let body: unknown;
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody.toString('utf8'));
            } catch {
              sendJson(400, { message: 'Invalid JSON body' });
              return;
            }
          }
          const ctx: ReqCtx = { store, method, segments, query, body, origin };
          const result = handleRest(ctx);
          if (result === null) {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          if (result.status === 204) {
            sendEmpty(204);
            return;
          }
          sendJson(result.status, result.body, result.headers ?? {});
          return;
        }

        // Git smart HTTP (/{owner}/{repo}.git/...).
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const result = handleGit({ store, method, segments, query, rawBody });
          if (result !== null) {
            if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
              sendRaw(result.status, Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body as string, 'utf8'), result.contentType);
            } else {
              sendJson(result.status, result.body);
            }
            return;
          }
        }

        sendJson(404, { message: 'Not Found' });
      } catch (error) {
        // Never let one request kill the server (repo-survives-errors).
        if (!res.headersSent) {
          const detail = error instanceof Error ? error.message : String(error);
          sendJson(500, { message: `Internal Server Error: ${detail}` });
        } else {
          res.end();
        }
      }
    })();
  });
}

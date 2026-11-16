// The forge's HTTP surface: one process, one store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4 and MCP) plus the env's health probe. Anything else is GitHub's JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeRequestId, readBody, sendError, sendJson, type Ctx } from './src/http.ts';
import { DEFAULT_LOGIN, Forge } from './src/store.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { handleGitHead, handleInfoRefs, handleReceivePack, handleUploadPack, matchGitPath } from './src/gitservice.ts';

export const FORGE_VERSION = '1.0.0';

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function tokenOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization ?? '';
  const match = /^\s*(\S+)\s+(.+)$/.exec(raw);
  if (match === null) return null;
  const value = match[2].trim();
  return value === '' ? null : value;
}

async function dispatch(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const requestId = makeRequestId();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://forge.local');
  } catch {
    url = new URL('/', 'http://forge.local');
  }
  const rawSegments = url.pathname.split('/').slice(1);
  const segments = rawSegments.map(decode);
  const token = tokenOf(req);
  const body = await readBody(req);
  let json: unknown;
  if (body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = undefined;
    }
  }
  const login = token === null ? null : (forge.loginForToken(token) ?? DEFAULT_LOGIN);
  const ctx: Ctx = {
    req,
    res,
    method: (req.method ?? 'GET').toUpperCase(),
    url,
    path: url.pathname,
    segments,
    query: url.searchParams,
    token,
    login,
    body,
    json,
    forge,
    requestId,
  };

  try {
    if (segments[0] === 'healthz' && ctx.method === 'GET') {
      sendJson(ctx, 200, { ok: true });
      return;
    }
    if (segments[0] === 'mcp') {
      handleMcp(ctx);
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'graphql') {
      if (ctx.method !== 'POST') {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      handleGraphQL(ctx);
      return;
    }
    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (handleRest(ctx, forge, segments.slice(2))) return;
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const git = matchGitPath(rawSegments);
    if (git !== null) {
      const repo = git.suffix.startsWith('info/refs') || ctx.method !== 'GET' ? forge.findRepo(git.owner, git.name) : forge.findRepo(git.owner, git.name);
      if (repo === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (git.suffix.startsWith('info/refs')) {
        const service = ctx.query.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendError(ctx, 400, 'dumb HTTP is not supported');
          return;
        }
        handleInfoRefs(ctx, repo, service);
        return;
      }
      if (git.suffix === 'git-upload-pack' && ctx.method === 'POST') {
        handleUploadPack(ctx, repo);
        return;
      }
      if (git.suffix === 'git-receive-pack' && ctx.method === 'POST') {
        handleReceivePack(ctx, repo);
        return;
      }
      if (git.suffix === 'HEAD') {
        handleGitHead(ctx, repo);
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    if (!res.headersSent) sendError(ctx, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    else res.end();
  }
}

/** Build the server; main.ts binds it to an ephemeral port and registers that with the env. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req, res) => {
    void dispatch(req, res, forge).catch(() => {
      if (!res.headersSent) {
        const text = `${JSON.stringify({ message: 'Internal error' })}\n`;
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      }
    });
  });
}

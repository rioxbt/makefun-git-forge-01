// The HTTP plumbing shared by every surface: one request context, one JSON writer, one error body.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Forge } from './store.ts';

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly url: URL;
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly token: string | null;
  readonly login: string | null;
  readonly body: Buffer;
  /** The parsed JSON body, or undefined when the body is empty or not JSON (never throws). */
  readonly json: unknown;
  readonly forge: Forge;
  readonly requestId: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

/** A unique, non-empty request id: GitHub answers every reply with one. */
export function makeRequestId(): string {
  requestCounter += 1;
  const salt = randomBytes(4).toString('hex').toUpperCase();
  return `FORGE:${salt}:${requestCounter.toString(16).toUpperCase()}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('the request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

export function sendRaw(ctx: Ctx, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(body);
}

export function sendEmpty(ctx: Ctx, status: number, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId, ...headers });
  ctx.res.end();
}

/** GitHub's error body: a JSON object with a message string. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function arrayOf<T>(value: T | undefined | null): T[] {
  return value === undefined || value === null ? [] : [value];
}

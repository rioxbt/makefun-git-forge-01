// git smart HTTP: the ref/capability advertisement, upload-pack (protocol v2 and v0) and
// receive-pack (v0), all served from the forge's own object store with no git binary anywhere.
//
// The suite speaks this protocol in process; a real git client drives the same routes.

import { parseCommit, parseTree, peelObject, writePack, FLUSH_PKT, DELIM_PKT, pktLine, pktLines, parsePackets, readPack, type GitObject } from './gitobj.ts';
import type { Repo } from './store.ts';
import { sendError, sendJson, type Ctx } from './http.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';
const ZERO = '0'.repeat(40);
const SIDEBAND_LIMIT = 65515;

export interface GitTarget {
  owner: string;
  name: string;
  suffix: string;
}

/** Match `/<owner>/<repo>.git/...`; the `.git` suffix is what marks the smart-HTTP route. */
export function matchGitPath(segments: readonly string[]): GitTarget | null {
  if (segments.length < 3) return null;
  const [owner, repoWithSuffix, ...rest] = segments;
  if (!repoWithSuffix.endsWith('.git')) return null;
  const name = repoWithSuffix.slice(0, -4);
  if (name === '' || owner === '') return null;
  return { owner, name, suffix: rest.join('/') };
}

function writeAdvertisement(ctx: Ctx, service: string, contentType: string, body: Buffer): void {
  ctx.res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

function capabilityLine(oid: string, ref: string | null, capabilities: string): Buffer {
  if (ref === null) return pktLine(`${oid} capabilities^{}\u0000${capabilities}\n`);
  return pktLine(`${oid} ${ref}\u0000${capabilities}\n`);
}

/** The v0 ref advertisement: the service preamble, HEAD, then every ref. */
function advertisementV0(repo: Repo, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(FLUSH_PKT);
  const headRef = repo.headTarget;
  const headOid = repo.refs.get(headRef);
  const caps = `${capabilities} symref=HEAD:${headRef} agent=${AGENT}`;
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(capabilityLine(ZERO, null, caps));
  } else {
    const first = headOid !== undefined ? ['HEAD', ...names.filter((name) => name !== 'HEAD')] : names;
    first.forEach((name, index) => {
      const oid = name === 'HEAD' ? (headOid as string) : (repo.refs.get(name) as string);
      if (index === 0) parts.push(capabilityLine(oid, name, caps));
      else parts.push(pktLine(`${oid} ${name}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pktLine(`${peelObject(repo, oid)} ${name}^{}\n`));
      }
    });
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement. */
function advertisementV2(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}


/** Whether `ancestor` is reachable from `descendant` through parent links. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The packfile carrying exactly these objects. */
function packOf(repo: Repo, oids: readonly string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

export function handleInfoRefs(ctx: Ctx, repo: Repo, service: string): void {
  const wantsV2 = service === 'git-upload-pack' && (ctx.req.headers['git-protocol'] ?? '').toString().includes('version=2');
  if (service === 'git-upload-pack') {
    if (wantsV2) writeAdvertisement(ctx, service, UPLOAD_PACK_ADVERTISEMENT, advertisementV2());
    else {
      const caps = 'side-band-64k thin-pack ofs-delta shallow no-progress multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want';
      writeAdvertisement(ctx, service, UPLOAD_PACK_ADVERTISEMENT, advertisementV0(repo, service, caps));
    }
    return;
  }
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  writeAdvertisement(ctx, 'git-receive-pack', RECEIVE_PACK_ADVERTISEMENT, advertisementV0(repo, service, caps));
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function isTag(repo: Repo, oid: string): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

function lsRefsBody(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(repo.headTarget);
  if (keep('HEAD') && headOid !== undefined) {
    const suffix = symrefs ? ` symref-target:${repo.headTarget}` : '';
    parts.push(pktLine(`${headOid} HEAD${suffix}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (symrefs && name === repo.headTarget) line += ` symref-target:${repo.headTarget}`;
    if (peel && isTag(repo, oid)) line += ` peeled:${peelObject(repo, oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch object selection

interface Selection {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/** Every object reachable from the roots, optionally stopping the history at named commits. */
function collectObjects(repo: Repo, roots: readonly string[], stopCommits: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopCommits.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(peelObject(repo, oid));
    }
  }
  return seen;
}

/** The commit generation walk: `depth` generations from the wants when a deepen was requested. */
function walkCommits(
  repo: Repo,
  roots: readonly string[],
  options: { depth: number | null; stopCommits: ReadonlySet<string> },
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const seenGeneration = new Map<string, number>();
  let frontier: string[] = [];
  for (const root of roots) {
    const peeled = peelObject(repo, root);
    if (repo.objects.get(peeled)?.type === 'commit') frontier.push(peeled);
  }
  let generation = 1;
  while (frontier.length > 0 && (options.depth === null || generation <= options.depth)) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      seenGeneration.set(oid, generation);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents.filter((parent) => repo.objects.has(parent));
      // A plain fetch stops at the client's shallow boundary; a deepen walks through it.
      const cut = options.depth !== null ? generation + 1 > options.depth : options.stopCommits.has(oid);
      if (cut) {
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of parents) next.push(parent);
    }
    frontier = next;
    generation += 1;
  }
  return { included, boundary };
}

/** The objects a fetch delivers, with the shallow boundary the client is told about. */
function selectObjects(repo: Repo, request: { wants: readonly string[]; haves: readonly string[]; shallow: readonly string[]; depth: number | null }): Selection {
  const existingShallow = new Set(request.shallow);
  const wants = [...new Set(request.wants)];
  const haves = [...new Set(request.haves)];
  const walked = walkCommits(repo, wants, { depth: request.depth, stopCommits: existingShallow });
  const full = request.depth === null ? walkCommits(repo, wants, { depth: null, stopCommits: existingShallow }) : walked;
  const included = full.included;

  const include = new Set<string>();
  for (const want of wants) {
    if (isTag(repo, want)) include.add(want);
  }
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    include.add(oid);
    if (object.type === 'commit') {
      for (const oid2 of collectObjects(repo, [parseCommit(object.data).tree], new Set())) include.add(oid2);
    }
  }

  let exclude = new Set<string>();
  if (haves.length > 0) exclude = collectObjects(repo, haves, existingShallow);

  const oids: string[] = [];
  for (const oid of include) if (!exclude.has(oid)) oids.push(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null) {
    for (const oid of walked.boundary) if (!existingShallow.has(oid)) shallow.push(oid);
    for (const oid of existingShallow) {
      if (!walked.included.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const inside = parents.every((parent) => !repo.objects.has(parent) || walked.included.has(parent));
      if (inside) unshallow.push(oid);
    }
  }
  return { oids, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack

function sideband(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_LIMIT) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_LIMIT));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

export function handleUploadPack(ctx: Ctx, repo: Repo): void {
  const isV2 = (ctx.req.headers['git-protocol'] ?? '').toString().includes('version=2');
  const { packets } = parsePackets(ctx.body);
  const lines = packets
    .filter((packet): packet is { kind: 'data'; payload: Buffer } => packet.kind === 'data')
    .map((packet) => packet.payload.toString('utf8'));

  if (isV2) {
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';
    if (command === 'ls-refs') {
      const args = (() => {
        const index = lines.indexOf('command=ls-refs\n');
        const rest = lines.slice(index < 0 ? 1 : index + 1).map((line) => line.replace(/\n$/, ''));
        return rest.filter((line) => !line.startsWith('agent=') && !line.startsWith('object-format='));
      })();
      const body = lsRefsBody(repo, args);
      ctx.res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'content-length': body.length, 'x-github-request-id': ctx.requestId });
      ctx.res.end(body);
      return;
    }
    if (command === 'fetch') {
      const args = lines.map((line) => line.replace(/\n$/, ''));
      const wants = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim());
      const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
      const shallow = args.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
      const deepen = args.find((line) => line.startsWith('deepen '));
      const depth = deepen === undefined ? null : Number.parseInt(deepen.slice(7), 10);
      const done = args.includes('done');
      const parts: Buffer[] = [];
      if (!done) {
        parts.push(pktLine('acknowledgments\n'));
        const known = haves.filter((oid) => repo.objects.has(oid));
        for (const oid of known.slice(0, 1)) parts.push(pktLine(`ACK ${oid}\n`));
        if (known.length === 0) parts.push(pktLine('NAK\n'));
        parts.push(pktLine('ready\n'));
        parts.push(FLUSH_PKT);
      } else {
        const selection = selectObjects(repo, { wants, haves, shallow, depth });
        if (depth !== null || shallow.length > 0) {
          parts.push(pktLine('shallow-info\n'));
          for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
          for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
          parts.push(DELIM_PKT);
        }
        parts.push(pktLine('packfile\n'));
        const pack = packOf(repo, selection.oids);
        parts.push(...sideband(pack));
        parts.push(FLUSH_PKT);
      }
      const body = Buffer.concat(parts);
      ctx.res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'content-length': body.length, 'x-github-request-id': ctx.requestId });
      ctx.res.end(body);
      return;
    }
    sendError(ctx, 400, 'unsupported protocol v2 command');
    return;
  }

  // v0: the want section, then the negotiation section with done.
  const flat = lines.map((line) => line.replace(/\n$/, ''));
  const wants = flat.filter((line) => line.startsWith('want ')).map((line) => line.slice(5).trim().split(' ')[0]);
  const haves = flat.filter((line) => line.startsWith('have ')).map((line) => line.slice(5).trim());
  const shallow = flat.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8).trim());
  const deepen = flat.find((line) => line.startsWith('deepen '));
  const depth = deepen === undefined ? null : Number.parseInt(deepen.slice(7), 10);
  const done = flat.includes('done');
  const parts: Buffer[] = [];
  if (wants.length === 0) {
    sendError(ctx, 400, 'no wants in the fetch request');
    return;
  }
  const selection = selectObjects(repo, { wants, haves, shallow, depth });
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (!done) {
    parts.push(pktLine('NAK\n'));
    parts.push(FLUSH_PKT);
  } else {
    parts.push(pktLine('NAK\n'));
    const pack = packOf(repo, selection.oids);
    parts.push(...sideband(pack));
    parts.push(FLUSH_PKT);
  }
  const body = Buffer.concat(parts);
  ctx.res.writeHead(200, { 'content-type': UPLOAD_PACK_RESULT, 'content-length': body.length, 'x-github-request-id': ctx.requestId });
  ctx.res.end(body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack

export function handleReceivePack(ctx: Ctx, repo: Repo): void {
  const { packets, rest } = parsePackets(ctx.body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let capabilities = new Set<string>();
  packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && index === 0) {
      capabilities = new Set(text.slice(nul + 1).split(' ').filter((name) => name !== ''));
    }
    const parts = commandText.split(' ');
    if (parts.length < 3) return;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  });

  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = rest;
  if (packBytes.length > 0) {
    try {
      if (packBytes.toString('ascii', 0, 4) !== 'PACK') throw new Error('the pack section does not start with PACK');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const report: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  if (unpackOk) {
    for (const command of commands) {
      if (command.newOid === ZERO) {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      const isBranch = command.ref.startsWith('refs/heads/');
      if (isBranch && current !== undefined && current !== command.newOid) {
        const object = repo.objects.get(command.newOid);
        if (object === undefined) {
          report.push(`ng ${command.ref} missing necessary objects\n`);
          continue;
        }
        const fastForward = current === ZERO ? true : isAncestor(repo, current, command.newOid);
        if (!fastForward) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      repo.updatedAt = new Date().toISOString();
      report.push(`ok ${command.ref}\n`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpacker error\n`);
  }
  report.push('flush');
  const reportBytes = pktLines(report);
  const sidebandRequested = capabilities.has('side-band-64k');
  const body = sidebandRequested ? Buffer.concat([...sideband(reportBytes), FLUSH_PKT]) : reportBytes;
  ctx.res.writeHead(200, { 'content-type': RECEIVE_PACK_RESULT, 'content-length': body.length, 'x-github-request-id': ctx.requestId });
  ctx.res.end(body);
}

/** A dumb-protocol HEAD answer, so a real git client can probe the repository. */
export function handleGitHead(ctx: Ctx, repo: Repo): void {
  const text = `ref: ${repo.headTarget}\n`;
  ctx.res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(text), 'x-github-request-id': ctx.requestId });
  ctx.res.end(text);
}

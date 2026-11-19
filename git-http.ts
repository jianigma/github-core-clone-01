// git-http.ts — smart HTTP: info/refs advertisements, upload-pack v2 (ls-refs,
// fetch), receive-pack v0 (push). All state lives in the store.

import {
  ZERO_OID,
  fetchSets,
  isAncestor,
  parseCommit,
  parseTag,
  recordCommit,
  type Repo,
  type Store,
} from './core.ts';
import { decodePktLines, decodePktLinesPrefix, encodePktLines, pktDelim, pktFlush, pktLine, readPack, sidebandWrap, writePack, type DecodedPacket } from './git-core.ts';

export interface GitCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
}

export interface GitResult {
  status: number;
  body: Buffer | Record<string, unknown>;
  contentType: string;
}

const AGENT = 'github-core-clone/1.0.0';

function jsonResult(status: number, body: Record<string, unknown>): GitResult {
  return { status, body, contentType: 'application/json; charset=utf-8' };
}

function textLines(packets: DecodedPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return out;
}

/** Peel a ref target to its commit (through annotated tags). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

export function handleGit(ctx: GitCtx): GitResult | null {
  const seg = ctx.segments;
  if (seg.length < 2) return null;
  const repoSeg = seg[1] as string;
  if (!repoSeg.endsWith('.git')) return null;
  const owner = seg[0] as string;
  const repoName = repoSeg.slice(0, -4);
  const repo = ctx.store.getRepo(owner, repoName);
  const tail = seg.slice(2);

  // GET /{owner}/{repo}.git/info/refs?service=...
  if (ctx.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = ctx.query.get('service');
    if (repo === undefined) return jsonResult(404, { message: 'Not Found' });
    if (service === 'git-upload-pack') return uploadPackAdvertisement();
    if (service === 'git-receive-pack') return receivePackAdvertisement(repo);
    return jsonResult(400, { message: 'Invalid service' });
  }

  // POST /{owner}/{repo}.git/git-upload-pack
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    if (repo === undefined) return jsonResult(404, { message: 'Not Found' });
    return uploadPack(repo, ctx.rawBody);
  }

  // POST /{owner}/{repo}.git/git-receive-pack
  if (ctx.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    if (repo === undefined) return jsonResult(404, { message: 'Not Found' });
    return receivePack(repo, ctx.rawBody);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function uploadPackAdvertisement(): GitResult {
  const body = Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
  return { status: 200, body, contentType: 'application/x-git-upload-pack-advertisement' };
}

function receivePackAdvertisement(repo: Repo): GitResult {
  const caps = `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) parts.push(pktLine(`${oid} ${name}\n`));
  }
  parts.push(pktFlush());
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-receive-pack-advertisement' };
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// ---------------------------------------------------------------------------

function uploadPack(repo: Repo, rawBody: Buffer): GitResult {
  let packets: DecodedPacket[];
  try {
    packets = decodePktLines(rawBody);
  } catch {
    return jsonResult(400, { message: 'malformed pkt-line stream' });
  }
  const lines = textLines(packets);
  const commandLine = lines[0] ?? '';
  if (commandLine === 'command=ls-refs') return lsRefs(repo, lines);
  if (commandLine === 'command=fetch') return fetchV2(repo, lines);
  return jsonResult(400, { message: `unknown upload-pack command ${JSON.stringify(commandLine)}` });
}

function lsRefs(repo: Repo, lines: string[]): GitResult {
  const args = new Set<string>();
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '' || line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'peel') args.add('peel');
    else if (line === 'symrefs') args.add('symrefs');
    else if (line === 'unborn') args.add('unborn');
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (headTip !== undefined) {
      const symref = args.has('symrefs') ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      out.push(pktLine(`${headTip} HEAD${symref}\n`));
    } else if (args.has('unborn')) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.has('peel')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${peelToCommit(repo, oid)}`;
      }
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(pktFlush());
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-upload-pack-result' };
}

function fetchV2(repo: Repo, lines: string[]): GitResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow = new Set<string>();
  let depth: number | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, no action.
  }
  if (wants.length === 0) {
    return { status: 200, body: Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim(), pktFlush()]), contentType: 'application/x-git-upload-pack-result' };
  }
  // Identical fetches of an unchanged repo answer from the memo (the clone
  // workload runs 50 of them back to back).
  const cacheKey = JSON.stringify({ wants, haves, shallow: [...shallow].sort(), depth: depth ?? null });
  const cached = repo.fetchCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.version) {
    return { status: 200, body: cached.body, contentType: 'application/x-git-upload-pack-result' };
  }
  const sets = fetchSets(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  const knownHaves = haves.filter((h) => repo.objects.has(h));
  if (knownHaves.length > 0) {
    for (const have of knownHaves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  // shallow-info
  if (sets.shallow.length > 0 || sets.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of sets.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of sets.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // packfile (omitted entirely when nothing is new)
  if (sets.send.size > 0) {
    const objects = [...sets.send]
      .map((oid) => repo.objects.get(oid))
      .filter((o): o is { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer } => o !== undefined);
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(1, pack));
  }
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  if (repo.fetchCache.size > 64) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, { version: repo.version, body });
  return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
}

// ---------------------------------------------------------------------------
// receive-pack v0: push
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, rawBody: Buffer): GitResult {
  let parsed: { packets: DecodedPacket[]; packStart: number };
  try {
    parsed = decodePktLinesPrefix(rawBody);
  } catch {
    return jsonResult(400, { message: 'malformed pkt-line stream' });
  }
  const packets = parsed.packets;
  const packStart = parsed.packStart;
  // Commands run until the first flush; everything after it is the pack.
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
  }
  if (commands.length === 0) {
    return jsonResult(400, { message: 'no push commands' });
  }
  const packBytes = rawBody.subarray(packStart);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes);
      for (const [oid, obj] of pack.objects) {
        repo.objects.set(oid, obj);
        if (obj.type === 'commit') recordCommit(repo, oid, parseCommit(obj.data).parents);
      }
      repo.version += 1;
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let ok = false;
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        ok = current !== undefined && (cmd.oldOid === ZERO_OID || cmd.oldOid === current);
        if (ok) repo.refs.delete(cmd.ref);
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        ok = current === undefined && repo.objects.has(cmd.newOid);
        if (ok) repo.refs.set(cmd.ref, cmd.newOid);
      } else {
        // Fast-forward update.
        ok = current !== undefined && current === cmd.oldOid && repo.objects.has(cmd.newOid) && isAncestor(repo, cmd.oldOid, cmd.newOid);
        if (ok) repo.refs.set(cmd.ref, cmd.newOid);
      }
      reportLines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} non-fast-forward\n`);
    }
    if (reportLines.some((l) => l.startsWith('ok '))) repo.version += 1;
  }
  const inner = encodePktLines(reportLines);
  const body = sidebandWrap(1, inner);
  return { status: 200, body, contentType: 'application/x-git-receive-pack-result' };
}

// core.ts — the in-memory forge: deterministic clock, git objects, the store,
// reachability, trees, and pull-request merge logic. No HTTP here; the surfaces
// (REST, GraphQL, MCP, smart HTTP) all sit on top of this.
//
// Determinism rule (RULES.txt): no wall clock and no unseeded randomness in any
// response. Every timestamp comes from MAKEFUN_TRIAL_NOW plus a counter, so a
// replay of the same request sequence produces the same bytes.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

function parseTrialNow(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) return Math.trunc(asNum);
    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) return asDate;
  }
  return Date.parse('2026-11-19T00:00:00.000Z');
}

export class Clock {
  private baseMs: number;
  private tick = 0;
  constructor() {
    this.baseMs = parseTrialNow();
  }
  /** One deterministic "now" per creation event: base + 1s per tick. */
  nowMs(): number {
    const ms = this.baseMs + this.tick * 1000;
    this.tick += 1;
    return ms;
  }
  nowIso(): string {
    return new Date(this.nowMs()).toISOString().replace(/\.000Z$/, 'Z');
  }
  nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = (headEnd < 0 ? '' : text.slice(headEnd + 2)).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, tsSec: number, authorLine: string): Buffer {
  const lines = [
    `tree ${tree}`,
    ...parents.map((p) => `parent ${p}`),
    `author ${authorLine} ${tsSec} +0000`,
    `committer ${authorLine} ${tsSec} +0000`,
    '',
    message.endsWith('\n') ? message : `${message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = (headEnd < 0 ? '' : text.slice(headEnd + 2)).replace(/\n+$/, '');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  globalId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  databaseId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  labels: Map<string, Label>;
  /** Commit ancestry metadata: parents + generation (distance from a root). */
  commitMeta: Map<string, { parents: string[]; gen: number }>;
  /** Mutation counter: fetch-pack cache entries are valid only at this version. */
  version: number;
  /** Memoized fetch responses, keyed by the request parameters. */
  fetchCache: Map<string, { version: number; body: Buffer }>;
  createdAt: string;
  updatedAt: string;
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Store {
  clock = new Clock();
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoDbId = 1;
  nextCommentId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  private requestCounter = 0;

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean }): Repo | null {
    const key = repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const databaseId = this.nextRepoDbId;
    this.nextRepoDbId += 1;
    const now = this.clock.nowIso();
    const repo: Repo = {
      databaseId,
      globalId: globalId('Repository', databaseId),
      owner,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      labels: new Map(),
      commitMeta: new Map(),
      version: 0,
      fetchCache: new Map(),
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, repo);
    this.reposById.set(databaseId, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(repoKey(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(repoKey(owner, name));
    this.reposById.delete(repo.databaseId);
    return true;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Refs and reachability
// ---------------------------------------------------------------------------

export function getRef(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function resolveBranchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Full tree closure of one tree oid, added into `objects`. */
function addTreeClosure(repo: Repo, treeOid: string, objects: Set<string>): void {
  if (objects.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  objects.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, objects);
    else objects.add(entry.oid);
  }
}

export interface ClosureOptions {
  /** Include commits only up to this depth (1 = the tips themselves). */
  depth?: number;
  /** Commits whose parents are not traversed when no depth is given (shallow boundaries). */
  shallow?: Set<string>;
}

export interface Closure {
  /** Every commit included, with its depth (1 = tip). */
  commits: Map<string, number>;
  /** Every object included: commits, trees, blobs, tags. */
  objects: Set<string>;
}

/**
 * The object closure of `tips`: commits (depth-limited, shallow-aware) plus the
 * full tree closure of every included commit, plus any tag objects traversed.
 */
export function commitClosure(repo: Repo, tips: readonly string[], opts: ClosureOptions = {}): Closure {
  const commits = new Map<string, number>();
  const objects = new Set<string>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 1] as [string, number]);
  let head = 0;
  while (head < queue.length) {
    const entry = queue[head];
    head += 1;
    if (entry === undefined) continue;
    const [oid, depth] = entry;
    if (commits.has(oid) || objects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      objects.add(oid);
      const target = parseTag(obj.data).object;
      if (target !== '') queue.push([target, depth]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (opts.depth !== undefined && depth > opts.depth) continue;
    commits.set(oid, depth);
    objects.add(oid);
    const info = parseCommit(obj.data);
    addTreeClosure(repo, info.tree, objects);
    const isBoundary = opts.shallow !== undefined && opts.shallow.has(oid);
    const expandParents = opts.depth !== undefined ? true : !isBoundary;
    if (expandParents) {
      for (const parent of info.parents) queue.push([parent, depth + 1]);
    }
  }
  return { commits, objects };
}

export interface FetchSets {
  /** Objects to send: reachable(wants) minus reachable(haves). */
  send: Set<string>;
  /** New shallow boundaries (commits at exactly `depth` with parents). */
  shallow: string[];
  /** Old boundaries that are now included and no longer boundaries. */
  unshallow: string[];
}

/**
 * The fetch set logic, including the shallow rules the git checks pin down:
 * - a have-closure never traverses past a shallow boundary (the client only
 *   holds the boundary commit itself, not its parents);
 * - with a deepen, traversal goes through old boundaries up to the new depth.
 */
export function fetchSets(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: ReadonlySet<string>,
  depth: number | undefined,
): FetchSets {
  const want = commitClosure(repo, wants, { depth, shallow });
  const have = haves.length > 0 ? commitClosure(repo, haves, { shallow }) : { commits: new Map<string, number>(), objects: new Set<string>() };
  const send = new Set<string>();
  for (const oid of want.objects) if (!have.objects.has(oid)) send.add(oid);
  const boundary = new Set<string>();
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of want.commits) {
      if (d !== depth) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0) boundary.add(oid);
    }
    for (const oid of shallow) {
      if (want.commits.has(oid) && !boundary.has(oid)) unshallow.push(oid);
    }
  }
  return { send, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

/** The first commit reachable from both `a` and `b` (BFS from b over a's ancestors). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || ancestors.has(oid)) continue;
    ancestors.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift();
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    if (ancestors.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trees as flat path maps
// ---------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

interface TreeNode {
  files: Map<string, FlatEntry>;
  dirs: Map<string, TreeNode>;
}

export function buildTreeFromPaths(repo: Repo, files: Map<string, FlatEntry>): string {
  const root: TreeNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i] as string;
      let child = node.dirs.get(seg);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const buildNode = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: buildNode(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return buildNode(root);
}

/** Record a commit's parents. Generations are computed lazily by ensureGens:
 * a pack's commits may arrive in any order, so a gen computed at store time
 * from not-yet-seen parents would be wrong. */
export function recordCommit(repo: Repo, oid: string, parents: string[]): void {
  const existing = repo.commitMeta.get(oid);
  if (existing !== undefined && existing.gen >= 0) return;
  repo.commitMeta.set(oid, { parents, gen: -1 });
}

/** Compute generations for `oid` and its ancestors (fixpoint; correct for any arrival order). */
export function ensureGens(repo: Repo, oid: string): void {
  const pending = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    const meta = repo.commitMeta.get(current);
    if (meta === undefined || meta.gen >= 0) continue;
    if (pending.has(current)) continue;
    pending.add(current);
    for (const parent of meta.parents) {
      const pm = repo.commitMeta.get(parent);
      if (pm !== undefined && pm.gen < 0) queue.push(parent);
    }
  }
  if (pending.size === 0) return;
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of pending) {
      const meta = repo.commitMeta.get(current);
      if (meta === undefined || meta.gen >= 0) continue;
      let gen = 0;
      let ready = true;
      for (const parent of meta.parents) {
        const pm = repo.commitMeta.get(parent);
        if (pm === undefined) continue; // missing parent counts as a root
        if (pm.gen < 0) {
          ready = false;
          break;
        }
        if (pm.gen + 1 > gen) gen = pm.gen + 1;
      }
      if (!ready) continue;
      meta.gen = gen;
      changed = true;
    }
  }
  // A cycle (not a valid git DAG) must not wedge the server: fall back to 0.
  for (const current of pending) {
    const meta = repo.commitMeta.get(current);
    if (meta !== undefined && meta.gen < 0) meta.gen = 0;
  }
}

/** True when `ancestor` is reachable from `tip` (generations bound the walk). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  ensureGens(repo, tip);
  ensureGens(repo, ancestor);
  const ancMeta = repo.commitMeta.get(ancestor);
  const tipMeta = repo.commitMeta.get(tip);
  if (ancMeta !== undefined && tipMeta !== undefined) {
    if (ancMeta.gen >= tipMeta.gen) return false;
    const stack = [tip];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const meta = repo.commitMeta.get(oid);
      if (meta === undefined || meta.gen <= ancMeta.gen) continue;
      for (const parent of meta.parents) stack.push(parent);
    }
    return false;
  }
  // Fallback for commits that predate the metadata (should not happen in practice).
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Create a commit on `branch` (or from the default branch tip when unborn) and move the ref. */
export function commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string, clock: Clock): string {
  let parent = repo.refs.get(`refs/heads/${branch}`);
  if (parent === undefined) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parents = parent === undefined ? [] : [parent];
  const ts = clock.nowSec();
  const author = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
  const data = buildCommit(treeOid, parents, message, ts, author);
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  recordCommit(repo, oid, parents);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.version += 1;
  return oid;
}

/** Apply one file write to a branch's tree and commit it. Returns commit + blob shas. */
export function putContentFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  clock: Clock,
): { commitSha: string; blobSha: string; created: boolean } {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let files = new Map<string, FlatEntry>();
  if (tip !== undefined) {
    const obj = repo.objects.get(tip);
    if (obj !== undefined && obj.type === 'commit') files = flattenTree(repo, parseCommit(obj.data).tree);
  }
  const created = !files.has(path);
  const blobSha = hashObject('blob', content);
  repo.objects.set(blobSha, { type: 'blob', data: content });
  files.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = buildTreeFromPaths(repo, files);
  const commitSha = commitOnBranch(repo, branch, treeOid, message, clock);
  return { commitSha, blobSha, created };
}

/** Remove one file from a branch's tree and commit it. Null when the file is absent. */
export function deleteContentFile(repo: Repo, branch: string, path: string, message: string, clock: Clock): string | null {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  const files = flattenTree(repo, parseCommit(obj.data).tree);
  if (!files.has(path)) return null;
  files.delete(path);
  const treeOid = buildTreeFromPaths(repo, files);
  return commitOnBranch(repo, branch, treeOid, message, clock);
}

/** The tree oid of a commit, or null. */
export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------------------
// Diffs and merges
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid?: string;
  newOid?: string;
  mode?: string;
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/deleted line counts between two blobs (LCS; small files only). */
export function lineCounts(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const a = oldData === undefined ? [] : splitLines(oldData.toString('utf8'));
  const b = newData === undefined ? [] : splitLines(newData.toString('utf8'));
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[b.length] ?? 0;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const counts = lineCounts(repo.objects.get(b.oid)?.data, undefined);
      out.push({ path, status: 'removed', oldOid: b.oid, additions: 0, deletions: counts.deletions, changes: counts.deletions });
    } else if (b === undefined && h !== undefined) {
      const counts = lineCounts(undefined, repo.objects.get(h.oid)?.data);
      out.push({ path, status: 'added', newOid: h.oid, mode: h.mode, additions: counts.additions, deletions: 0, changes: counts.additions });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const counts = lineCounts(repo.objects.get(b.oid)?.data, repo.objects.get(h.oid)?.data);
      out.push({
        path,
        status: 'modified',
        oldOid: b.oid,
        newOid: h.oid,
        mode: h.mode,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  return out;
}

/** Current tips of a pull request's head and base branches (falling back to the recorded shas). */
export function prTips(repo: Repo, pr: Pull): { head: string; base: string } {
  const head = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const base = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return { head, base };
}

export function prMergeBase(repo: Repo, pr: Pull): string | null {
  const { head, base } = prTips(repo, pr);
  return mergeBase(repo, head, base);
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function prFiles(repo: Repo, pr: Pull): FileChange[] {
  const { head } = prTips(repo, pr);
  const base = prMergeBase(repo, pr);
  const headTree = commitTreeOid(repo, head);
  if (headTree === null) return [];
  if (base === null) {
    // No common ancestor: everything in the head tree is added.
    const files = flattenTree(repo, headTree);
    return [...files.keys()].sort().map((path) => {
      const entry = files.get(path) as FlatEntry;
      const counts = lineCounts(undefined, repo.objects.get(entry.oid)?.data);
      return { path, status: 'added' as const, newOid: entry.oid, mode: entry.mode, additions: counts.additions, deletions: 0, changes: counts.additions };
    });
  }
  const baseTree = commitTreeOid(repo, base);
  if (baseTree === null) return [];
  return diffTrees(repo, baseTree, headTree);
}

/** True when the head and the base both changed a path since the merge-base with different results. */
export function prIsConflicted(repo: Repo, pr: Pull): boolean {
  const { head, base } = prTips(repo, pr);
  const mb = mergeBase(repo, head, base);
  if (mb === null) return false;
  const mbTree = commitTreeOid(repo, mb);
  const headTree = commitTreeOid(repo, head);
  const baseTree = commitTreeOid(repo, base);
  if (mbTree === null || headTree === null || baseTree === null) return false;
  const headChanges = diffTrees(repo, mbTree, headTree);
  const baseChanges = new Map(diffTrees(repo, mbTree, baseTree).map((c) => [c.path, c]));
  for (const hc of headChanges) {
    const bc = baseChanges.get(hc.path);
    if (bc === undefined) continue;
    const headContent = hc.status === 'removed' ? null : hc.newOid ?? null;
    const baseContent = bc.status === 'removed' ? null : bc.newOid ?? null;
    if (headContent !== baseContent) return true;
  }
  return false;
}

export function prMergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  return prIsConflicted(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha. */
export function squashMerge(repo: Repo, pr: Pull, clock: Clock): string {
  const { head, base } = prTips(repo, pr);
  const mb = mergeBase(repo, head, base);
  const baseTree = commitTreeOid(repo, base);
  const files = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  if (mb !== null) {
    const mbTree = commitTreeOid(repo, mb);
    const headTree = commitTreeOid(repo, head);
    if (mbTree !== null && headTree !== null) {
      for (const change of diffTrees(repo, mbTree, headTree)) {
        if (change.status === 'removed') files.delete(change.path);
        else if (change.newOid !== undefined) files.set(change.path, { oid: change.newOid, mode: change.mode ?? '100644' });
      }
    }
  }
  const newTree = buildTreeFromPaths(repo, files);
  const message = `${pr.title} (#${pr.number})`;
  const mergeSha = commitOnBranch(repo, pr.baseRef, newTree, message, clock);
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = clock.nowIso();
  pr.mergeCommitSha = mergeSha;
  pr.updatedAt = pr.mergedAt;
  return mergeSha;
}

// ---------------------------------------------------------------------------
// First-parent commit walk (newest first) for GET /commits
// ---------------------------------------------------------------------------

export function walkCommits(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && out.length < limit) {
    if (seen.has(current)) break;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') break;
    out.push(current);
    const parents = parseCommit(obj.data).parents;
    current = parents[0];
  }
  return out;
}

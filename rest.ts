// rest.ts — the REST v3 surface (/api/v3). Pure handler functions over the store;
// app.ts owns transport (body parsing, auth, request ids).

import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  commitTreeOid,
  decodeGlobalId,
  deleteContentFile,
  flattenTree,
  globalId,
  parseCommit,
  parseTree,
  prFiles,
  prIsConflicted,
  prTips,
  putContentFile,
  squashMerge,
  walkCommits,
  type FlatEntry,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './core.ts';

export interface ReqCtx {
  store: Store;
  method: string;
  /** Decoded path segments (no leading empty segment). */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  /** Absolute origin for Link headers, e.g. http://127.0.0.1:4123. */
  origin: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(ctx: ReqCtx): Record<string, unknown> | null {
  return isRecord(ctx.body) ? ctx.body : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(label: { name: string; color: string } | undefined, name: string): Record<string, unknown> {
  return { name, color: label?.color ?? 'ededed', description: '' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name), name)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: { id: number; globalId: string; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  const { head, base } = prTips(repo, pr);
  return {
    id: pr.id,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open' ? !prIsConflicted(repo, pr) : null,
    head: { ref: pr.headRef, sha: head, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    base: { ref: pr.baseRef, sha: base, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(ctx: ReqCtx, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(ctx.query);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (totalPages > 1) {
    const basePath = `/${ctx.segments.join('/')}`;
    const links: string[] = [];
    const withPage = (p: number): string => {
      const q = new URLSearchParams(ctx.query);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${ctx.origin}${basePath}?${q.toString()}>`;
    };
    if (page < totalPages) {
      links.push(`${withPage(page + 1)}; rel="next"`);
      links.push(`${withPage(totalPages)}; rel="last"`);
    }
    if (page > 1) {
      links.push(`${withPage(1)}; rel="first"`);
      links.push(`${withPage(page - 1)}; rel="prev"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { page: [...slice], headers };
}

// ---------------------------------------------------------------------------
// Helpers shared with the other surfaces
// ---------------------------------------------------------------------------

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
  }
  const number = repo.nextIssueNumber;
  repo.nextIssueNumber += 1;
  const id = store.nextIssueId;
  store.nextIssueId += 1;
  const now = store.clock.nowIso();
  const issue: Issue = {
    id,
    globalId: globalId('Issue', repo.databaseId, number),
    number,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullRecord(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  if (headSha === undefined) return { error: `head branch "${head}" does not exist` };
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (baseSha === undefined) return { error: `base branch "${base}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return { error: 'A pull request already exists for this head and base' };
    }
  }
  const number = repo.nextPullNumber;
  repo.nextPullNumber += 1;
  const id = store.nextPullId;
  store.nextPullId += 1;
  const now = store.clock.nowIso();
  const pr: Pull = {
    id,
    globalId: globalId('PullRequest', repo.databaseId, number),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(number, pr);
  return pr;
}

/** Resolve a repo from /repos/{owner}/{name} segments; 404 when absent or foreign. */
function repoOf(ctx: ReqCtx, at: number): Repo | RestResult {
  const owner = ctx.segments[at] ?? '';
  const name = ctx.segments[at + 1] ?? '';
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function parseAuthor(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  const ts = Number(match[3]);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(ts * 1000).toISOString().replace(/\.000Z$/, 'Z') };
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(ctx: ReqCtx): RestResult | null {
  const seg = ctx.segments;
  if (seg[0] !== 'api' || seg[1] !== 'v3') return null;
  const m = ctx.method;

  // GET /api/v3/ — the API root.
  if ((seg.length === 2 || (seg.length === 3 && seg[2] === '')) && m === 'GET') {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[2] === 'meta' && m === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (seg.length === 3 && seg[2] === 'user' && m === 'GET') {
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', email: VIEWER_EMAIL, name: VIEWER_LOGIN });
  }

  // POST /api/v3/user/repos — create a repository.
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos' && m === 'POST') {
    const body = bodyRecord(ctx);
    const name = str(body?.name).trim();
    if (name === '') return err(422, 'name is required');
    const created = ctx.store.createRepo(VIEWER_LOGIN, name, {
      description: str(body?.description),
      isPrivate: body?.private === true,
    });
    if (created === null) return err(422, `name already exists on this account`);
    return json(201, repoJson(created));
  }

  // GET /api/v3/user/repos — list, paginated via Link.
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos' && m === 'GET') {
    const repos = ctx.store.listRepos(VIEWER_LOGIN);
    const { page, headers } = paginate(ctx, repos.map((r) => repoJson(r)));
    return json(200, page, headers);
  }

  // /api/v3/repos/{owner}/{name}/...
  if (seg.length >= 4 && seg[2] === 'repos') {
    return handleRepo(ctx, 3);
  }

  return err(404, 'Not Found');
}

function handleRepo(ctx: ReqCtx, at: number): RestResult {
  const m = ctx.method;
  const seg = ctx.segments;
  const repoOrErr = repoOf(ctx, at);
  if ('status' in repoOrErr) return repoOrErr;
  const repo = repoOrErr;
  const rest = seg.slice(at + 2);

  // GET /repos/{o}/{r}
  if (rest.length === 0) {
    if (m === 'GET') return json(200, repoJson(repo));
    if (m === 'PATCH') {
      const body = bodyRecord(ctx);
      if (body !== null) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      repo.updatedAt = ctx.store.clock.nowIso();
      return json(200, repoJson(repo));
    }
    if (m === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  const head = rest[0] as string;

  // GET /branches, GET /branches/{branch}
  if (head === 'branches') {
    if (rest.length === 1 && m === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      return json(200, branches);
    }
    if (rest.length === 2 && m === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return err(404, 'Branch not found');
      return json(200, { name: rest[1], commit: { sha } });
    }
    return err(404, 'Not Found');
  }

  // GET /commits
  if (head === 'commits' && rest.length === 1 && m === 'GET') {
    const shaParam = ctx.query.get('sha');
    let tip: string | undefined;
    if (shaParam !== null && shaParam !== '') {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined) return json(200, []);
    const commits = walkCommits(repo, tip, 100).map((oid) => {
      const obj = repo.objects.get(oid);
      const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
      const author = info !== null ? parseAuthor(info.author) : { name: '', email: '', date: '' };
      const committer = info !== null ? parseAuthor(info.committer) : { name: '', email: '', date: '' };
      return { sha: oid, commit: { message: info?.message ?? '', author, committer } };
    });
    return json(200, commits);
  }

  // /git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && m === 'POST') {
      const body = bodyRecord(ctx);
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
      if (!/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'sha is not a valid object id');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.version += 1;
      return json(201, { ref, object: { sha } });
    }
    if (rest.length >= 4 && rest[2] === 'heads' && m === 'GET') {
      const branch = rest.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return json(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // /contents/{path...}
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (m === 'GET') return getContents(ctx, repo, path);
    if (m === 'PUT') return putContents(ctx, repo, path);
    if (m === 'DELETE') return deleteContents(ctx, repo, path);
    return err(404, 'Not Found');
  }

  // /labels
  if (head === 'labels') {
    if (m === 'POST' && rest.length === 1) {
      const body = bodyRecord(ctx);
      const name = str(body?.name).trim();
      if (name === '') return err(422, 'name is required');
      const color = str(body?.color, 'ededed');
      repo.labels.set(name, { name, color });
      return json(201, { name, color });
    }
    if (m === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
    }
    return err(404, 'Not Found');
  }

  // /issues
  if (head === 'issues') {
    return handleIssues(ctx, repo, rest.slice(1));
  }

  // /pulls
  if (head === 'pulls') {
    return handlePulls(ctx, repo, rest.slice(1));
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function tipTreeForRef(repo: Repo, ref: string | null): { tip: string; treeOid: string } | null {
  let tip: string | undefined;
  if (ref === null || ref === '') {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  } else {
    tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
  }
  if (tip === undefined) return null;
  const treeOid = commitTreeOid(repo, tip);
  if (treeOid === null) return null;
  return { tip, treeOid };
}

function getContents(ctx: ReqCtx, repo: Repo, path: string): RestResult {
  const ref = ctx.query.get('ref');
  const resolved = tipTreeForRef(repo, ref);
  if (resolved === null) return err(404, 'Not Found');
  const files = flattenTree(repo, resolved.treeOid);
  if (path === '') {
    // Root listing.
    return json(200, dirListing(repo, resolved.treeOid, ''));
  }
  const file = files.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const content = blob?.data ?? Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: path.split('/').pop(),
      path,
      content: content.toString('base64'),
      sha: file.oid,
    });
  }
  // Directory?
  const prefix = `${path}/`;
  let isDir = false;
  for (const key of files.keys()) if (key.startsWith(prefix)) { isDir = true; break; }
  if (!isDir) return err(404, 'Not Found');
  const treeOid = findSubtree(repo, resolved.treeOid, path.split('/'));
  if (treeOid === null) return err(404, 'Not Found');
  return json(200, dirListing(repo, treeOid, path));
}

function findSubtree(repo: Repo, treeOid: string, parts: string[]): string | null {
  let current = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function dirListing(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    out.push({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    });
  }
  return out;
}

function putContents(ctx: ReqCtx, repo: Repo, path: string): RestResult {
  const body = bodyRecord(ctx);
  if (body === null) return err(400, 'Invalid JSON body');
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') return err(422, 'message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = str(body.branch, repo.defaultBranch);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  // Current state of the path on the branch.
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let files = new Map<string, FlatEntry>();
  if (tip !== undefined) {
    const treeOid = commitTreeOid(repo, tip);
    if (treeOid !== null) files = flattenTree(repo, treeOid);
  }
  const existing = files.get(path);
  if (sha !== undefined) {
    if (existing === undefined) return err(422, 'sha does not match any existing file');
    if (existing.oid.toLowerCase() !== sha.toLowerCase()) return err(409, 'sha does not match the current file');
  }
  const result = putContentFile(repo, branch, path, content, message, ctx.store.clock);
  return json(result.created ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: result.blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: result.commitSha },
  });
}

function deleteContents(ctx: ReqCtx, repo: Repo, path: string): RestResult {
  const body = bodyRecord(ctx);
  if (body === null) return err(400, 'Invalid JSON body');
  const message = str(body.message);
  const sha = str(body.sha);
  const branch = str(body.branch, repo.defaultBranch);
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return err(404, 'Not Found');
  const treeOid = commitTreeOid(repo, tip);
  if (treeOid === null) return err(404, 'Not Found');
  const files = flattenTree(repo, treeOid);
  const existing = files.get(path);
  if (existing === undefined) return err(404, 'Not Found');
  if (sha !== '' && existing.oid.toLowerCase() !== sha.toLowerCase()) return err(409, 'sha does not match the current file');
  const commitSha = deleteContentFile(repo, branch, path, message, ctx.store.clock);
  if (commitSha === null) return err(404, 'Not Found');
  return json(200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: ReqCtx, repo: Repo, rest: string[]): RestResult {
  const m = ctx.method;
  if (rest.length === 0) {
    if (m === 'POST') {
      const body = bodyRecord(ctx);
      if (body === null) return err(400, 'Invalid JSON body');
      const title = str(body.title).trim();
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = createIssueRecord(ctx.store, repo, title, str(body.body), labels);
      if ('error' in created) return err(422, created.error);
      return json(201, issueJson(repo, created));
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, headers } = paginate(ctx, issues.map((i) => issueJson(repo, i)));
      return json(200, page, headers);
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (m === 'GET') return json(200, issueJson(repo, issue));
    if (m === 'PATCH') {
      const body = bodyRecord(ctx);
      if (body !== null) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.closedAt = body.state === 'closed' ? ctx.store.clock.nowIso() : null;
        }
        issue.updatedAt = ctx.store.clock.nowIso();
      }
      return json(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (m === 'POST') {
      const body = bodyRecord(ctx);
      if (body === null) return err(400, 'Invalid JSON body');
      const text = str(body.body);
      if (text === '') return err(422, 'body is required');
      const id = ctx.store.nextCommentId;
      ctx.store.nextCommentId += 1;
      const now = ctx.store.clock.nowIso();
      const comment = { id, globalId: globalId('IssueComment', id), body: text, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      return json(201, commentJson(comment));
    }
    if (m === 'GET') {
      return json(200, issue.comments.map((c) => commentJson(c)));
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(ctx: ReqCtx, repo: Repo, rest: string[]): RestResult {
  const m = ctx.method;
  if (rest.length === 0) {
    if (m === 'POST') {
      const body = bodyRecord(ctx);
      if (body === null) return err(400, 'Invalid JSON body');
      const title = str(body.title).trim();
      const head = str(body.head).trim();
      const base = str(body.base).trim();
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const created = createPullRecord(ctx.store, repo, title, str(body.body), head, base);
      if ('error' in created) return err(422, created.error);
      return json(201, pullJson(repo, created));
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(ctx, pulls.map((p) => pullJson(repo, p)));
      return json(200, page, headers);
    }
    return err(404, 'Not Found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pr = repo.pulls.get(number);
  if (pr === undefined) return err(404, 'Not Found');

  if (rest.length === 1) {
    if (m === 'GET') return json(200, pullJson(repo, pr));
    return err(404, 'Not Found');
  }

  if (rest.length === 2 && rest[1] === 'files' && m === 'GET') {
    const files = prFiles(repo, pr).map((f) => ({
      filename: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    return json(200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && m === 'PUT') {
    if (pr.state !== 'open') return err(405, 'Pull request is not open');
    if (prIsConflicted(repo, pr)) return err(405, 'Merge conflict');
    const mergeSha = squashMerge(repo, pr, ctx.store.clock);
    return json(200, { merged: true, sha: mergeSha, message: `${pr.title} (#${pr.number})` });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Shared lookups for GraphQL / MCP
// ---------------------------------------------------------------------------

/** Find an issue or pull request by its opaque global id. */
export function findByGlobalId(store: Store, id: string): { repo: Repo; issue?: Issue; pull?: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository' && decoded.parts.length === 1) {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    return repo === undefined ? null : { repo };
  }
  if (decoded.kind === 'Issue' && decoded.parts.length === 2) {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(decoded.parts[1]));
    return issue === undefined ? null : { repo, issue };
  }
  if (decoded.kind === 'PullRequest' && decoded.parts.length === 2) {
    const repo = store.getRepoById(Number(decoded.parts[0]));
    if (repo === undefined) return null;
    const pull = repo.pulls.get(Number(decoded.parts[1]));
    return pull === undefined ? null : { repo, pull };
  }
  if (decoded.kind === 'IssueComment' && decoded.parts.length === 1) {
    const commentId = Number(decoded.parts[0]);
    for (const repo of store.repos.values()) {
      for (const issue of repo.issues.values()) {
        if (issue.comments.some((c) => c.id === commentId)) return { repo, issue };
      }
    }
    return null;
  }
  return null;
}

export { DEFAULT_BRANCH };

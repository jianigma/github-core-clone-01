// graphql.ts — a small GraphQL executor for the fixed documents gh and
// github-mcp-server send (see checks-graphql.ts GRAPHQL_DOCUMENTS). It parses
// the query language subset those documents use and executes against the store.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  globalId,
  prIsConflicted,
  prMergeable,
  prFiles,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './core.ts';
import { createIssueRecord, createPullRecord, findByGlobalId } from './rest.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) {
        if (input[j] === '.') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[] | null;
}

export interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  name: string | null;
  selections: Selection[];
}

export type Selection = FieldSelection | FragmentSelection;

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
    }
    // Variable definitions: ($var: Type = default, ...)
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.skipBalancedParens();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    while (this.peek().kind !== 'eof') {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, name: null, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        return { kind: 'fragment', typeCondition: null, name, selections: [] };
      }
      throw new Error('expected a fragment name or "on" after ...');
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated argument list');
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return parseInt(token.value, 10);
    if (token.kind === 'float') return parseFloat(token.value);
    if (token.kind === 'punct' && token.value === '$') return { $var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated list');
        list.push(this.parseValue());
      }
      this.expectPunct(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated object');
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema (the fields the fixed documents may ask for)
// ---------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'url', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'author', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo'],
  PullRequestChangedFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PULL_REQUEST', 'REPOSITORY', 'USER'];

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

function userNode(): GqlNode {
  return { __typename: 'User', id: globalId('User', VIEWER_ID), login: VIEWER_LOGIN, name: VIEWER_LOGIN };
}

function repoNode(repo: Repo): GqlNode {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const node: GqlNode = {
    __typename: 'Repository',
    id: repo.globalId,
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(),
    defaultBranchRef: tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.isPrivate,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
  node.__repo = repo;
  return node;
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    labels: issue.labels.map((name) => ({ __typename: 'Label', name })),
    author: userNode(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(repo: Repo, pr: Pull): GqlNode {
  const { head, base } = { head: repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha, base: repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha };
  const node: GqlNode = {
    __typename: 'PullRequest',
    id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    mergeable: prMergeable(repo, pr),
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: head,
    baseRefOid: base,
    author: userNode(),
  };
  node.__repo = repo;
  node.__pr = pr;
  return node;
}

function commentNode(comment: { id: number; globalId: string; body: string; createdAt: string }): GqlNode {
  return { __typename: 'IssueComment', id: comment.globalId, body: comment.body, createdAt: comment.createdAt, author: userNode() };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
  fragments: Map<string, FragmentDef>;
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in (value as Record<string, unknown>)) {
      const name = (value as { $var: string }).$var;
      return variables[name] ?? null;
    }
    if ('$enum' in (value as Record<string, unknown>)) {
      return (value as { $enum: string }).$enum;
    }
    if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveVariables(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveVariables(v, variables);
  return out;
}

function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    if (match !== null) return parseInt(match[1] as string, 10);
  } catch {
    // fall through
  }
  const plain = /^issue:(\d+)$/.exec(cursor);
  if (plain !== null) return parseInt(plain[1] as string, 10);
  const num = parseInt(cursor, 10);
  return Number.isFinite(num) ? num : null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 10;
  const after = decodeCursor(args.after);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    issues = issues.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
  }
  const page = issues.slice(0, Math.max(0, first));
  const hasNextPage = issues.length > page.length;
  const last = page[page.length - 1];
  const firstNode = page[0];
  return {
    __typename: 'IssueConnection',
    nodes: page.map((i) => issueNode(repo, i)),
    edges: page.map((i) => ({ __typename: 'IssueEdge', node: issueNode(repo, i), cursor: encodeCursor(i.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: firstNode === undefined ? null : encodeCursor(firstNode.number),
      endCursor: last === undefined ? null : encodeCursor(last.number),
    },
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 10;
  const pulls = [...repo.pulls.values()].filter((p) => p.state === 'open').sort((a, b) => b.number - a.number).slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestConnection',
    nodes: pulls.map((p) => pullNode(repo, p)),
    edges: pulls.map((p) => ({ __typename: 'PullRequestEdge', node: pullNode(repo, p), cursor: encodeCursor(p.number) })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

function filesConnection(repo: Repo, pr: Pull, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 10;
  const files = prFiles(repo, pr).slice(0, Math.max(0, first));
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: files.map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path, filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })),
    edges: files.map((f) => ({ __typename: 'PullRequestChangedFileEdge', node: { __typename: 'PullRequestChangedFile', path: f.path }, cursor: null })),
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function typeNode(name: string): GqlNode {
  const fields = SCHEMA_FIELDS[name] ?? [];
  return {
    __typename: '__Type',
    name,
    fields: fields.map((f) => ({ __typename: '__Field', name: f })),
    enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v })) : [],
  };
}

function executeSelections(
  state: ExecState,
  selections: Selection[],
  parentType: string,
  parentValue: unknown,
  path: Array<string | number> = [],
): Record<string, unknown> | null {
  if (parentValue === null || parentValue === undefined) return null;
  const out: Record<string, unknown> = {};
  const fields = SCHEMA_FIELDS[parentType] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.name !== null) {
        const def = state.fragments.get(selection.name);
        if (def === undefined) continue;
        if (def.typeCondition !== parentType && def.typeCondition !== ((parentValue as GqlNode).__typename ?? parentType)) continue;
        const merged = executeSelections(state, def.selections, parentType, parentValue, path);
        if (merged !== null) Object.assign(out, merged);
        continue;
      }
      const typename = (parentValue as GqlNode).__typename ?? parentType;
      if (selection.typeCondition !== null && selection.typeCondition !== typename) continue;
      const merged = executeSelections(state, selection.selections, parentType, parentValue, path);
      if (merged !== null) Object.assign(out, merged);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (!fields.includes(selection.name) && !selection.name.startsWith('__')) {
      state.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: [...path, key] });
      continue;
    }
    const args = resolveArgs(selection.args, state.variables);
    const resolved = resolveField(state, parentType, parentValue, selection.name, args, [...path, key]);
    if (resolved === undefined) continue;
    const { value, typename } = resolved;
    if (selection.selections === null || selection.selections.length === 0) {
      out[key] = value;
    } else if (value === null || value === undefined) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (entry === null || typeof entry !== 'object') return entry;
        const entryType = (entry as GqlNode).__typename ?? typename;
        return executeSelections(state, selection.selections as Selection[], entryType, entry, [...path, key]);
      });
    } else if (typeof value === 'object') {
      const entryType = (value as GqlNode).__typename ?? typename;
      out[key] = executeSelections(state, selection.selections, entryType, value, [...path, key]);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveField(
  state: ExecState,
  parentType: string,
  parentValue: unknown,
  field: string,
  args: Record<string, unknown>,
  path: Array<string | number>,
): { value: unknown; typename: string } | undefined {
  const store = state.store;
  const node = parentValue as GqlNode;
  if (parentType === 'Query') {
    if (field === 'viewer') return { value: userNode(), typename: 'User' };
    if (field === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return { value: repo === undefined ? null : repoNode(repo), typename: 'Repository' };
    }
    if (field === 'node') {
      const found = findByGlobalId(store, String(args.id ?? ''));
      if (found === null) return { value: null, typename: 'Node' };
      if (found.issue !== undefined) return { value: issueNode(found.repo, found.issue), typename: 'Issue' };
      if (found.pull !== undefined) return { value: pullNode(found.repo, found.pull), typename: 'PullRequest' };
      return { value: repoNode(found.repo), typename: 'Repository' };
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      if (SCHEMA_FIELDS[name] === undefined && name !== 'SearchType') {
        return { value: null, typename: '__Type' };
      }
      return { value: typeNode(name), typename: '__Type' };
    }
    return undefined;
  }
  if (parentType === 'Mutation') {
    return resolveMutation(state, field, args, path);
  }
  if (parentType === 'Repository') {
    const repo = node.__repo as Repo | undefined;
    if (repo === undefined) return undefined;
    if (field === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return { value: issue === undefined ? null : issueNode(repo, issue), typename: 'Issue' };
    }
    if (field === 'issues') return { value: issuesConnection(repo, args), typename: 'IssueConnection' };
    if (field === 'pullRequests') return { value: pullsConnection(repo, args), typename: 'PullRequestConnection' };
    if (field === 'pullRequest') {
      const pr = repo.pulls.get(Number(args.number));
      return { value: pr === undefined ? null : pullNode(repo, pr), typename: 'PullRequest' };
    }
    if (field in node) return { value: node[field], typename: field === 'owner' ? 'User' : field === 'defaultBranchRef' ? 'Ref' : 'String' };
    return undefined;
  }
  if (parentType === 'PullRequest') {
    const pr = node.__pr as Pull | undefined;
    const repo = node.__repo as Repo | undefined;
    if (field === 'files' && pr !== undefined && repo !== undefined) {
      return { value: filesConnection(repo, pr, args), typename: 'PullRequestChangedFileConnection' };
    }
    if (field in node) return { value: node[field], typename: 'String' };
    return undefined;
  }
  if (field in node) {
    const value = node[field];
    const typename = Array.isArray(value) ? 'String' : typeof value === 'object' && value !== null ? ((value as GqlNode).__typename ?? 'String') : 'String';
    return { value, typename };
  }
  return undefined;
}

function resolveMutation(
  state: ExecState,
  field: string,
  args: Record<string, unknown>,
  path: Array<string | number>,
): { value: unknown; typename: string } | undefined {
  const store = state.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const found = findByGlobalId(store, String(input.repositoryId ?? ''));
    if (found === null) {
      state.errors.push({ message: 'Repository not found', path });
      return { value: null, typename: 'CreateIssuePayload' };
    }
    const created = createIssueRecord(store, found.repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      state.errors.push({ message: created.error, path });
      return { value: null, typename: 'CreateIssuePayload' };
    }
    return { value: { __typename: 'CreateIssuePayload', issue: issueNode(found.repo, created) }, typename: 'CreateIssuePayload' };
  }
  if (field === 'closeIssue') {
    const found = findByGlobalId(store, String(input.issueId ?? ''));
    if (found === null || found.issue === undefined) {
      state.errors.push({ message: 'Issue not found', path });
      return { value: null, typename: 'CloseIssuePayload' };
    }
    const issue = found.issue;
    issue.state = 'closed';
    issue.closedAt = store.clock.nowIso();
    issue.updatedAt = issue.closedAt;
    return { value: { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, issue) }, typename: 'CloseIssuePayload' };
  }
  if (field === 'createPullRequest') {
    const found = findByGlobalId(store, String(input.repositoryId ?? ''));
    if (found === null) {
      state.errors.push({ message: 'Repository not found', path });
      return { value: null, typename: 'CreatePullRequestPayload' };
    }
    const created = createPullRecord(store, found.repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) {
      state.errors.push({ message: created.error, path });
      return { value: null, typename: 'CreatePullRequestPayload' };
    }
    return { value: { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(found.repo, created) }, typename: 'CreatePullRequestPayload' };
  }
  if (field === 'mergePullRequest') {
    const found = findByGlobalId(store, String(input.pullRequestId ?? ''));
    if (found === null || found.pull === undefined) {
      state.errors.push({ message: 'Pull request not found', path });
      return { value: null, typename: 'MergePullRequestPayload' };
    }
    const pr = found.pull;
    if (pr.state !== 'open') {
      state.errors.push({ message: 'Pull request is not open', path });
      return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, pr) }, typename: 'MergePullRequestPayload' };
    }
    if (prIsConflicted(found.repo, pr)) {
      state.errors.push({ message: 'Merge conflict', path });
      return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, pr) }, typename: 'MergePullRequestPayload' };
    }
    squashMerge(found.repo, pr, store.clock);
    return { value: { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, pr) }, typename: 'MergePullRequestPayload' };
  }
  if (field === 'addComment') {
    const found = findByGlobalId(store, String(input.subjectId ?? ''));
    if (found === null || found.issue === undefined) {
      state.errors.push({ message: 'Issue not found', path });
      return { value: null, typename: 'AddCommentPayload' };
    }
    const id = store.nextCommentId;
    store.nextCommentId += 1;
    const now = store.clock.nowIso();
    const comment = { id, globalId: globalId('IssueComment', id), body: String(input.body ?? ''), createdAt: now, updatedAt: now };
    found.issue.comments.push(comment);
    return {
      value: { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(comment), cursor: encodeCursor(id) } },
      typename: 'AddCommentPayload',
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GraphQLCtx {
  store: Store;
  rawBody: Buffer;
}

export function handleGraphQL(ctx: GraphQLCtx): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Invalid JSON body' } };
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: unknown[] = [];
  for (const operation of operations) {
    results.push(executeOperation(ctx.store, operation));
  }
  return { status: 200, body: Array.isArray(parsed) ? results : results[0] };
}

function executeOperation(store: Store, operation: unknown): Record<string, unknown> {
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'Invalid operation' }] };
  }
  const record = operation as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let document;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const op = operationName === null ? document.operations[0] : document.operations.find((o) => o.name === operationName) ?? document.operations[0];
  if (op === undefined) {
    return { data: null, errors: [{ message: 'No operation found in document' }] };
  }
  const state: ExecState = { store, variables, errors: [], fragments: document.fragments };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(state, op.selections, rootType, {});
  if (state.errors.length > 0) {
    return { data, errors: state.errors };
  }
  return { data };
}

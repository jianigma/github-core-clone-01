// mcp.ts — the Model Context Protocol endpoint (POST /mcp), modern
// server/discover era with the legacy initialize handshake as a fallback.
// Tools act on the same store as REST and GraphQL.

import { VIEWER_LOGIN, prIsConflicted, squashMerge, type Store } from './core.ts';
import { createIssueRecord, createPullRecord, issueJson, pullJson, repoJson } from './rest.ts';

export interface McpCtx {
  store: Store;
  rawBody: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcOk(id: unknown, result: unknown): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string): { status: number; body: unknown } {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach (must already exist).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function textResult(value: unknown, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function runTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name).trim();
      if (repoName === '') return { error: 'name is required' };
      const repo = store.createRepo(VIEWER_LOGIN, repoName, {
        description: str(args.description),
        isPrivate: args.private === true,
      });
      if (repo === null) return { error: 'Repository already exists' };
      return repoJson(repo);
    }
    case 'get_repo': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { error: 'Not Found' };
      return repoJson(repo);
    }
    case 'create_issue': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { error: 'Not Found' };
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = createIssueRecord(store, repo, str(args.title), str(args.body), labels);
      if ('error' in created) return { error: created.error };
      return issueJson(repo, created);
    }
    case 'list_issues': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { error: 'Not Found' };
      const state = str(args.state, 'open');
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return issues.map((i) => issueJson(repo, i));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { error: 'Not Found' };
      const created = createPullRecord(store, repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if ('error' in created) return { error: created.error };
      return pullJson(repo, created);
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(str(args.owner), str(args.repo));
      if (repo === undefined) return { error: 'Not Found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pr = repo.pulls.get(number);
      if (pr === undefined) return { error: 'Not Found' };
      if (pr.state !== 'open') return { error: 'Pull request is not open' };
      if (prIsConflicted(repo, pr)) return { error: 'Merge conflict' };
      squashMerge(repo, pr, store.clock);
      return pullJson(repo, pr);
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export function handleMcp(ctx: McpCtx): { status: number; body: unknown | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  // A JSON-RPC notification (no id) gets no response body.
  if (parsed.id === undefined) {
    return { status: 202, body: null };
  }
  const id = parsed.id;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  switch (method) {
    case 'server/discover':
      return rpcOk(id, {
        resultType: 'discover',
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcOk(id, { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
    }
    case 'tools/list':
      return rpcOk(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length > 0) {
        return rpcOk(id, textResult({ error: `missing required argument(s): ${missing.join(', ')}` }, true));
      }
      try {
        const result = runTool(ctx.store, toolName, args);
        if (isRecord(result) && typeof result.error === 'string') return rpcOk(id, textResult(result, true));
        return rpcOk(id, textResult(result));
      } catch (error) {
        return rpcOk(id, textResult({ error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    case 'ping':
      return rpcOk(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

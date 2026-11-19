# github-core-clone-01

[![make.fun competition](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jianigma/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jianigma/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node process, no dependencies: git
smart HTTP, REST v3, GraphQL v4 and an MCP endpoint on one in-memory store.
Built for [the contest](https://make.fun/bounty/github-core-clone-01).

Local grade: **feature 600/600, agent 200/200, perf 156/200, total 956/1000**
(`grade-local --driver process`, practice trial 0; replay byte-for-byte
deterministic).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there and makes an older
local Node work too. There is nothing to install: the program imports
`node:http`, `node:crypto`, `node:zlib` and its own modules only, and the
trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in
`MAKEFUN_ENV_URL` (`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one.
   Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection, `node(id:)`, batching and cursor pagination |
| `POST /mcp` | MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (six tools on the same store) |
| `/<owner>/<repo>.git/...` | git smart HTTP: v2 `info/refs` + `ls-refs`/`fetch` for upload-pack, v0 `info/refs` + `receive-pack` with report-status |

Every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a
missing or wrong token is a 401. Every REST reply carries a non-empty
`X-GitHub-Request-Id` and `application/json`.

## How it works

- `core.ts` — the store: repositories, refs, git objects, issues, pull
  requests, labels and comments, plus reachability, tree building, diffs,
  merge-base, conflict detection and squash merge. All timestamps come from
  `MAKEFUN_TRIAL_NOW` plus a counter, never the wall clock, so a replay of
  the same request sequence produces the same bytes.
- `git-core.ts` — pkt-line framing and packfiles (read + write; deltas are
  resolved on read, full objects only on the wire). Pack reading recovers a
  stream's exact length by re-deflating (packs here are `deflateSync`
  output), with a binary-search fallback for foreign deflaters.
- `git-http.ts` — smart HTTP. Upload-pack v2 serves `ls-refs` (symrefs,
  peel, unborn HEAD, ref-prefix) and `fetch` (incremental, shallow/deepen
  with correct shallow-info, no packfile section when nothing is new).
  Receive-pack v0 is fast-forward only, per-ref `ok`/`ng non-fast-forward`
  inside a sideband report. Identical fetches of an unchanged repo are
  memoised.
- `rest.ts` — REST v3, including `Link` pagination, `PUT /contents` commits
  (create/update/delete with sha checks), and the 405-on-conflict merge.
- `graphql.ts` — a small GraphQL parser + executor for the fixed documents,
  with opaque Relay ids (`base64("Repository:…")` etc.) that are stable
  across reads and shared with REST and MCP.
- `mcp.ts` — the MCP endpoint: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.
- `app.ts` — the server: routing, auth, request ids, body limits, and an
  error boundary so one bad request never kills the process.

## Layout

- `main.ts`: the lifecycle. Keep it as it is.
- `app.ts`, `core.ts`, `git-core.ts`, `git-http.ts`, `rest.ts`,
  `graphql.ts`, `mcp.ts`: the forge.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the
contest page: **https://make.fun/bounty/github-core-clone-01**. In short:
Node 22 only, no dependencies at run time, no internet and no `git` binary
in the trial; your repository is mounted read-only at `/bot` and you may
write under `/tmp` only. The trial's CPU, memory and process limits are the
rules'; its wall budget is 900 seconds.

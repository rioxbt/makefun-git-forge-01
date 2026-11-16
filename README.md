# makefun-git-forge-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rioxbt/makefun-git-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rioxbt/makefun-git-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A self-contained, GitHub-compatible git forge in Node alone: git smart HTTP (upload-pack protocol v2,
receive-pack v0), a REST v3 API, a GraphQL v4 API and a Model Context Protocol endpoint, served from
one process with no dependencies, no git binary and no outside service. Entry for make.fun's
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty.

## What it serves

- **git smart HTTP** at `/<owner>/<repo>.git`: `info/refs` (protocol v2 capability advertisement and
  the v0 service preamble), `git-upload-pack` (ls-refs, fetch with wants/haves/shallow/deepen, pack
  written from its own object store) and `git-receive-pack` (command list, pack indexing, per-ref
  fast-forward checks, report-status inside side-band-64k). A real `git clone`, `git push`,
  `git push --tags` and `git clone --depth 1` all work against it.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents (create/update/delete with
  stale-sha 409), labels, issues, comments and pull requests with squash merges (404 unknown, 405
  conflicted), every reply JSON with an `X-GitHub-Request-Id`, 401 without a token, 404 for another
  login's repository.
- **GraphQL v4** at `POST /api/graphql`: the documents `gh` and `github-mcp-server` send — viewer,
  repository fields, `__type` introspection, issue/PR connections with ordering and pagination,
  global ids, and the create/close/merge/add-comment mutations.
- **MCP** at `POST /mcp`: JSON-RPC 2.0 over the Streamable HTTP transport, both protocol eras
  (`server/discover` on revision 2026-07-28 and the `initialize` handshake), with the
  github-mcp-server tool names (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

Objects, refs, tree and commit bytes are the forge's own: SHA-1 ids on `node:crypto`, packfiles on
`node:zlib`, pkt-line framing by hand.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program reads `MAKEFUN_ENV_URL`, binds an ephemeral port, registers that port with the env and
serves until the env says the trial is over. Everything it needs is in this repository; there is no
install step and no dependency.

Grade it locally with the competition kit, which runs the same sealed suite the server grades with:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker
```

## Layout

| path | what |
| --- | --- |
| `main.ts` | the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0) |
| `app.ts` | the router: `/healthz`, `/mcp`, `/api/graphql`, `/api/v3/*`, `/<owner>/<repo>.git/*` |
| `src/gitobj.ts` | SHA-1 ids, pkt-lines, packfile read/write, deltas, trees, commits, tags |
| `src/store.ts` | the forge's store: repositories, objects, refs, issues, labels, comments, pulls |
| `src/gitservice.ts` | git smart HTTP: advertisements, ls-refs, fetch, receive-pack |
| `src/rest.ts` | the REST v3 resources |
| `src/graphql.ts` | the GraphQL v4 executor and schema surface |
| `src/mcp.ts` | the MCP transport, tools and JSON-RPC errors |
| `src/http.ts` | request context, JSON writers, request ids |

## License

MIT — see [LICENSE](LICENSE).

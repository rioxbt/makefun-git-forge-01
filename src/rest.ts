// The GitHub REST v3 surface: repositories, branches, commits, contents, issues, comments,
// labels and pull requests, plus the protocol behaviour every reply owes the suite (JSON bodies,
// an X-GitHub-Request-Id on every answer, 401 without a token, 404 for another login's repository,
// 409 for a stale content sha, 422 for an unknown label, 405 for a conflicted merge).

import { parseCommit } from './gitobj.ts';
import { sendEmpty, sendError, sendJson, type Ctx } from './http.ts';
import type { Forge, Issue, Label, Pull, Repo, User } from './store.ts';
import { DEFAULT_LOGIN } from './store.ts';

const INSTALLED_VERSION = 'makefun-forge/1.0.0 (github-enterprise-compatible)';

function origin(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function userJson(forge: Forge, user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: `${origin0()}/avatars/${user.login}`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

function origin0(): string {
  return 'http://forge.local';
}

function ownerLogin(repo: Repo): string {
  return repo.owner ?? DEFAULT_LOGIN;
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const owner = ownerLogin(repo);
  const open = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.privateRepo,
    owner: {
      login: owner,
      id: 1,
      node_id: 'U_1',
      type: 'User',
      site_admin: false,
      html_url: `https://github.com/${owner}`,
    },
    html_url: `${origin0()}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://forge/${owner}/${repo.name}.git`,
    ssh_url: `git@forge:${owner}/${repo.name}.git`,
    clone_url: `${origin(ctx)}/${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: open,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.privateRepo ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(ctx: Ctx, forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: base,
    repository_url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}`,
    labels_url: `${base}/labels{/name}`,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
    html_url: `${origin0()}/${ownerLogin(repo)}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: null,
    title: issue.title,
    body: issue.body,
    user: userJson(forge, issue.user),
    labels: issue.labels.map((label) => labelJson(label, repo)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function commentJson(forge: Forge, repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; user: User }): Record<string, unknown> {
  const base = `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/issues/${issueNumber}/comments`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: base,
    html_url: `${origin0()}/${ownerLogin(repo)}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(forge, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function pullJson(ctx: Ctx, forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = ownerLogin(repo);
  const base = `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`;
  const headSha = pull.headSha ?? '';
  const baseSha = pull.baseSha ?? '';
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: base,
    html_url: `${origin0()}/${owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge, pull.user),
    labels: [],
    head: {
      label: `${owner}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: { login: owner, id: 1, node_id: 'U_1', type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}`, private: repo.privateRepo },
    },
    base: {
      label: `${owner}:${pull.base}`,
      ref: pull.base,
      sha: baseSha,
      user: { login: owner, id: 1, node_id: 'U_1', type: 'User' },
      repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}`, private: repo.privateRepo },
    },
    author_association: 'OWNER',
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: pull.merged ? { login: owner, id: 1 } : null,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else {
      const name = asString(asRecord(entry).name);
      if (name !== undefined) out.push(name);
    }
  }
  return out;
}

function paginate(ctx: Ctx, items: unknown[], path: string): { page: unknown[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    headers.link = `<${origin(ctx)}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return { page: slice, headers };
}

function repoFromPath(forge: Forge, segments: readonly string[], index: number): Repo | undefined {
  const owner = segments[index];
  const name = segments[index + 1];
  if (owner === undefined || name === undefined) return undefined;
  return forge.findRepo(owner, name);
}

// ---------------------------------------------------------------------------------------------
// the routes

export function handleRest(ctx: Ctx, forge: Forge, segments: readonly string[]): boolean {
  if (ctx.login === null) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }
  const jsonError = (): void => sendError(ctx, 400, 'Problems parsing JSON');
  const wantsJsonBody = (ctx.method === 'POST' || ctx.method === 'PUT' || ctx.method === 'PATCH' || ctx.method === 'DELETE');
  const parseFailed = wantsJsonBody && ctx.body.length > 0 && ctx.json === undefined;

  // GET /api/v3/ — the API root, with the token's scopes.
  if ((segments.length === 0 || (segments.length === 1 && segments[0] === '')) && ctx.method === 'GET') {
    sendJson(
      ctx,
      200,
      {
        current_user_url: `${origin(ctx)}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: `${origin(ctx)}/api/v3/authorizations`,
        repository_url: `${origin(ctx)}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${origin(ctx)}/api/v3/user/repos{?type,page,per_page,sort}`,
        user_url: `${origin(ctx)}/api/v3/users/{user}`,
        rate_limit_url: `${origin(ctx)}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (segments[0] === 'meta' && segments.length === 1 && ctx.method === 'GET') {
    sendJson(ctx, 200, {
      installed_version: INSTALLED_VERSION,
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
    });
    return true;
  }

  if (segments[0] === 'user' && segments.length === 1 && ctx.method === 'GET') {
    const login = ctx.login;
    sendJson(ctx, 200, userJson(forge, forge.user(login)));
    return true;
  }

  if (segments[0] === 'user' && segments.length === 2 && segments[1] === 'repos') {
    const login = ctx.login;
    if (ctx.method === 'GET') {
      const repos = forge.listRepos(login).map((repo) => repoJson(ctx, repo));
      const { page, headers } = paginate(ctx, repos, '/api/v3/user/repos');
      sendJson(ctx, 200, page, headers);
      return true;
    }
    if (ctx.method === 'POST') {
      if (parseFailed) {
        jsonError();
        return true;
      }
      const body = asRecord(ctx.json);
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(ctx, 422, 'Repository creation failed: name is required');
        return true;
      }
      const existing = forge.getRepo(null, name);
      if (existing !== undefined) {
        sendError(ctx, 422, `Repository creation failed. Name already exists on this account: ${name}`);
        return true;
      }
      const repo = forge.createRepo({
        name,
        owner: null,
        description: asString(body.description) ?? '',
        private: body.private === true,
      });
      if (asString(body.auto_init) === 'true' || body.auto_init === true) {
        forge.commitChanges(repo, { parent: null, changes: [{ path: 'README.md', content: Buffer.from(`# ${name}\n`, 'utf8') }], message: 'Initial commit', author: forge.user(ctx.login) });
      }
      sendJson(ctx, 201, repoJson(ctx, repo));
      return true;
    }
    return false;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = repoFromPath(forge, segments, 1);
    if (repo === undefined) {
      if (segments.length === 2) return false;
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    return reposSubroutes(ctx, forge, repo, segments.slice(3), parseFailed);
  }

  return false;
}

function reposSubroutes(ctx: Ctx, forge: Forge, repo: Repo, rest: readonly string[], parseFailed: boolean): boolean {
  const author = forge.user(ctx.login ?? DEFAULT_LOGIN);

  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.privateRepo = body.private;
      repo.updatedAt = new Date().toISOString();
      sendJson(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(repo);
      sendEmpty(ctx, 204);
      return true;
    }
    return false;
  }

  if (rest[0] === 'branches' && rest.length === 1 && ctx.method === 'GET') {
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .sort()
      .map((name) => ({
        name: name.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(name) as string, url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/commits/${repo.refs.get(name)}` },
        protected: false,
      }));
    sendJson(ctx, 200, branches);
    return true;
  }

  if (rest[0] === 'branches' && rest.length === 2 && ctx.method === 'GET') {
    const name = `refs/heads/${rest[1]}`;
    const sha = repo.refs.get(name);
    if (sha === undefined) {
      sendError(ctx, 404, 'Branch not found');
      return true;
    }
    sendJson(ctx, 200, { name: rest[1], commit: { sha }, protected: false });
    return true;
  }

  if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const from = forge.commitOf(repo, ref) ?? forge.commitOf(repo, `refs/heads/${ref}`);
    if (from === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const commits = forge.listCommits(repo, from, 100).map((sha) => {
      const object = repo.objects.get(sha);
      const parsed = object === undefined ? null : parseCommit(object.data);
      return {
        sha,
        node_id: `C_${sha}`,
        url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/commits/${sha}`,
        html_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/commit/${sha}`,
        commit: {
          message: (parsed?.message ?? '').replace(/\n$/, ''),
          tree: { sha: parsed?.tree ?? '' },
          author: { name: parsed?.author.split(' <')[0] ?? '', email: '', date: '' },
          committer: { name: parsed?.committer.split(' <')[0] ?? '', email: '', date: '' },
        },
        parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    sendJson(ctx, 200, commits);
    return true;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && ctx.method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const ref = asString(body.ref);
      const sha = asString(body.sha) ?? asString(asRecord(body.object).sha);
      if (ref === undefined || sha === undefined) {
        sendError(ctx, 422, 'The ref and sha are required');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(ctx, 422, `Object ${sha} does not exist in this repository`);
        return true;
      }
      forge.setRef(repo, ref, sha);
      sendJson(ctx, 201, {
        ref,
        node_id: `REF_${ref}`,
        url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: 'commit', url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/git/commits/${sha}` },
      });
      return true;
    }
    if (rest.length >= 3 && ctx.method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
      return true;
    }
    return false;
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return contentsRoute(ctx, forge, repo, path, author, parseFailed);
  }

  if (rest[0] === 'labels') {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, repo.labels.map((label) => labelJson(label, repo)));
      return true;
    }
    if (ctx.method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(ctx, 422, 'name is required');
        return true;
      }
      const label = forge.createLabel(repo, { name, color: asString(body.color) ?? 'ededed', description: asString(body.description) ?? '' });
      sendJson(ctx, 201, labelJson(label, repo));
      return true;
    }
    return false;
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1 && ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
      let issues = [...repo.issues];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(ctx, issues.map((issue) => issueJson(ctx, forge, repo, issue)), `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/issues`);
      sendJson(ctx, 200, page, headers);
      return true;
    }
    if (rest.length === 1 && ctx.method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const result = forge.createIssue(repo, {
        title: asString(body.title) ?? '',
        body: asString(body.body) ?? '',
        labelNames: asStringArray(body.labels),
        author,
      });
      if ('error' in result) {
        sendError(ctx, 422, `Validation Failed: ${result.error}`);
        return true;
      }
      sendJson(ctx, 201, issueJson(ctx, forge, repo, result.issue));
      return true;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      const issue = forge.issueByNumber(repo, number);
      if (rest.length === 2 && ctx.method === 'GET') {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, issueJson(ctx, forge, repo, issue));
        return true;
      }
      if (rest.length === 2 && (ctx.method === 'PATCH' || ctx.method === 'POST')) {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        if (parseFailed) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = asRecord(ctx.json);
        const state = asString(body.state);
        if (state === 'closed' || state === 'open') forge.setIssueState(issue, state);
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(ctx, 200, issueJson(ctx, forge, repo, issue));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        if (ctx.method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((comment) => commentJson(forge, repo, issue.number, comment)));
          return true;
        }
        if (ctx.method === 'POST') {
          if (parseFailed) {
            sendError(ctx, 400, 'Problems parsing JSON');
            return true;
          }
          const body = asRecord(ctx.json);
          const comment = forge.createComment(issue, repo, asString(body.body) ?? '', author);
          sendJson(ctx, 201, commentJson(forge, repo, issue.number, comment));
          return true;
        }
      }
    }
    return false;
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1 && ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      const { page, headers } = paginate(ctx, pulls.map((pull) => pullJson(ctx, forge, repo, pull)), `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/pulls`);
      sendJson(ctx, 200, page, headers);
      return true;
    }
    if (rest.length === 1 && ctx.method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const clean = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
      const head = clean(asString(body.head));
      const base = clean(asString(body.base));
      if (head === undefined || base === undefined) {
        sendError(ctx, 422, 'Validation Failed: head and base are required');
        return true;
      }
      const result = forge.createPull(repo, {
        title: asString(body.title) ?? '',
        body: asString(body.body) ?? '',
        head,
        base,
        author,
      });
      if ('error' in result) {
        sendError(ctx, 422, `Validation Failed: ${result.error}`);
        return true;
      }
      sendJson(ctx, 201, pullJson(ctx, forge, repo, result.pull));
      return true;
    }
    if (rest.length >= 2) {
      const number = Number.parseInt(rest[1], 10);
      const pull = forge.pullByNumber(repo, number);
      if (rest.length === 2 && ctx.method === 'GET') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, pullJson(ctx, forge, repo, pull));
        return true;
      }
      if (rest.length === 2 && ctx.method === 'PATCH') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        const body = asRecord(ctx.json);
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        const state = asString(body.state);
        if (state === 'closed') pull.state = 'closed';
        if (state === 'open') pull.state = 'open';
        sendJson(ctx, 200, pullJson(ctx, forge, repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && ctx.method === 'GET') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        const files = forge.pullFiles(repo, pull).map((file) => ({
          sha: repo.objects.has(file.filename) ? file.filename : `F_${pull.number}`,
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/blob/${pull.head}/${file.filename}`,
          raw_url: `${origin(ctx)}/${ownerLogin(repo)}/${repo.name}/raw/${pull.head}/${file.filename}`,
          contents_url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/contents/${file.filename}`,
          patch: file.patch,
        }));
        sendJson(ctx, 200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && (ctx.method === 'PUT' || ctx.method === 'POST')) {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        const body = asRecord(ctx.json);
        const method = (asString(body.merge_method) ?? 'merge').toLowerCase();
        const result = forge.mergePull(repo, pull, method, author);
        if (!result.ok) {
          sendError(ctx, result.code, result.message);
          return true;
        }
        sendJson(ctx, 200, { sha: result.sha, merged: true, message: result.message });
        return true;
      }
    }
    return false;
  }

  return false;
}

function contentsRoute(ctx: Ctx, forge: Forge, repo: Repo, path: string, author: User, parseFailed: boolean): boolean {
  // The branch is the request body's `branch` on a write (PUT/DELETE), else ?ref=, else the default.
  const requestBody = asRecord(ctx.json);
  const written = ctx.method === 'PUT' || ctx.method === 'POST' || ctx.method === 'DELETE';
  const requestedBranch = written ? asString(requestBody.branch) : undefined;
  const branch = requestedBranch ?? ctx.query.get('ref') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const commitSha = forge.commitOf(repo, refName);
  const tree = commitSha === undefined ? new Map<string, { mode: string; oid: string }>() : (() => {
    const object = repo.objects.get(commitSha);
    if (object === undefined) return new Map<string, { mode: string; oid: string }>();
    return forge.flattenTree(repo, parseCommit(object.data).tree);
  })();

  const entry = path === '' ? undefined : tree.get(path);
  const dirPrefix = path === '' ? '' : `${path}/`;
  const dirEntries = [...tree.entries()].filter(([candidate]) => candidate.startsWith(dirPrefix) && candidate !== path);

  if (ctx.method === 'GET') {
    if (entry !== undefined && entry.mode !== '40000' && entry.mode !== '040000') {
      const blob = repo.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: entry.oid,
        url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/contents/${path}`,
        html_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/blob/${branch}/${path}`,
        git_url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/git/blobs/${entry.oid}`,
        download_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/raw/${branch}/${path}`,
        _links: {},
      });
      return true;
    }
    if (dirEntries.length > 0 || (path !== '' && entry !== undefined)) {
      const direct = new Map<string, { name: string; type: string; path: string; sha: string; size: number }>();
      for (const [candidate, value] of dirEntries) {
        const remainder = candidate.slice(dirPrefix.length);
        if (remainder === '' || remainder.includes('/')) continue;
        direct.set(remainder, {
          name: remainder,
          type: value.mode === '40000' || value.mode === '040000' ? 'dir' : 'file',
          path: candidate,
          sha: value.oid,
          size: value.mode === '40000' || value.mode === '040000' ? 0 : (repo.objects.get(value.oid)?.data.length ?? 0),
        });
      }
      if (direct.size > 0) {
        sendJson(
          ctx,
          200,
          [...direct.values()].map((item) => ({
            ...item,
            url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/contents/${item.path}`,
            html_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/blob/${branch}/${item.path}`,
            git_url: null,
            download_url: item.type === 'file' ? `http://forge.local/${ownerLogin(repo)}/${repo.name}/raw/${branch}/${item.path}` : null,
            _links: {},
          })),
        );
        return true;
      }
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  if (ctx.method === 'PUT') {
    if (parseFailed) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const body = requestBody;
    const message = asString(body.message) ?? 'Update';
    const contentBase64 = asString(body.content);
    const sha = asString(body.sha);
    if (contentBase64 === undefined) {
      sendError(ctx, 422, 'Validation Failed: content is required');
      return true;
    }
    if (sha !== undefined) {
      if (entry === undefined) {
        sendError(ctx, 422, `Invalid request: sha ${sha} does not match any file`);
        return true;
      }
      if (entry.oid !== sha) {
        sendError(ctx, 409, `sha ${sha} does not match the current file sha ${entry.oid}`);
        return true;
      }
    }
    const content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const result = forge.commitChanges(repo, { parent: commitSha ?? null, changes: [{ path, content }], message, author });
    forge.setRef(repo, refName, result.commitSha);
    sendJson(
      ctx,
      entry === undefined ? 201 : 200,
      {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.contentSha,
          size: content.length,
          url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/contents/${path}`,
          html_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/blob/${branch}/${path}`,
          git_url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/git/blobs/${result.contentSha}`,
          download_url: `http://forge.local/${ownerLogin(repo)}/${repo.name}/raw/${branch}/${path}`,
          type: 'file',
          encoding: 'base64',
          _links: {},
        },
        commit: {
          sha: result.commitSha,
          node_id: `C_${result.commitSha}`,
          url: `${origin(ctx)}/api/v3/repos/${ownerLogin(repo)}/${repo.name}/git/commits/${result.commitSha}`,
          message,
          author: { name: author.name, email: author.email, date: new Date().toISOString() },
          committer: { name: author.name, email: author.email, date: new Date().toISOString() },
          tree: { sha: '', url: '' },
        },
      },
    );
    return true;
  }

  if (ctx.method === 'DELETE') {
    if (parseFailed) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const body = requestBody;
    const message = asString(body.message) ?? 'Delete';
    const sha = asString(body.sha);
    if (entry === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (sha !== undefined && sha !== entry.oid) {
      sendError(ctx, 409, `sha ${sha} does not match the current file sha ${entry.oid}`);
      return true;
    }
    const result = forge.commitChanges(repo, { parent: commitSha ?? null, changes: [{ path, content: null }], message, author });
    forge.setRef(repo, refName, result.commitSha);
    sendJson(ctx, 200, {
      content: null,
      commit: { sha: result.commitSha, message, author: { name: author.name, email: author.email, date: new Date().toISOString() } },
    });
    return true;
  }

  return false;
}

export { repoJson, issueJson, pullJson, userJson };

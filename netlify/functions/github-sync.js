// Netlify Function — sync de um repo GitHub (server-side, sem gh CLI)
// GET /.netlify/functions/github-sync?repo=owner/name
//
// Retorna o necessário pro connector "absorver" o repo:
//   { fetchedAt, repo: { full, url, prs, runs, commits, stats }, issues, cardLinks }
//
// PRs/runs/commits → overlay (página GitHub, badges). issues → viram cards nativos.
// cardLinks → liga PR/commit a card pelo #NN (título/body/branch/message).
//
// Requer env GH_PAT (mesmo da github-api.js). Faz paginação leve.

const https = require('https');

const GH_PAT = process.env.GH_PAT;

function ghApi(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.github.com${path}`);
    const req = https.request(u, {
      method: 'GET',
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'command-center',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function extractCardIds(text) {
  if (!text) return [];
  return [...new Set([...String(text).matchAll(/#(\d{1,4})\b/g)].map(m => parseInt(m[1], 10)))];
}

function prState(pr) {
  if (pr.merged_at) return 'MERGED';
  return (pr.state || '').toUpperCase(); // OPEN | CLOSED
}

async function syncRepo(repo) {
  const [pullsRaw, issuesRaw, runsRaw, commitsRaw] = await Promise.all([
    ghApi(`/repos/${repo}/pulls?state=all&per_page=60&sort=updated&direction=desc`).catch(() => []),
    ghApi(`/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`).catch(() => []),
    ghApi(`/repos/${repo}/actions/runs?per_page=15`).catch(() => ({ workflow_runs: [] })),
    ghApi(`/repos/${repo}/commits?per_page=25`).catch(() => []),
  ]);

  const prs = (pullsRaw || []).map(pr => ({
    repo: repo.split('/')[1],
    number: pr.number,
    title: pr.title,
    state: prState(pr),
    isDraft: !!pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    author: pr.user && pr.user.login,
    headRefName: pr.head && pr.head.ref,
    baseRefName: pr.base && pr.base.ref,
    labels: (pr.labels || []).map(l => ({ name: l.name, color: l.color })),
    reviewDecision: null,   // requer chamada extra; modal busca sob demanda
    mergeable: null,
    additions: null, deletions: null,
    url: pr.html_url,
    body: pr.body || '',
  }));

  const runs = ((runsRaw && runsRaw.workflow_runs) || []).map(r => ({
    databaseId: r.id,
    displayTitle: r.display_title,
    event: r.event,
    conclusion: r.conclusion,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    headBranch: r.head_branch,
    workflowName: r.name,
    url: r.html_url,
  }));

  const commits = (commitsRaw || []).map(c => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author && c.commit.author.name,
    date: c.commit.author && c.commit.author.date,
    url: c.html_url,
  }));

  // issues (a API /issues inclui PRs — filtra os que têm pull_request)
  const issues = (issuesRaw || []).filter(i => !i.pull_request).map(i => ({
    number: i.number,
    title: i.title,
    body: i.body || '',
    state: i.state,                    // open | closed
    labels: (i.labels || []).map(l => ({ name: l.name, color: l.color })),
    assignees: (i.assignees || []).map(a => a.login),
    author: i.user && i.user.login,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at,
    url: i.html_url,
  }));

  // cardLinks: #NN nos PRs e commits
  const cardLinks = {};
  const linkPush = (id, slot, obj) => {
    if (!cardLinks[id]) cardLinks[id] = { prs: [], commits: [] };
    cardLinks[id][slot].push(obj);
  };
  for (const pr of prs) {
    const ids = [...extractCardIds(pr.title), ...extractCardIds(pr.body), ...extractCardIds(pr.headRefName)];
    for (const id of ids) linkPush(id, 'prs', {
      repo: pr.repo, number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft,
      mergedAt: pr.mergedAt, closedAt: pr.closedAt, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
      headRefName: pr.headRefName, author: pr.author, reviewDecision: pr.reviewDecision,
      mergeable: pr.mergeable, additions: pr.additions, deletions: pr.deletions, url: pr.url,
    });
  }
  for (const c of commits) {
    for (const id of extractCardIds(c.message)) linkPush(id, 'commits', {
      repo: repo.split('/')[1], sha: c.sha.slice(0, 7),
      message: c.message.split('\n')[0].slice(0, 120), author: c.author, date: c.date, url: c.url,
    });
  }

  const stats = {
    openPRs: prs.filter(p => p.state === 'OPEN').length,
    mergedRecent: prs.filter(p => p.mergedAt && (Date.now() - new Date(p.mergedAt).getTime()) < 7 * 86400000).length,
    runsFailed: runs.filter(r => r.conclusion === 'failure').length,
    runsLastSuccess: runs.find(r => r.conclusion === 'success'),
    runsLastFailure: runs.find(r => r.conclusion === 'failure'),
  };

  return {
    fetchedAt: new Date().toISOString(),
    repo: { full: repo, url: `https://github.com/${repo}`, prs, runs, commits, stats },
    issues,
    cardLinks,
  };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (!GH_PAT) return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'GH_PAT não configurado' }) };

  const repo = (event.queryStringParameters || {}).repo;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'repo=owner/name obrigatório' }) };
  }

  try {
    const result = await syncRepo(repo);
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

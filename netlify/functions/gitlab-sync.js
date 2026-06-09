// Netlify Function — sync de um projeto GitLab (server-side, sem glab CLI)
// GET /.netlify/functions/gitlab-sync?project=group%2Fname  (ou ?project=12345 numérico)
//
// Retorna o necessário pro connector "absorver" o projeto — MESMO shape do github-sync:
//   { fetchedAt, repo: { full, url, prs, runs, commits, stats }, issues, cardLinks }
//
// MRs são normalizadas como prs (number=iid, state OPEN/MERGED/CLOSED). pipelines viram
// runs (conclusion derivado do status). issues → viram cards nativos. cardLinks → liga
// MR/commit a card pelo #NN (título/descrição/branch/message).
//
// Requer env GITLAB_TOKEN (header PRIVATE-TOKEN). Faz paginação leve.

const https = require('https');

const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const API = 'https://gitlab.com/api/v4';

function glApi(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${API}${path}`);
    const req = https.request(u, {
      method: 'GET',
      headers: {
        'PRIVATE-TOKEN': GITLAB_TOKEN,
        'Accept': 'application/json',
        'User-Agent': 'command-center',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitLab ${res.statusCode}: ${data.slice(0, 200)}`));
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

// state da MR → mesmo vocabulário dos PRs do GitHub
function mrState(mr) {
  const s = (mr.state || '').toLowerCase();
  if (s === 'merged') return 'MERGED';
  if (s === 'closed') return 'CLOSED';
  return 'OPEN'; // opened
}

// status do pipeline GitLab → conclusion estilo GitHub Actions
function pipelineConclusion(status) {
  switch ((status || '').toLowerCase()) {
    case 'success':  return 'success';
    case 'failed':   return 'failure';
    case 'canceled': return 'cancelled';
    case 'skipped':  return 'skipped';
    default:         return null; // running, pending, created, manual, scheduled…
  }
}

async function syncProject(idEnc) {
  // resolve metadados do projeto (path completo + url web)
  const meta = await glApi(`/projects/${idEnc}`).catch(() => ({}));
  const id = meta.id != null ? meta.id : idEnc;
  const full = meta.path_with_namespace || decodeURIComponent(idEnc);
  const webUrl = meta.web_url || `https://gitlab.com/${full}`;
  const short = full.split('/').pop();

  const [mrsRaw, issuesRaw, pipesRaw, commitsRaw] = await Promise.all([
    glApi(`/projects/${id}/merge_requests?state=all&per_page=60&order_by=updated_at&sort=desc`).catch(() => []),
    glApi(`/projects/${id}/issues?state=all&per_page=100&order_by=updated_at&sort=desc`).catch(() => []),
    glApi(`/projects/${id}/pipelines?per_page=15&order_by=updated_at&sort=desc`).catch(() => []),
    glApi(`/projects/${id}/repository/commits?per_page=25`).catch(() => []),
  ]);

  const prs = (mrsRaw || []).map(mr => ({
    repo: short,
    number: mr.iid,
    title: mr.title,
    state: mrState(mr),
    isDraft: !!(mr.draft || mr.work_in_progress),
    createdAt: mr.created_at,
    updatedAt: mr.updated_at,
    mergedAt: mr.merged_at,
    closedAt: mr.closed_at,
    author: mr.author && mr.author.username,
    headRefName: mr.source_branch,
    baseRefName: mr.target_branch,
    labels: (mr.labels || []).map(l => ({ name: l, color: null })),
    reviewDecision: null,   // requer chamada extra
    mergeable: null,
    additions: null, deletions: null,
    url: mr.web_url,
    body: mr.description || '',
  }));

  const runs = (pipesRaw || []).map(p => ({
    databaseId: p.id,
    displayTitle: p.ref,
    event: p.source,
    conclusion: pipelineConclusion(p.status),
    status: p.status,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    headBranch: p.ref,
    workflowName: 'pipeline',
    url: p.web_url,
  }));

  const commits = (commitsRaw || []).map(c => ({
    sha: c.id,
    message: c.message,
    author: c.author_name,
    date: c.authored_date || c.created_at,
    url: c.web_url,
  }));

  const issues = (issuesRaw || []).map(i => ({
    number: i.iid,
    title: i.title,
    body: i.description || '',
    state: (i.state || '') === 'closed' ? 'closed' : 'open',
    labels: (i.labels || []).map(l => ({ name: l, color: null })),
    assignees: (i.assignees || []).map(a => a.username),
    author: i.author && i.author.username,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at,
    url: i.web_url,
  }));

  // cardLinks: #NN nas MRs e commits
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
      repo: short, sha: String(c.sha).slice(0, 7),
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
    repo: { full, url: webUrl, prs, runs, commits, stats },
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
  if (!GITLAB_TOKEN) return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'GITLAB_TOKEN não configurado' }) };

  const project = (event.queryStringParameters || {}).project;
  if (!project) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'project=group/name (ou id numérico) obrigatório' }) };
  }
  // numérico → usa direto; path → encoda pro /projects/:id da API v4
  const idEnc = /^\d+$/.test(project) ? project : encodeURIComponent(project);

  try {
    const result = await syncProject(idEnc);
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

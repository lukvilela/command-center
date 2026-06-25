// Netlify Function — proxy de leitura GitHub API com PAT server-side
// GET /.netlify/functions/github-api?action=<...>&repo=<owner/name>&number=<N>
//
// Actions:
//   getPR        → PR completo (body, mergeable, files count, etc.)
//   getFiles     → arquivos modificados (com patches)
//   getReviews   → reviews (APPROVED, COMMENTED, CHANGES_REQUESTED)
//   getChecks    → status checks (CI runs)
//   getComments  → comments (issue + review comments)
//   getCommits   → commits do PR

const https = require('https');

const GH_PAT = process.env.GH_PAT;

function ghApi(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.github.com${path}`);
    const opts = {
      method: 'GET',
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'command-center',
      },
    };
    const req = https.request(u, opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const handlers = {
  async getPR({ repo, number }) {
    return ghApi(`/repos/${repo}/pulls/${number}`);
  },
  async getFiles({ repo, number }) {
    return ghApi(`/repos/${repo}/pulls/${number}/files?per_page=100`);
  },
  async getReviews({ repo, number }) {
    return ghApi(`/repos/${repo}/pulls/${number}/reviews`);
  },
  async getReviewComments({ repo, number }) {
    return ghApi(`/repos/${repo}/pulls/${number}/comments?per_page=50`);
  },
  async getComments({ repo, number }) {
    // issue comments (não review comments)
    return ghApi(`/repos/${repo}/issues/${number}/comments?per_page=50`);
  },
  async getCommits({ repo, number }) {
    return ghApi(`/repos/${repo}/pulls/${number}/commits?per_page=100`);
  },
  async getChecks({ repo, ref }) {
    // ref = sha do head do PR
    if (!ref) throw new Error('getChecks requer ref (sha)');
    return ghApi(`/repos/${repo}/commits/${ref}/check-runs?per_page=50`);
  },
  async getStatuses({ repo, ref }) {
    if (!ref) throw new Error('getStatuses requer ref');
    return ghApi(`/repos/${repo}/commits/${ref}/status`);
  },
  // Bundle: tudo de um PR de uma vez (só 1 chamada cliente → várias paralelas server-side)
  async getPRBundle({ repo, number }) {
    const pr = await ghApi(`/repos/${repo}/pulls/${number}`);
    const headSha = pr.head && pr.head.sha;
    const [files, reviews, reviewComments, comments, checks] = await Promise.all([
      ghApi(`/repos/${repo}/pulls/${number}/files?per_page=100`).catch(() => []),
      ghApi(`/repos/${repo}/pulls/${number}/reviews`).catch(() => []),
      ghApi(`/repos/${repo}/pulls/${number}/comments?per_page=50`).catch(() => []),
      ghApi(`/repos/${repo}/issues/${number}/comments?per_page=50`).catch(() => []),
      headSha ? ghApi(`/repos/${repo}/commits/${headSha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] })) : { check_runs: [] },
    ]);
    return { pr, files, reviews, reviewComments, comments, checks };
  },
};

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }
  if (!GH_PAT) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ erro: 'GH_PAT não configurado' }) };
  }

  const params = event.queryStringParameters || {};
  const { action, repo, number, ref } = params;

  if (!action) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: 'action obrigatório', allowed: Object.keys(handlers) }),
    };
  }
  const handler = handlers[action];
  if (!handler) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: `Ação desconhecida: ${action}`, allowed: Object.keys(handlers) }),
    };
  }

  try {
    const result = await handler({ repo, number, ref });
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, erro: e.message }),
    };
  }
};

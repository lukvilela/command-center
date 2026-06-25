// Netlify Function — ESCRITA no GitHub (merge PR, fechar/reabrir, comentar, criar issue)
// POST /.netlify/functions/github-write
//   headers: X-TCC-Secret: <CC_DASH_SECRET>
//   body: { action, data }
//
// Ações:
//   mergePR      { repo, number, method? 'merge'|'squash'|'rebase' }
//   closePR      { repo, number }
//   reopenPR     { repo, number }
//   commentPR    { repo, number, body }   (= comentário de issue, vale p/ PR tb)
//   commentIssue { repo, number, body }
//   closeIssue   { repo, number }
//   reopenIssue  { repo, number }
//   createIssue  { repo, title, body?, labels?, assignees? }
//
// Requer GH_PAT com escopo de ESCRITA (repo). Gated pelo secret compartilhado.

const https = require('https');

const GH_PAT = process.env.GH_PAT;
const SHARED_SECRET = process.env.CC_DASH_SECRET;

function ghWrite(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.github.com${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(u, {
      method,
      headers: {
        'Authorization': `token ${GH_PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'command-center',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub ${res.statusCode}: ${data.slice(0, 300)}`));
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const handlers = {
  mergePR: (d) => ghWrite('PUT', `/repos/${d.repo}/pulls/${d.number}/merge`,
    { merge_method: d.method || 'merge' }),
  closePR: (d) => ghWrite('PATCH', `/repos/${d.repo}/pulls/${d.number}`, { state: 'closed' }),
  reopenPR: (d) => ghWrite('PATCH', `/repos/${d.repo}/pulls/${d.number}`, { state: 'open' }),
  commentPR: (d) => ghWrite('POST', `/repos/${d.repo}/issues/${d.number}/comments`, { body: d.body }),
  commentIssue: (d) => ghWrite('POST', `/repos/${d.repo}/issues/${d.number}/comments`, { body: d.body }),
  closeIssue: (d) => ghWrite('PATCH', `/repos/${d.repo}/issues/${d.number}`, { state: 'closed' }),
  reopenIssue: (d) => ghWrite('PATCH', `/repos/${d.repo}/issues/${d.number}`, { state: 'open' }),
  createIssue: (d) => ghWrite('POST', `/repos/${d.repo}/issues`,
    { title: d.title, body: d.body || '', labels: d.labels || undefined, assignees: d.assignees || undefined }),
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TCC-Secret',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST only' };

  if (!GH_PAT) return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'GH_PAT não configurado' }) };
  if (!SHARED_SECRET) return { statusCode: 500, headers: cors, body: JSON.stringify({ erro: 'CC_DASH_SECRET não configurado' }) };

  const secret = event.headers['x-tcc-secret'] || event.headers['X-TCC-Secret'];
  if (secret !== SHARED_SECRET) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ erro: 'Secret inválido' }) };
  }

  let action, data;
  try { ({ action, data } = JSON.parse(event.body || '{}')); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'body inválido' }) }; }

  const handler = handlers[action];
  if (!handler) {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ erro: `Ação desconhecida: ${action}`, allowed: Object.keys(handlers) }) };
  }
  if (!data || !data.repo || !/^[^/]+\/[^/]+$/.test(data.repo)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'data.repo (owner/name) obrigatório' }) };
  }

  try {
    const result = await handler(data);
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, result }) };
  } catch (e) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

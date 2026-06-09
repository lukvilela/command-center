// Netlify Function — sync de um projeto Jira Cloud (server-side, OBRIGATÓRIO)
// POST /.netlify/functions/jira-sync   body: { site, projectKey, email, token }
//   site       → 'minhaorg' ou 'minhaorg.atlassian.net'
//   projectKey → ex. 'KAN'
//   email+token → Basic auth (token = API token de id.atlassian.com)
//
// ⚠️ Por que server-side: a REST API do Jira Cloud NÃO libera CORS pro navegador,
//    então (ao contrário de GitHub/GitLab) não dá pra puxar client-side. Esta
//    function faz o Basic auth e devolve o MESMO shape dos outros connectors:
//      { fetchedAt, repo:{full,url,prs:[],runs:[],commits:[],stats}, issues, cardLinks }
//    Jira não tem PRs/commits → esses arrays vêm vazios; o valor são as issues.

const https = require('https');

function jiraGet(host, path, auth) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'GET', headers: {
      'Authorization': 'Basic ' + auth, 'Accept': 'application/json', 'User-Agent': 'command-center',
    } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Jira ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// extrai texto plano do Atlassian Document Format (ADF) da descrição
function adfText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  let s = (node.content || []).map(adfText).join('');
  if (node.type === 'paragraph' || node.type === 'heading') s += '\n';
  if (node.type === 'listItem') s += '\n';
  return s;
}

// prioridade Jira → P0..P3
function mapPriority(name) {
  switch ((name || '').toLowerCase()) {
    case 'highest': case 'blocker': case 'critical': return 'P0';
    case 'high': case 'major': return 'P1';
    case 'medium': return 'P2';
    case 'low': case 'lowest': case 'minor': case 'trivial': return 'P3';
    default: return null;
  }
}

async function syncProject({ site, projectKey, email, token }) {
  const host = /\.atlassian\.net$/.test(site) ? site : `${site}.atlassian.net`;
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const base = `https://${host}`;

  const jql = encodeURIComponent(`project = "${projectKey}" ORDER BY updated DESC`);
  const fields = 'summary,status,priority,assignee,reporter,labels,issuetype,parent,created,updated,description';
  const path = `/rest/api/3/search?jql=${jql}&maxResults=100&fields=${fields}`;

  const data = await jiraGet(host, path, auth);
  const raw = data.issues || [];

  const issues = raw.map(it => {
    const f = it.fields || {};
    const cat = (f.status && f.status.statusCategory && f.status.statusCategory.key) || 'new';
    const epicName = f.parent && f.parent.fields ? (f.parent.fields.summary || '') : '';
    const issuetype = (f.issuetype && f.issuetype.name) || '';
    // epic em colchete: usa o issuetype como "epic" do card (ex.: [Bug], [Story])
    const epicTag = issuetype ? `[${issuetype.toUpperCase().replace(/\s+/g, '')}] ` : '';
    return {
      number: parseInt((it.key.split('-')[1] || '0'), 10),
      key: it.key,
      title: `${epicTag}${it.key} ${f.summary || ''}`.trim(),
      body: (typeof f.description === 'string' ? f.description : adfText(f.description)).trim(),
      state: cat === 'done' ? 'closed' : 'open',
      statusName: (f.status && f.status.name) || '',
      priority: mapPriority(f.priority && f.priority.name),
      labels: [issuetype, ...(f.labels || [])].filter(Boolean).map(n => ({ name: n, color: null })),
      assignees: f.assignee ? [f.assignee.displayName || f.assignee.accountId] : [],
      author: f.reporter && (f.reporter.displayName || f.reporter.accountId),
      epicName,
      createdAt: f.created, updatedAt: f.updated,
      url: `${base}/browse/${it.key}`,
    };
  });

  const stats = {
    openPRs: 0, mergedRecent: 0, runsFailed: 0, runsLastSuccess: null, runsLastFailure: null,
    totalIssues: issues.length, openIssues: issues.filter(i => i.state === 'open').length,
  };

  return {
    fetchedAt: new Date().toISOString(),
    repo: { full: `${host}/${projectKey}`, url: `${base}/browse/${projectKey}`, prs: [], runs: [], commits: [], stats },
    issues,
    cardLinks: {},
  };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST only' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'body inválido' }) }; }

  const { site, projectKey, email, token } = body;
  if (!site || !projectKey || !email || !token) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ erro: 'site, projectKey, email e token são obrigatórios' }) };
  }

  try {
    const result = await syncProject({ site, projectKey, email, token });
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, result }) };
  } catch (e) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, erro: e.message }) };
  }
};

// Netlify Function — snapshot live do Trello
// Retorna o derived.json calculado AGORA (não o cacheado)
// Usado pra live sync entre máquinas após escrita

const https = require('https');

const TRELLO_KEY = process.env.TRELLO_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID ;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function buildUrl(path, params) {
  const u = new URL(`https://api.trello.com/1${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function fetchBoardLight(key, token, boardId) {
  // Versão "light" — só o necessário pro derived.json
  const auth = { key, token };

  const [board, lists, cards, labels, members, checklists] = await Promise.all([
    get(buildUrl(`/boards/${boardId}`, { ...auth, fields: 'id,name,url,shortLink' })),
    get(buildUrl(`/boards/${boardId}/lists`, { ...auth, filter: 'all', fields: 'id,name,closed,pos' })),
    get(buildUrl(`/boards/${boardId}/cards/all`, {
      ...auth,
      fields: 'id,idShort,name,desc,closed,idList,idLabels,idMembers,idChecklists,due,dueComplete,dateLastActivity,shortUrl,cover,badges',
      attachments: 'cover',
      attachment_fields: 'id,url,name,bytes,date,previews',
    })),
    get(buildUrl(`/boards/${boardId}/labels`, { ...auth, limit: 100, fields: 'id,name,color' })),
    get(buildUrl(`/boards/${boardId}/members`, { ...auth, fields: 'id,fullName,username' })),
    get(buildUrl(`/boards/${boardId}/checklists`, { ...auth, fields: 'id,idCard' })),
  ]);

  return {
    id: board.id,
    name: board.name,
    url: board.url,
    shortLink: board.shortLink,
    lists,
    cards,
    labels,
    members,
    checklists,
    actions: [], // sem actions na versão light pra economizar tempo
  };
}

// Reusa exatamente o processBoard do refresh.js (copiado/adaptado pra rodar em function)
const EPIC_META = {
  CORE:   { name: 'Núcleo & Fundação',         priority: 'P0', icon: '🧱' },
  AUTH:   { name: 'Autenticação & Acesso',     priority: 'P0', icon: '🔐' },
  API:    { name: 'API & Integrações',         priority: 'P1', icon: '🔌' },
  UI:     { name: 'UI & Design System',        priority: 'P1', icon: '🎨' },
  DATA:   { name: 'Dados & Relatórios',        priority: 'P1', icon: '📊' },
  INFRA:  { name: 'Infra, DevOps & Segurança', priority: 'P0', icon: '🛡️' },
  BILLING:{ name: 'Pagamentos',                priority: 'P2', icon: '💰' },
  DOCS:   { name: 'Documentação',              priority: 'P3', icon: '📚' },
  OUTROS: { name: 'Outros',                    priority: 'P3', icon: '📦' },
};

function ageDays(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function processBoard(board) {
  const listById = Object.fromEntries(board.lists.map(l => [l.id, l]));
  const labelById = Object.fromEntries(board.labels.map(l => [l.id, l]));
  const memberById = Object.fromEntries(board.members.map(m => [m.id, m]));

  const cards = board.cards.map(c => {
    const list = listById[c.idList];
    const labels = (c.idLabels || []).map(id => labelById[id]).filter(Boolean);
    const members = (c.idMembers || []).map(id => memberById[id]).filter(Boolean);

    const epicMatch = c.name.match(/\[(\w+)\]/);
    const epic = epicMatch ? epicMatch[1] : 'OUTROS';
    const tipoMatch = c.name.match(/\b(Feat|Fix|Chore|Refactor|Perf|Bug|Docs)\b/i);
    const tipo = tipoMatch ? tipoMatch[1][0].toUpperCase() + tipoMatch[1].slice(1).toLowerCase() : 'Feat';

    const priorityLabel = labels.find(l => /^\d /.test(l.name || ''));
    const priorityNum = priorityLabel ? parseInt(priorityLabel.name[0], 10) : 5;
    const priorityCode = priorityLabel ? `P${priorityNum - 1}` : 'P3';

    const listName = list ? list.name : '';
    let status = 'pending';
    if (/done/i.test(listName)) status = 'done';
    else if (/sandbox|testing/i.test(listName)) status = 'testing';
    else if (/in progress/i.test(listName)) status = 'in_progress';
    else if (/blocked/i.test(listName)) status = 'blocked';
    else if (/icebox/i.test(listName)) status = 'icebox';
    else if (/to-?do/i.test(listName)) status = 'todo';
    else if (/backlog/i.test(listName)) status = 'backlog';

    return {
      id: c.id,
      idShort: c.idShort,
      name: c.name,
      desc: c.desc,
      url: c.shortUrl,
      list: listName,
      listClosed: list ? list.closed : false,
      cardClosed: c.closed,
      labels: labels.map(l => ({ name: l.name, color: l.color })),
      members: members.map(m => ({ id: m.id, name: m.fullName, username: m.username })),
      due: c.due,
      dueComplete: c.dueComplete,
      dateLastActivity: c.dateLastActivity,
      ageDays: ageDays(c.dateLastActivity),
      lastCommentDate: null,
      lastCommentAge: null,
      commentCount: 0,
      epic,
      tipo,
      priorityNum,
      priorityCode,
      status,
      pop: null, dor: null, dod: null, invest: null,
      idChecklists: c.idChecklists || [],
      cover: c.cover || null,
      attachments: c.attachments || [],
      badges: c.badges || {},
    };
  });

  const active = cards.filter(c => !c.cardClosed && !c.listClosed);
  const byList = {};
  for (const c of active) byList[c.list] = (byList[c.list] || 0) + 1;

  const workingLists = ['In Progress', 'Review', 'Blocked'];
  const byDev = {};
  for (const c of active.filter(c => workingLists.includes(c.list))) {
    for (const m of c.members) {
      if (!byDev[m.name]) byDev[m.name] = { inProgress: [], sandbox: [], blocked: [] };
      const slot = c.list === 'In Progress' ? 'inProgress' :
                   c.list === 'Review' ? 'sandbox' : 'blocked';
      byDev[m.name][slot].push({ idShort: c.idShort, name: c.name, url: c.url });
    }
  }

  // Alerts (só os essenciais nesse fast snapshot)
  const alerts = [];
  for (const c of active.filter(c => c.list === 'In Progress' && c.ageDays > 5)) {
    alerts.push({
      severity: c.ageDays > 14 ? 'critical' : 'warning',
      kind: 'stale_in_progress',
      text: `#${c.idShort} ${c.name} — In Progress há ${c.ageDays} dias`,
      cardId: c.id, idShort: c.idShort, url: c.url,
    });
  }
  for (const c of active.filter(c => c.list === 'Blocked' && c.ageDays > 7)) {
    alerts.push({
      severity: c.ageDays > 30 ? 'critical' : 'warning',
      kind: 'silent_blocked',
      text: `#${c.idShort} ${c.name} — Bloqueado, sem update há ${c.ageDays} dias`,
      cardId: c.id, idShort: c.idShort, url: c.url,
    });
  }

  // EPIC stats
  const epicStats = {};
  for (const k of Object.keys(EPIC_META)) {
    epicStats[k] = { ...EPIC_META[k], key: k, total: 0, done: 0, testing: 0, inProgress: 0, blocked: 0, todo: 0, backlog: 0, icebox: 0, pending: 0 };
  }
  for (const c of cards) {
    if (!epicStats[c.epic]) epicStats[c.epic] = { ...EPIC_META.OUTROS, key: c.epic, total: 0, done: 0, testing: 0, inProgress: 0, blocked: 0, todo: 0, backlog: 0, icebox: 0, pending: 0 };
    const s = epicStats[c.epic];
    s.total++;
    if (c.status === 'done') s.done++;
    else if (c.status === 'testing') s.testing++;
    else if (c.status === 'in_progress') s.inProgress++;
    else if (c.status === 'blocked') s.blocked++;
    else if (c.status === 'todo') s.todo++;
    else if (c.status === 'backlog') s.backlog++;
    else if (c.status === 'icebox') s.icebox++;
    else s.pending++;
  }
  for (const s of Object.values(epicStats)) {
    if (s.total === 0) s.statusLabel = '—';
    else if (s.done === s.total) s.statusLabel = '✅ COMPLETA';
    else if (s.blocked === s.total) s.statusLabel = '⏸️ BLOQUEADA';
    else if (s.icebox === s.total) s.statusLabel = '❄️ ICEBOX';
    else if (s.done > 0 || s.testing > 0 || s.inProgress > 0) s.statusLabel = '🟡 PARCIAL';
    else s.statusLabel = '🔴 PENDENTE';
    s.completionPct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
  }

  return {
    boardName: board.name,
    boardUrl: board.url,
    refreshedAt: new Date().toISOString(),
    counts: {
      totalCards: board.cards.length,
      activeCards: active.length,
      archivedCards: cards.length - active.length,
      byList,
      members: board.members.length,
      labels: board.labels.length,
    },
    alerts,
    byDev,
    cards,
    epics: Object.values(epicStats).filter(e => e.total > 0).sort((a, b) => {
      const pOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
      return (pOrder[a.priority] - pOrder[b.priority]) || (b.total - a.total);
    }),
    members: board.members.map(m => ({ id: m.id, name: m.fullName, username: m.username })),
    labels: board.labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
    lists: board.lists.map(l => ({ id: l.id, name: l.name, closed: l.closed, pos: l.pos })),
    metrics: { leadTimes: [], avgLeadTime: 0, velocity: [], avgVelocity: 0, ageBuckets: {}, cardHistory: {} },
  };
}

exports.handler = async (event) => {
  // CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (!TRELLO_KEY || !TRELLO_TOKEN) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ erro: 'Server: TRELLO_KEY/TOKEN não configurados' }) };
  }

  try {
    const board = await fetchBoardLight(TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID);
    const derived = processBoard(board);

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
      body: JSON.stringify(derived),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ erro: e.message }),
    };
  }
};

module.exports = module.exports || {};
module.exports.processBoard = processBoard;

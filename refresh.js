#!/usr/bin/env node
// Refresh: copia board.json mais recente + gera data/derived.json com stats agregados.
// Uso: node refresh.js                (procura sozinho o JSON mais recente)
//      node refresh.js /path/board.json   (usa o caminho passado)

const fs = require('fs');
const path = require('path');
const { fetchBoardFromAPI } = require('./trello-api');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function loadConfig() {
  const cfgPath = path.join(ROOT, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('⚠️  config.json não encontrado. Copie config.example.json → config.json e edite.');
    return null;
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function findSource(arg) {
  if (arg && fs.existsSync(arg)) return arg;
  // Procura board.json local em vários paths
  const candidates = [
    path.join(ROOT, 'board.json'),
    path.join(ROOT, 'data/board.json'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Downloads/board.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Nenhum board.json encontrado. Configure TRELLO_KEY/TOKEN/BOARD_ID no .env, ou passe o path como arg: node refresh.js /path/to/board.json');
}

function ageDays(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// EPIC_META + PERSONA_BY_EPIC carregados de config.json no main()
let EPIC_META = { OUTROS: { name: 'Outros', priority: 'P3', icon: '📦' } };
let PERSONA_BY_EPIC = { OUTROS: 'Usuário do sistema' };

function inferPOP(card, epic, tipo) {
  const persona = PERSONA_BY_EPIC[epic] || 'Usuário do sistema';
  const titleClean = card.name
    .replace(/^#?\d+\s*/, '')
    .replace(/^\[\w+\]\s*/, '')
    .replace(/^(Feat|Fix|Chore|Refactor|Perf|Bug|Docs):\s*/i, '')
    .trim();

  const beneficio = {
    Fix: 'corrigir problema que afeta o uso normal',
    Bug: 'corrigir defeito identificado',
    Feat: 'agregar valor de produto',
    Chore: 'manter saúde operacional e segurança',
    Refactor: 'melhorar manutenibilidade do código',
    Perf: 'reduzir custo ou melhorar performance',
    Docs: 'documentar conhecimento do time',
  }[tipo] || 'agregar valor de produto';

  return {
    persona,
    quero: titleClean.toLowerCase().replace(/\.$/, ''),
    para: beneficio,
  };
}

function inferDOR(card, prs) {
  return [
    { label: 'Card descrito no Trello', done: !!card.desc && card.desc.length > 30 },
    { label: 'Critérios de aceite definidos', done: card.desc && /critérios?\s+de\s+aceit/i.test(card.desc) },
    { label: 'Tasks/checklist preenchido', done: card.idChecklists && card.idChecklists.length > 0 },
    { label: 'Tamanho estimado (Small/Medium/Large)', done: card.desc && /size:?\s*(small|medium|large)/i.test(card.desc) },
    { label: 'Dependências mapeadas', done: !!(card.idLabels && card.idLabels.length > 0) },
    { label: 'Members atribuídos', done: !!(card.idMembers && card.idMembers.length > 0) },
  ];
}

function inferDOD(card, list, prs) {
  const isDone = list && /done/i.test(list.name);
  const isSandbox = list && /sandbox|testing/i.test(list.name);
  const hasMergedPR = prs.some(p => p.state === 'MERGED');
  const hasOpenPR = prs.some(p => p.state === 'OPEN');
  return [
    { label: 'PR aberto', done: hasOpenPR || hasMergedPR || isDone || isSandbox },
    { label: 'Code review aprovado', done: hasMergedPR || isDone },
    { label: 'Mergeado em main', done: hasMergedPR || isDone || isSandbox },
    { label: 'Deploy validado em sandbox', done: isSandbox || isDone },
    { label: 'Deploy validado em prod', done: isDone },
    { label: 'Critérios de aceite verificados', done: isDone },
  ];
}

function inferINVEST(card) {
  const labels = (card.idLabels || []).length;
  const desc = card.desc || '';
  const hasDeps = labels > 0 && /Bloqueio|Sequencial|Outros Precisam/i.test(desc);
  const sizeMatch = desc.match(/size:?\s*(small|medium|large)/i);
  const size = sizeMatch ? sizeMatch[1].toLowerCase() : null;
  return {
    independent: !hasDeps,
    negotiable: true, // sempre refinável
    valuable: !!desc && desc.length > 50,
    estimable: !!size,
    small: size === 'small' || size === 'medium',
    testable: /critérios|teste|verificar/i.test(desc),
  };
}

function processBoard(board) {
  const listById = Object.fromEntries(board.lists.map(l => [l.id, l]));
  const labelById = Object.fromEntries(board.labels.map(l => [l.id, l]));
  const memberById = Object.fromEntries(board.members.map(m => [m.id, m]));

  // Comments por card
  const commentsByCard = {};
  for (const a of board.actions || []) {
    if (a.type === 'commentCard' && a.data && a.data.card) {
      (commentsByCard[a.data.card.id] = commentsByCard[a.data.card.id] || []).push({
        date: a.date,
        author: a.memberCreator ? a.memberCreator.fullName : 'unknown',
        text: a.data.text,
      });
    }
  }

  const cards = board.cards.map(c => {
    const list = listById[c.idList];
    const labels = (c.idLabels || []).map(id => labelById[id]).filter(Boolean);
    const members = (c.idMembers || []).map(id => memberById[id]).filter(Boolean);
    const lastActivity = c.dateLastActivity;
    const comments = commentsByCard[c.id] || [];
    const lastComment = comments.length ? comments.reduce((a, b) => new Date(a.date) > new Date(b.date) ? a : b) : null;

    // Extract EPIC and tipo
    const epicMatch = c.name.match(/\[(\w+)\]/);
    const epic = epicMatch ? epicMatch[1] : 'OUTROS';
    const tipoMatch = c.name.match(/\b(Feat|Fix|Chore|Refactor|Perf|Bug|Docs)\b/i);
    const tipo = tipoMatch ? tipoMatch[1][0].toUpperCase() + tipoMatch[1].slice(1).toLowerCase() : 'Feat';

    // Priority from labels
    const priorityLabel = labels.find(l => /^\d /.test(l.name || ''));
    const priorityNum = priorityLabel ? parseInt(priorityLabel.name[0], 10) : 5;
    const priorityCode = priorityLabel ? `P${priorityNum - 1}` : 'P3';

    // Status
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
      list: list ? list.name : 'unknown',
      listClosed: list ? list.closed : false,
      cardClosed: c.closed,
      labels: labels.map(l => ({ name: l.name, color: l.color })),
      members: members.map(m => ({ id: m.id, name: m.fullName, username: m.username })),
      due: c.due,
      dueComplete: c.dueComplete,
      dateLastActivity: lastActivity,
      ageDays: ageDays(lastActivity),
      lastCommentDate: lastComment ? lastComment.date : null,
      lastCommentAge: lastComment ? ageDays(lastComment.date) : null,
      commentCount: comments.length,
      epic,
      tipo,
      priorityNum,
      priorityCode,
      status,
      pop: inferPOP(c, epic, tipo),
      dor: inferDOR(c, []),
      dod: inferDOD(c, list, []),
      invest: inferINVEST(c),
      idChecklists: c.idChecklists || [],
    };
  });

  // Stats
  const active = cards.filter(c => !c.cardClosed && !c.listClosed);
  const byList = {};
  for (const c of active) {
    byList[c.list] = (byList[c.list] || 0) + 1;
  }

  // Carga por dev (cards in progress + sandbox + blocked)
  const workingLists = ['In Progress (Max 2/dev)', 'Testing / Sandbox', 'Blocked'];
  const byDev = {};
  for (const c of active.filter(c => workingLists.includes(c.list))) {
    for (const m of c.members) {
      if (!byDev[m.name]) byDev[m.name] = { inProgress: [], sandbox: [], blocked: [] };
      const slot = c.list === 'In Progress (Max 2/dev)' ? 'inProgress'
        : c.list === 'Testing / Sandbox' ? 'sandbox'
        : 'blocked';
      byDev[m.name][slot].push({ idShort: c.idShort, name: c.name, url: c.url });
    }
  }

  // Alertas
  const alerts = [];

  // Cards In Progress parados >5d
  for (const c of active.filter(c => c.list === 'In Progress (Max 2/dev)')) {
    if (c.ageDays && c.ageDays > 5) {
      alerts.push({
        severity: c.ageDays > 14 ? 'critical' : 'warning',
        kind: 'stale_in_progress',
        text: `#${c.idShort} ${c.name} — In Progress há ${c.ageDays} dias`,
        cardId: c.id,
        idShort: c.idShort,
        url: c.url,
      });
    }
  }

  // Bloqueados sem comentário recente >7d
  for (const c of active.filter(c => c.list === 'Blocked')) {
    const ageBlock = c.lastCommentAge !== null ? c.lastCommentAge : c.ageDays;
    if (ageBlock !== null && ageBlock > 7) {
      alerts.push({
        severity: ageBlock > 30 ? 'critical' : 'warning',
        kind: 'silent_blocked',
        text: `#${c.idShort} ${c.name} — Bloqueado, sem update há ${ageBlock} dias`,
        cardId: c.id,
        idShort: c.idShort,
        url: c.url,
      });
    }
  }

  // Sandbox parado >7d
  for (const c of active.filter(c => c.list === 'Testing / Sandbox')) {
    if (c.ageDays && c.ageDays > 7) {
      alerts.push({
        severity: 'warning',
        kind: 'stuck_sandbox',
        text: `#${c.idShort} ${c.name} — Em Sandbox há ${c.ageDays} dias`,
        cardId: c.id,
        idShort: c.idShort,
        url: c.url,
      });
    }
  }

  // WIP excedido
  for (const [dev, work] of Object.entries(byDev)) {
    if (work.inProgress.length > 2) {
      alerts.push({
        severity: 'warning',
        kind: 'wip_exceeded',
        text: `${dev} tem ${work.inProgress.length} cards In Progress (limite 2)`,
      });
    }
  }

  // Cards sem assignee em In Progress
  for (const c of active.filter(c => c.list === 'In Progress (Max 2/dev)')) {
    if (c.members.length === 0) {
      alerts.push({
        severity: 'info',
        kind: 'no_assignee',
        text: `#${c.idShort} ${c.name} — In Progress sem assignee`,
        idShort: c.idShort,
        url: c.url,
      });
    }
  }

  // Sort alerts: critical > warning > info
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  // ═══════════ Lead time, velocity, roadmap (a partir das actions) ═══════════
  // Pra cada card, processar histórico de movimentação
  const cardHistory = {};
  for (const c of cards) cardHistory[c.id] = { moves: [], created: null };

  for (const a of (board.actions || [])) {
    if (a.type === 'createCard' && a.data && a.data.card) {
      const cid = a.data.card.id;
      if (cardHistory[cid]) cardHistory[cid].created = a.date;
    } else if (a.type === 'updateCard' && a.data && a.data.card && a.data.listAfter && a.data.listBefore) {
      const cid = a.data.card.id;
      if (cardHistory[cid]) {
        cardHistory[cid].moves.push({
          date: a.date,
          fromList: a.data.listBefore.name,
          toList: a.data.listAfter.name,
        });
      }
    }
  }

  // Lead time: tempo de createCard até entrar em Done
  const leadTimes = [];
  for (const c of cards) {
    const h = cardHistory[c.id];
    if (!h || !h.created) continue;
    const doneMove = h.moves.find(m => /done/i.test(m.toList));
    if (doneMove) {
      const days = (new Date(doneMove.date) - new Date(h.created)) / 86400000;
      leadTimes.push({ idShort: c.idShort, name: c.name, days: Math.round(days * 10) / 10, epic: c.epic });
    }
  }
  leadTimes.sort((a, b) => b.days - a.days);

  const avgLeadTime = leadTimes.length
    ? Math.round(leadTimes.reduce((s, l) => s + l.days, 0) / leadTimes.length * 10) / 10
    : 0;

  // Velocity: cards entrando em Done por semana (últimas 12 semanas)
  const weeksMap = {};
  const now = Date.now();
  const weeksBack = 12;
  for (let i = 0; i < weeksBack; i++) {
    const weekStart = new Date(now - (i + 1) * 7 * 86400000);
    const wkKey = weekStart.toISOString().slice(0, 10);
    weeksMap[wkKey] = 0;
  }
  for (const c of cards) {
    const h = cardHistory[c.id];
    if (!h) continue;
    const doneMove = h.moves.find(m => /done/i.test(m.toList));
    if (doneMove) {
      const moveDate = new Date(doneMove.date).getTime();
      const weeksAgo = Math.floor((now - moveDate) / (7 * 86400000));
      if (weeksAgo < weeksBack) {
        const weekStart = new Date(now - (weeksAgo + 1) * 7 * 86400000);
        const wkKey = weekStart.toISOString().slice(0, 10);
        weeksMap[wkKey] = (weeksMap[wkKey] || 0) + 1;
      }
    }
  }
  const velocity = Object.entries(weeksMap).sort((a, b) => a[0].localeCompare(b[0])).map(([week, count]) => ({ week, count }));
  const avgVelocity = velocity.length
    ? Math.round(velocity.reduce((s, v) => s + v.count, 0) / velocity.length * 10) / 10
    : 0;

  // Card flow: distribuição por idade (cards ativos)
  const ageBuckets = { '0-7d': 0, '7-14d': 0, '14-30d': 0, '30-60d': 0, '60d+': 0 };
  for (const c of active) {
    if (!c.ageDays) continue;
    if (c.ageDays <= 7) ageBuckets['0-7d']++;
    else if (c.ageDays <= 14) ageBuckets['7-14d']++;
    else if (c.ageDays <= 30) ageBuckets['14-30d']++;
    else if (c.ageDays <= 60) ageBuckets['30-60d']++;
    else ageBuckets['60d+']++;
  }

  // EPIC stats
  const epicStats = {};
  for (const epicKey of Object.keys(EPIC_META)) {
    epicStats[epicKey] = {
      ...EPIC_META[epicKey],
      key: epicKey,
      total: 0,
      done: 0,
      testing: 0,
      inProgress: 0,
      blocked: 0,
      todo: 0,
      backlog: 0,
      icebox: 0,
      pending: 0,
    };
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
  // Compute aggregate status per epic
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
    boardUrl: board.url || `https://trello.com/b/${board.shortLink}`,
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
    metrics: {
      leadTimes,
      avgLeadTime,
      velocity,
      avgVelocity,
      ageBuckets,
      cardHistory: Object.fromEntries(
        Object.entries(cardHistory).map(([id, h]) => [id, { created: h.created, moveCount: h.moves.length }])
      ),
    },
    epics: Object.values(epicStats).filter(e => e.total > 0).sort((a, b) => {
      const pOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
      return (pOrder[a.priority] - pOrder[b.priority]) || (b.total - a.total);
    }),
    members: board.members.map(m => ({ id: m.id, name: m.fullName, username: m.username })),
    labels: board.labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
    lists: board.lists.map(l => ({ id: l.id, name: l.name, closed: l.closed, pos: l.pos })),
  };
}

async function main() {
  const arg = process.argv[2];
  const skipGh = process.argv.includes('--no-gh');
  const forceFile = process.argv.includes('--file');
  const env = loadEnv();

  // Carrega config.json + popula EPIC_META / PERSONA_BY_EPIC
  const config = loadConfig();
  if (config) {
    if (config.epics) {
      EPIC_META = { ...EPIC_META, ...config.epics };
    }
    if (config.personasByEpic) {
      PERSONA_BY_EPIC = { ...PERSONA_BY_EPIC, ...config.personasByEpic };
    }
  }

  const boardId = env.TRELLO_BOARD_ID || (config && config.project && config.project.trelloBoardId);
  const useApi = !forceFile && env.TRELLO_KEY && env.TRELLO_TOKEN && boardId;

  let board;
  if (useApi) {
    console.log(`🔑 Usando Trello API (board: ${boardId})`);
    try {
      board = await fetchBoardFromAPI(env.TRELLO_KEY, env.TRELLO_TOKEN, boardId);
    } catch (e) {
      console.error(`❌ API falhou: ${e.message}`);
      console.log(`   Tentando fallback pra arquivo JSON local…`);
      const src = findSource(arg);
      console.log(`📂 Source: ${src}`);
      board = JSON.parse(fs.readFileSync(src, 'utf8'));
    }
  } else {
    const src = findSource(arg);
    console.log(`📂 Source: ${src}`);
    board = JSON.parse(fs.readFileSync(src, 'utf8'));
  }

  // Copia raw
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'board.json'), JSON.stringify(board), 'utf8');

  // Gera derived
  const derived = processBoard(board);
  fs.writeFileSync(path.join(DATA_DIR, 'derived.json'), JSON.stringify(derived, null, 2), 'utf8');

  console.log(`✅ Trello refreshed em ${new Date().toLocaleString('pt-BR')}`);
  console.log(`   ${derived.counts.totalCards} cards (${derived.counts.activeCards} ativos)`);
  console.log(`   ${derived.alerts.length} alertas`);
  for (const a of derived.alerts.slice(0, 5)) {
    const icon = { critical: '🚨', warning: '⚠️', info: 'ℹ️' }[a.severity];
    console.log(`     ${icon} ${a.text}`);
  }
  if (derived.alerts.length > 5) console.log(`     ... e mais ${derived.alerts.length - 5}`);

  // Sync com GitHub
  if (!skipGh) {
    console.log('');
    try {
      require('child_process').execSync(`node "${path.join(__dirname, 'gh-sync.js')}"`, {
        stdio: 'inherit',
      });
    } catch (e) {
      console.error('⚠️  gh-sync falhou (continua sem dados GitHub). Use --no-gh pra pular.');
    }
  }
}

main().catch(e => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});

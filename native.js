// ============================================================================
//  native.js — adapter do modelo próprio ⇄ app.js (modo nativo / Supabase)
//
//  O app.js inteiro renderiza a partir de `state.derived` (formato Trello) e
//  escreve via `trelloWrite(action, data)`. Em vez de reescrever 3900 linhas,
//  este adapter:
//    • LEITURA  → CCNative.loadDerived() monta `derived` no MESMO formato.
//    • ESCRITA  → CCNative.write(action, data) traduz cada ação pro Supabase
//                 e devolve o MESMO shape ({ ok, result }) que o app espera.
//    • Multi-projeto, branding, realtime e import do Trello.
//
//  Carregado como <script src="native.js"> (clássico) ANTES do app.js.
//  Sem build step — usa window.CC (definido em supabase.js / ESM).
// ============================================================================

const CCNative = (() => {
  const LS_PROJECT = 'cc_current_project';
  let project = null;        // projeto atual { id, slug, name, ... }
  let cache = { lists: [], members: [], labels: [], rawCards: [] };

  // EPIC_META default (mesmas chaves do snapshot p/ compatibilidade dos renderers)
  const DEFAULT_EPICS = {
    INFRA: { name: 'Infraestrutura, DevOps & Segurança', priority: 'P0', icon: '🛡️' },
    AUTH:  { name: 'Autenticação & Autorização',         priority: 'P0', icon: '🔐' },
    API:   { name: 'Backend / API',                       priority: 'P0', icon: '⚙️' },
    UI:    { name: 'Frontend / UX',                        priority: 'P1', icon: '🎨' },
    FEATURE:{ name: 'Features de produto',                 priority: 'P1', icon: '✨' },
    BUG:   { name: 'Bugs',                                 priority: 'P0', icon: '🐞' },
    PERF:  { name: 'Performance',                          priority: 'P2', icon: '⚡' },
    DOCS:  { name: 'Documentação',                         priority: 'P3', icon: '📚' },
    TEST:  { name: 'Testes / QA',                          priority: 'P2', icon: '🧪' },
    OUTROS:{ name: 'Outros',                               priority: 'P3', icon: '📦' },
  };

  function epicMeta() {
    const fromCfg = (window.CONFIG && window.CONFIG.epics) || (project && project.settings && project.settings.epics);
    return Object.assign({}, DEFAULT_EPICS, fromCfg || {});
  }

  const ageDays = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

  function statusFromList(listName) {
    const n = listName || '';
    if (/done/i.test(n)) return 'done';
    if (/sandbox|testing/i.test(n)) return 'testing';
    if (/in progress/i.test(n)) return 'in_progress';
    if (/blocked/i.test(n)) return 'blocked';
    if (/icebox/i.test(n)) return 'icebox';
    if (/to-?do/i.test(n)) return 'todo';
    if (/backlog/i.test(n)) return 'backlog';
    return 'pending';
  }

  // ---- LEITURA: monta `derived` no formato Trello a partir do modelo nativo
  async function loadDerived() {
    const pid = project.id;
    const [lists, members, labels, rawCards] = await Promise.all([
      CC.lists.byProject(pid),
      CC.members.byProject(pid),
      CC.labels.byProject(pid),
      CC.cards.byProject(pid, { includeArchived: true }),
    ]);
    cache = { lists, members, labels, rawCards };

    const listById = Object.fromEntries(lists.map(l => [l.id, l]));
    const memById = Object.fromEntries(members.map(m => [m.id, m]));
    const lblById = Object.fromEntries(labels.map(l => [l.id, l]));
    const EPIC_META = epicMeta();
    const pOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };

    const cards = rawCards.map(c => {
      const list = listById[c.list_id];
      const listName = list ? list.name : '';
      const cardLabels = (c.card_labels || []).map(x => lblById[x.label_id]).filter(Boolean);
      const cardMembers = (c.card_members || []).map(x => memById[x.member_id]).filter(Boolean);
      const epic = c.epic || (c.title.match(/\[(\w+)\]/) || [])[1] || 'OUTROS';
      const priorityCode = c.priority || 'P3';
      const priorityNum = (pOrder[priorityCode] ?? 3) + 1;
      return {
        id: c.id,
        idShort: c.seq != null ? c.seq : 0,
        name: c.title,
        desc: c.body || '',
        url: c.external_url || '#',
        list: listName,
        listClosed: false,
        cardClosed: !!c.archived,
        labels: cardLabels.map(l => ({ id: l.id, name: l.name, color: l.color })),
        members: cardMembers.map(m => ({ id: m.id, name: m.name, username: m.github_login || m.trello_name || '' })),
        due: c.due_at,
        dueComplete: !!(c.fields && c.fields.dueComplete),
        dateLastActivity: c.updated_at,
        ageDays: ageDays(c.updated_at),
        lastCommentDate: null, lastCommentAge: null, commentCount: 0,
        epic,
        tipo: (c.fields && c.fields.tipo) || 'Feat',
        priorityNum, priorityCode,
        status: statusFromList(listName),
        pop: null, dor: null, dod: null, invest: null,
        idChecklists: [],
        cover: c.cover || null,
        attachments: [],
        badges: {},
        _deps: (c.fields && c.fields.depsCount) || 0,
      };
    });

    const active = cards.filter(c => !c.cardClosed);
    const byList = {};
    for (const c of active) byList[c.list] = (byList[c.list] || 0) + 1;

    // byDev (mesmas listas de trabalho do snapshot)
    const workingLists = ['In Progress (Max 2/dev)', 'Testing / Sandbox', 'Blocked'];
    const byDev = {};
    for (const c of active.filter(c => workingLists.includes(c.list))) {
      for (const m of c.members) {
        if (!byDev[m.name]) byDev[m.name] = { inProgress: [], sandbox: [], blocked: [] };
        const slot = c.list === 'In Progress (Max 2/dev)' ? 'inProgress'
                   : c.list === 'Testing / Sandbox' ? 'sandbox' : 'blocked';
        byDev[m.name][slot].push({ idShort: c.idShort, name: c.name, url: c.url });
      }
    }

    // alerts essenciais
    const alerts = [];
    for (const c of active.filter(c => c.list === 'In Progress (Max 2/dev)' && c.ageDays > 5)) {
      alerts.push({ severity: c.ageDays > 14 ? 'critical' : 'warning', kind: 'stale_in_progress',
        text: `#${c.idShort} ${c.name} — In Progress há ${c.ageDays} dias`, cardId: c.id, idShort: c.idShort, url: c.url });
    }
    for (const c of active.filter(c => c.list === 'Blocked' && c.ageDays > 7)) {
      alerts.push({ severity: c.ageDays > 30 ? 'critical' : 'warning', kind: 'silent_blocked',
        text: `#${c.idShort} ${c.name} — Bloqueado, sem update há ${c.ageDays} dias`, cardId: c.id, idShort: c.idShort, url: c.url });
    }
    // WIP limit (diferencial nativo): alerta quando coluna passa do wip_limit
    for (const l of lists.filter(l => l.wip_limit)) {
      const count = byList[l.name] || 0;
      if (count > l.wip_limit) alerts.push({ severity: 'warning', kind: 'wip_exceeded',
        text: `Coluna "${l.name}" com ${count} cards (limite WIP ${l.wip_limit})` });
    }

    // EPIC stats
    const epicStats = {};
    for (const k of Object.keys(EPIC_META)) epicStats[k] = mkEpic(EPIC_META[k], k);
    for (const c of cards) {
      if (!epicStats[c.epic]) epicStats[c.epic] = mkEpic(EPIC_META.OUTROS, c.epic);
      const s = epicStats[c.epic]; s.total++;
      const map = { done: 'done', testing: 'testing', in_progress: 'inProgress', blocked: 'blocked', todo: 'todo', backlog: 'backlog', icebox: 'icebox' };
      s[map[c.status] || 'pending']++;
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
      boardName: project.name,
      boardUrl: '#/kanban',
      refreshedAt: new Date().toISOString(),
      counts: {
        totalCards: cards.length, activeCards: active.length, archivedCards: cards.length - active.length,
        byList, members: members.length, labels: labels.length,
      },
      alerts, byDev, cards,
      epics: Object.values(epicStats).filter(e => e.total > 0)
        .sort((a, b) => (pOrder[a.priority] - pOrder[b.priority]) || (b.total - a.total)),
      members: members.map(m => ({ id: m.id, name: m.name, username: m.github_login || m.trello_name || '' })),
      labels: labels.map(l => ({ id: l.id, name: l.name, color: l.color })),
      lists: lists.map(l => ({ id: l.id, name: l.name, closed: false, pos: l.position, wipLimit: l.wip_limit, isDone: l.is_done })),
      metrics: { leadTimes: [], avgLeadTime: 0, velocity: [], avgVelocity: 0, ageBuckets: {}, cardHistory: {} },
      _native: true,
    };
  }

  const mkEpic = (meta, key) => ({ ...meta, key, total: 0, done: 0, testing: 0, inProgress: 0,
    blocked: 0, todo: 0, backlog: 0, icebox: 0, pending: 0 });

  // posição pra anexar no fim de uma lista
  function nextPos(listId) {
    const inList = cache.rawCards.filter(c => c.list_id === listId);
    return inList.length ? Math.max(...inList.map(c => c.position || 0)) + 1000 : 1000;
  }
  function nextSeq() {
    return (cache.rawCards.reduce((m, c) => Math.max(m, c.seq || 0), 0)) + 1;
  }

  // ---- ESCRITA: traduz ações do trelloWrite → Supabase, devolve { ok, result }
  async function write(action, d = {}) {
    const R = (result) => ({ ok: true, result });
    switch (action) {
      case 'createCard': {
        const seq = nextSeq();
        const card = await CC.cards.create({
          project_id: project.id, list_id: d.idList, title: d.name,
          body: d.desc || '', position: nextPos(d.idList), seq,
        });
        for (const mid of (d.idMembers || [])) await CC.assign(card.id, mid);
        for (const lid of (d.idLabels || [])) await CC.addLabel(card.id, lid);
        return R({ id: card.id, idShort: seq, name: card.title });
      }
      case 'moveCard':
        return R(await CC.cards.move(d.id, d.idList, nextPos(d.idList)));
      case 'updateCard': {
        const patch = {};
        if (d.name != null) patch.title = d.name;
        if (d.desc != null) patch.body = d.desc;
        return R(await CC.cards.update(d.id, patch));
      }
      case 'archiveCard': await CC.cards.archive(d.id); return R(true);
      case 'deleteCard':  await CC.cards.remove(d.id);  return R(true);
      case 'addMember':   await CC.assign(d.id, d.idMember);   return R(true);
      case 'removeMember':await CC.unassign(d.id, d.idMember); return R(true);
      case 'addLabel':    await CC.addLabel(d.id, d.idLabel);  return R(true);
      case 'removeLabel': if (d.idLabel) await CC.removeLabel(d.id, d.idLabel); return R(true);
      case 'setDue': {
        const card = cache.rawCards.find(c => c.id === d.id);
        const fields = Object.assign({}, card && card.fields, { dueComplete: !!d.dueComplete });
        return R(await CC.cards.update(d.id, { due_at: d.due || null, fields }));
      }
      case 'createList':
        return R(await CC.lists.create({ project_id: project.id, name: d.name,
          position: (cache.lists.reduce((m, l) => Math.max(m, l.position || 0), 0)) + 1000 }));
      case 'renameList':  return R(await CC.lists.update(d.id, { name: d.name }));
      case 'archiveList': await CC.lists.remove(d.id); return R(true);

      // ---- checklists ----
      case 'getChecklists': {
        const cls = await CC.checklists.byCard(d.id);
        return R(cls.map(cl => ({
          id: cl.id, name: cl.title,
          checkItems: (cl.checklist_items || []).map(i => ({ id: i.id, name: i.text, state: i.done ? 'complete' : 'incomplete', pos: i.position })),
        })));
      }
      case 'createChecklist': {
        const cl = await CC.checklists.create({ card_id: d.idCard, title: d.name });
        return R({ id: cl.id });
      }
      case 'deleteChecklist': await CC.checklists.remove(d.id); return R(true);
      case 'addCheckItem': {
        const it = await CC.checklists.addItem({ checklist_id: d.idChecklist, text: d.name });
        return R({ id: it.id });
      }
      case 'toggleCheckItem': await CC.checklists.toggleItem(d.idCheckItem, d.state === 'complete'); return R(true);
      case 'deleteCheckItem': await CC.checklists.removeItem(d.idCheckItem); return R(true);

      // ---- comentários ----
      case 'getComments': {
        const cos = await CC.comments.byCard(d.id);
        return R(cos.map(co => ({ id: co.id, date: co.created_at,
          memberCreator: { fullName: co.author_name || '—' }, data: { text: co.body } })));
      }
      case 'comment': {
        const u = window.getCurrentUser ? window.getCurrentUser() : null;
        return R(await CC.comments.add({ card_id: d.id, body: d.text, author_name: u ? u.name : 'Anônimo' }));
      }

      // ---- anexos ----
      case 'getAttachments': {
        const ats = await CC.attachments.byCard(d.id);
        return R(ats.map(a => ({ id: a.id, name: a.name, url: a.url })));
      }
      case 'addAttachment':   return R(await CC.attachments.add({ card_id: d.idCard, url: d.url, name: d.name || null }));
      case 'removeAttachment':await CC.attachments.remove(d.idAttachment); return R(true);
      case 'setCover': {
        const url = d.url || (await CC.attachments.byCard(d.idCard)).find(a => a.id === d.idAttachment)?.url;
        return R(await CC.cards.update(d.idCard, { cover: url || null }));
      }
      default:
        console.warn('[CCNative] ação não mapeada:', action, d);
        return R(null);
    }
  }

  // ---- IMPORTADOR: Trello (snapshot atual) → cards nativos ------------------
  async function importFromTrello(onProgress = () => {}) {
    onProgress('Lendo board do Trello…');
    let snap = null;
    try {
      const r = await fetch('/.netlify/functions/trello-snapshot?_=' + Date.now());
      if (r.ok) snap = await r.json();
    } catch {}
    if (!snap) {
      const r = await fetch('data/derived.json?_=' + Date.now());
      if (!r.ok) throw new Error('Sem trello-snapshot nem data/derived.json pra importar.');
      snap = await r.json();
    }

    // 1) listas (preserva ordem)
    onProgress('Criando colunas…');
    const listMap = {}; // nome → id nativo
    let pos = 1000;
    for (const l of (snap.lists || []).filter(l => !l.closed)) {
      const nl = await CC.lists.create({ project_id: project.id, name: l.name, position: pos, is_done: /done/i.test(l.name) });
      listMap[l.name] = nl.id; pos += 1000;
    }

    // 2) membros
    onProgress('Criando membros…');
    const memMap = {}; // username/name → id nativo
    for (const m of (snap.members || [])) {
      const nm = await CC.members.create({ project_id: project.id, name: m.name || m.username,
        github_login: null, trello_name: m.name || m.username, emoji: '👤' });
      memMap[m.name] = nm.id; if (m.username) memMap[m.username] = nm.id;
    }

    // 3) labels
    onProgress('Criando labels…');
    const lblMap = {};
    for (const lb of (snap.labels || []).filter(l => l.name)) {
      const nl = await CC.labels.create({ project_id: project.id, name: lb.name, color: lb.color });
      lblMap[lb.name] = nl.id;
    }

    // 4) cards (preserva idShort em seq) — em lotes p/ não estourar
    onProgress(`Importando ${snap.cards.length} cards…`);
    for (const c of snap.cards) {
      if (c.cardClosed || c.listClosed) continue;
      const card = await CC.cards.create({
        project_id: project.id, list_id: listMap[c.list] || null, seq: c.idShort,
        title: c.name, body: c.desc || '', position: 1000 + (c.idShort || 0),
        epic: c.epic || null, priority: c.priorityCode || null,
        due_at: c.due || null, cover: c.cover && c.cover.idAttachment ? null : null,
        fields: { tipo: c.tipo, dueComplete: !!c.dueComplete },
        external_kind: 'trello_card', external_id: String(c.id), external_url: c.url,
      });
      for (const m of (c.members || [])) { const mid = memMap[m.name] || memMap[m.username]; if (mid) await CC.assign(card.id, mid); }
      for (const lb of (c.labels || [])) { const lid = lblMap[lb.name]; if (lid) await CC.addLabel(card.id, lid); }
    }
    onProgress('✅ Importação concluída!');
  }

  // ---- MULTI-PROJETO: branding + seletor no sidebar ------------------------
  function applyBranding() {
    if (!project) return;
    document.title = `${project.name} — ${project.tagline || 'Command Center'}`;
    const t = document.querySelector('.brand-title'); if (t) t.textContent = project.name;
    const sub = document.querySelector('.brand-subtitle'); if (sub) sub.textContent = project.tagline || 'Command Center';
    const ic = document.querySelector('.brand-icon'); if (ic && project.icon) ic.textContent = project.icon;
  }

  async function mountProjectSwitcher() {
    const brand = document.querySelector('.brand');
    if (!brand || document.getElementById('cc-project-switcher')) return;
    const projects = await CC.projects.list();
    const wrap = document.createElement('div');
    wrap.id = 'cc-project-switcher';
    wrap.className = 'cc-proj-switcher';
    wrap.innerHTML = `
      <select id="cc-proj-select" title="Trocar de projeto">
        ${projects.map(p => `<option value="${p.id}" ${project && p.id === project.id ? 'selected' : ''}>${p.icon || '🎯'} ${escapeHtmlSafe(p.name)}</option>`).join('')}
      </select>
      <button id="cc-proj-new" title="Novo projeto">＋</button>
      <button id="cc-proj-import" title="Importar board do Trello pra este projeto">⬇️ Trello</button>`;
    brand.insertAdjacentElement('afterend', wrap);
    document.getElementById('cc-proj-select').onchange = (e) => switchProject(e.target.value);
    document.getElementById('cc-proj-new').onclick = createProjectFlow;
    document.getElementById('cc-proj-import').onclick = importFlow;
  }

  async function importFlow() {
    const toast = window.showToast || ((m) => console.log(m));
    if (cache.rawCards.length && !confirm(`O projeto "${project.name}" já tem ${cache.rawCards.length} cards. Importar mesmo assim pode duplicar. Continuar?`)) return;
    if (!cache.rawCards.length && !confirm(`Importar o board do Trello pra dentro de "${project.name}"?`)) return;
    try {
      await importFromTrello((msg) => toast(msg, 'info'));
      toast('✅ Importado! Recarregando…', 'success');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      toast('Erro na importação: ' + e.message, 'error');
    }
  }

  const escapeHtmlSafe = (s) => String(s || '').replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  async function switchProject(id) {
    localStorage.setItem(LS_PROJECT, id);
    location.hash = '#/overview';
    location.reload();
  }

  async function createProjectFlow() {
    const name = prompt('Nome do novo projeto:');
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6);
    const p = await CC.projects.create({ slug, name, tagline: 'Command Center', icon: '🎯' });
    await switchProject(p.id);
  }

  // ---- BOOT ----------------------------------------------------------------
  async function boot() {
    // supabase.js é módulo (deferred) e pode rodar DEPOIS deste script clássico —
    // espera __ccReady aparecer antes de awaitar.
    let guard = 0;
    while (!window.__ccReady && guard++ < 250) await new Promise(r => setTimeout(r, 20));
    await window.__ccReady;
    if (!window.CC || !CC.configured) return; // não-configurado → app cai no Trello
    let projects = [];
    try { projects = await CC.projects.list(); } catch (e) { console.error('[CCNative] erro listando projetos', e); return; }

    const wanted = localStorage.getItem(LS_PROJECT);
    project = projects.find(p => p.id === wanted) || projects[0] || null;

    if (project) { applyBranding(); mountProjectSwitcher(); }
  }

  const ready = boot();

  // realtime: reload debounced em qualquer mudança do projeto
  function subscribe(reload) {
    if (!isNative()) return;
    let t = null;
    CC.subscribe(project.id, () => { clearTimeout(t); t = setTimeout(reload, 400); });
  }

  function isNative() { return !!(window.CC && CC.configured && project); }

  return {
    ready, isNative, loadDerived, write, importFromTrello, subscribe,
    mountProjectSwitcher, createProjectFlow,
    get project() { return project; },
    get cache() { return cache; },
    hasCards: () => cache.rawCards.length > 0,
  };
})();

window.CCNative = CCNative;

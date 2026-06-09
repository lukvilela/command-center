// ============================================================================
//  automations.js — window.CCAutomations
//
//  Regras de automação por workspace + enforcement de WIP, guardadas em
//  CCNative.project.settings.automations. É o diferencial que faz largar o
//  Jira: mover card pra "Done" fecha/mergeia a issue/PR linkada (de graça),
//  e limites de WIP são realmente bloqueados na hora do drag.
//
//  Carregado como <script src="automations.js"> (clássico) DEPOIS de
//  connectors.js e ANTES (ou junto) do app.js. Sem build, sem npm.
//  Tudo defensivo: se não está em modo nativo / sem Connectors → no-op seguro.
//
//  WIRING (não editamos os arquivos do core — ver instruções no fim do PR):
//    1. index.html: <script src="automations.js"></script> após connectors.js
//    2. native.js write() case 'moveCard': chamar onBeforeMove antes / onAfterMove depois
//    3. boot: CCAutomations.initCommandPalette()
// ============================================================================

const CCAutomations = (() => {
  'use strict';

  // ---- helpers defensivos --------------------------------------------------
  const toast = (msg, type) => {
    try { if (window.showToast) return window.showToast(msg, type); } catch (_) {}
    try { console.log('[CCAutomations]', type || 'info', msg); } catch (_) {}
  };
  const isNative = () => {
    try { return !!(window.CCNative && CCNative.isNative && CCNative.isNative()); } catch (_) { return false; }
  };
  const connectors = () => (window.Connectors || null);

  // ---- defaults + metadata -------------------------------------------------
  const DEFAULTS = Object.freeze({
    closeOnDone: true,    // mover p/ coluna is_done fecha a issue / mergeia o PR linkado
    commentOnDone: false, // comenta na issue/PR ao concluir (auditoria)
    wipEnforce: false,    // bloqueia drop quando a coluna destino atinge o wip_limit
  });

  // descritor pra outra pessoa renderizar os toggles na tela de Configurações
  const RULES_META = [
    { key: 'closeOnDone',   label: 'Fechar ao concluir',   desc: 'Mover um card pra uma coluna "Done" fecha a issue ou mergeia/fecha o PR vinculado no GitHub/GitLab.' },
    { key: 'commentOnDone', label: 'Comentar ao concluir', desc: 'Posta um comentário automático na issue/PR vinculada quando o card é concluído (trilha de auditoria).' },
    { key: 'wipEnforce',    label: 'Forçar limite de WIP',  desc: 'Bloqueia soltar um card numa coluna que já atingiu o limite de WIP configurado (não só alerta).' },
  ];

  // ---- regras --------------------------------------------------------------
  function getRules() {
    let stored = null;
    try {
      stored = isNative() && CCNative.project && CCNative.project.settings
        ? CCNative.project.settings.automations : null;
    } catch (_) { stored = null; }
    return Object.assign({}, DEFAULTS, stored || {});
  }

  // ---- resolução de coluna destino / contagem WIP --------------------------
  // toList pode vir como objeto de lista nativo {id,name,wip_limit,is_done} OU
  // como o shape "derived" {id,name,wipLimit,isDone}. Normalizamos os dois.
  function listWipLimit(toList) {
    if (!toList) return null;
    const v = (toList.wip_limit != null) ? toList.wip_limit : toList.wipLimit;
    return (typeof v === 'number' && v > 0) ? v : null;
  }
  function listIsDone(toList) {
    if (!toList) return false;
    return !!(toList.is_done != null ? toList.is_done : toList.isDone);
  }
  function listId(toList) { return toList ? toList.id : null; }

  // conta cards não-arquivados já presentes na coluna destino (a partir do
  // modelo nativo cru — fonte da verdade pré-move)
  function countInList(lid) {
    if (!lid) return 0;
    try {
      const raw = (isNative() && CCNative.cache && CCNative.cache.rawCards) || [];
      return raw.filter(c => c && c.list_id === lid && !c.archived).length;
    } catch (_) { return 0; }
  }

  /**
   * onBeforeMove(card, toList) → { allow, reason }
   * Se wipEnforce ligado e a coluna destino tem wip_limit e já está cheia
   * (>= limite), bloqueia. O caller mostra o toast e aborta o move.
   */
  function onBeforeMove(card, toList) {
    try {
      const rules = getRules();
      if (!rules.wipEnforce) return { allow: true, reason: null };
      const limit = listWipLimit(toList);
      if (!limit) return { allow: true, reason: null };

      const lid = listId(toList);
      // não conta o próprio card se ele já estiver na coluna (re-ordenação)
      const already = countInList(lid);
      const cardInDest = (() => {
        try {
          const raw = (CCNative.cache && CCNative.cache.rawCards) || [];
          const me = raw.find(c => c && c.id === (card && card.id));
          return !!(me && me.list_id === lid && !me.archived);
        } catch (_) { return false; }
      })();
      const effective = cardInDest ? already - 1 : already;

      if (effective >= limit) {
        const name = (toList && toList.name) || 'coluna';
        return {
          allow: false,
          reason: `Limite de WIP atingido: "${name}" já tem ${effective} card(s) (máx. ${limit}). Termine ou mova algo antes.`,
        };
      }
      return { allow: true, reason: null };
    } catch (e) {
      // em caso de erro, NUNCA bloqueia o usuário (falha aberta)
      try { console.warn('[CCAutomations] onBeforeMove erro', e); } catch (_) {}
      return { allow: true, reason: null };
    }
  }

  // ---- resolução de repo + número do item externo --------------------------
  // Tenta de várias fontes: card.external_raw, campos do card, e a source.
  function resolveRepo(card, raw, source) {
    // 1) source.config.repo é o caminho mais confiável (owner/name)
    if (source && source.config && source.config.repo) return source.config.repo;
    // 2) raw pode trazer repo curto ou full
    const cand = (raw && (raw.repo || raw.repository)) ||
                 (card && (card.repo || card.repository)) || null;
    if (cand && String(cand).includes('/')) return cand;
    // 3) tenta a partir da URL do GitHub: github.com/owner/name/...
    const url = (raw && raw.url) || (card && (card.external_url || card.url)) || '';
    const m = String(url).match(/github\.com\/([^/]+\/[^/]+?)(?:\/|$)/i);
    if (m) return m[1];
    // 4) repo curto via overlay state.github (resolve full)
    if (cand && window.getRepoFull) {
      try { const full = window.getRepoFull(cand); if (full && full.includes('/')) return full; } catch (_) {}
    }
    return cand || null;
  }

  function resolveNumber(card, raw) {
    const n = (raw && (raw.number != null ? raw.number : raw.iid)) ??
              (card && (card.external_id != null ? card.external_id : card.seq));
    const num = parseInt(n, 10);
    return Number.isFinite(num) ? num : null;
  }

  // estado atual do item (pra idempotência) — 'open' | 'closed' | 'merged'
  function externalState(raw) {
    if (!raw) return null;
    if (raw.mergedAt || raw.merged_at || raw.merged) return 'merged';
    const s = String(raw.state || '').toLowerCase();
    if (s === 'closed' || s === 'merged') return s;
    if (s === 'open' || s === 'opened') return 'open';
    return null;
  }

  // pega o registro cru do card no cache nativo (tem source_id/external_kind)
  function rawCardFor(card) {
    try {
      const raw = (CCNative.cache && CCNative.cache.rawCards) || [];
      return raw.find(c => c && c.id === (card && card.id)) || null;
    } catch (_) { return null; }
  }

  async function sourceFor(rawCard) {
    if (!rawCard || !rawCard.source_id) return null;
    try {
      if (!window.CC || !CC.sources) return null;
      const srcs = await CC.sources.byProject(CCNative.project.id);
      return srcs.find(s => s.id === rawCard.source_id) || null;
    } catch (_) { return null; }
  }

  /**
   * onAfterMove(card, toList) — chamado DEPOIS do move ter dado certo.
   * Se closeOnDone e a coluna destino é is_done e o card é um item externo
   * GitHub/GitLab resolvível, fecha/mergeia (idempotente). GitLab = best-effort.
   */
  async function onAfterMove(card, toList) {
    try {
      const rules = getRules();
      if (!rules.closeOnDone) return;
      if (!listIsDone(toList)) return;
      if (!isNative()) return;

      const rawCard = rawCardFor(card) || {};
      const kind = rawCard.external_kind || (card && card.external_kind);
      if (!kind) return; // card "normal", nada a fechar

      const isGitHub = kind === 'github_issue' || kind === 'github_pr';
      const isGitLab = kind === 'gitlab_issue' || kind === 'gitlab_mr';
      if (!isGitHub && !isGitLab) return;

      const ext = rawCard.external_raw || (card && card.external_raw) || null;

      // idempotência: se já está fechado/mergeado, não faz nada
      const st = externalState(ext);
      if (st === 'closed' || st === 'merged') return;

      const source = await sourceFor(rawCard);
      const repo = resolveRepo(card, ext, source);
      const number = resolveNumber(card, ext);
      if (!repo || number == null) {
        try { console.warn('[CCAutomations] não resolvi repo/number do card', card && card.id); } catch (_) {}
        return;
      }

      // ---- GitLab: best-effort. Sem helper de write → no-op silencioso. ----
      if (isGitLab) {
        const C = connectors();
        if (!C || typeof C.glWrite !== 'function') return; // helper ausente → no-op
        try {
          const token = (typeof C.tokenForRepo === 'function') ? await C.tokenForRepo(repo) : null;
          if (!token) return;
          const action = kind === 'gitlab_mr' ? 'mergeMR' : 'closeIssue';
          await C.glWrite(action, { repo, number }, token);
          toast(`✅ Automação: ${kind === 'gitlab_mr' ? 'MR' : 'issue'} ${repo}#${number} concluído no GitLab`, 'success');
        } catch (e) {
          toast(`⚠️ Automação GitLab falhou (${repo}#${number}): ${e.message}`, 'error');
        }
        return;
      }

      // ---- GitHub --------------------------------------------------------
      const C = connectors();
      if (!C || typeof C.ghWrite !== 'function') return;
      const token = (typeof C.tokenForRepo === 'function') ? await C.tokenForRepo(repo) : null;
      if (!token) {
        toast(`ℹ️ Card concluído, mas sem API key pra fechar ${repo}#${number}. Cole o token em 🔌 Fontes.`, 'info');
        return;
      }

      try {
        // comentário opcional ANTES de fechar (some no histórico se feito depois)
        if (rules.commentOnDone) {
          const isPR = kind === 'github_pr';
          try {
            await C.ghWrite(isPR ? 'commentPR' : 'commentIssue',
              { repo, number, body: '✅ Concluído via Command Center (card movido para Done).' }, token);
          } catch (_) { /* comentário é acessório, não-fatal */ }
        }

        if (kind === 'github_pr') {
          // tenta mergear; se não der (conflito/checks), fecha — sempre idempotente
          try {
            await C.ghWrite('mergePR', { repo, number, method: 'merge' }, token);
            toast(`✅ Automação: PR ${repo}#${number} mergeado`, 'success');
          } catch (mergeErr) {
            await C.ghWrite('closePR', { repo, number }, token);
            toast(`✅ Automação: PR ${repo}#${number} fechado (merge indisponível: ${mergeErr.message})`, 'success');
          }
        } else {
          await C.ghWrite('closeIssue', { repo, number }, token);
          toast(`✅ Automação: issue ${repo}#${number} fechada no GitHub`, 'success');
        }
      } catch (e) {
        toast(`⚠️ Automação falhou ao concluir ${repo}#${number}: ${e.message}`, 'error');
      }
    } catch (e) {
      try { console.warn('[CCAutomations] onAfterMove erro', e); } catch (_) {}
    }
  }

  // ==========================================================================
  //  COMMAND PALETTE (Ctrl+K) — opcional, self-contained.
  //  Pula rotas e busca cards por título. Lê de window.state.derived se houver,
  //  senão cai pro CCNative.cache. Injeta um overlay próprio (nada do core).
  // ==========================================================================
  let _paletteWired = false;

  function paletteRoutes() {
    // descobre rotas do próprio menu (data-route) — robusto a mudanças de nav
    const out = [];
    try {
      document.querySelectorAll('.nav-item[data-route]').forEach(el => {
        const route = el.dataset.route;
        const label = (el.textContent || route).trim().replace(/\s+/g, ' ');
        if (route) out.push({ type: 'route', route, label });
      });
    } catch (_) {}
    if (!out.length) {
      ['overview', 'epics', 'kanban', 'roadmap', 'cards', 'devs', 'github', 'timeline', 'notes', 'report', 'docs']
        .forEach(r => out.push({ type: 'route', route: r, label: r }));
    }
    return out;
  }

  function paletteCards() {
    try {
      const d = window.state && window.state.derived;
      if (d && Array.isArray(d.cards)) {
        return d.cards.filter(c => !c.cardClosed).map(c => ({
          type: 'card', id: c.id, idShort: c.idShort, label: c.name, sub: c.list, url: c.url,
        }));
      }
    } catch (_) {}
    try {
      const raw = (CCNative.cache && CCNative.cache.rawCards) || [];
      const lists = (CCNative.cache && CCNative.cache.lists) || [];
      const byId = {}; lists.forEach(l => byId[l.id] = l.name);
      return raw.filter(c => !c.archived).map(c => ({
        type: 'card', id: c.id, idShort: c.seq, label: c.title, sub: byId[c.list_id] || '', url: c.external_url || '#',
      }));
    } catch (_) { return []; }
  }

  function buildPalette() {
    let overlay = document.getElementById('cc-cmdk-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'cc-cmdk-overlay';
    overlay.className = 'cc-cmdk-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML =
      '<div class="cc-cmdk" role="dialog" aria-modal="true" aria-label="Command palette">' +
      '  <input id="cc-cmdk-input" type="text" placeholder="Ir para… ou buscar cards (Esc fecha)" autocomplete="off" spellcheck="false">' +
      '  <div id="cc-cmdk-results" class="cc-cmdk-results"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
    return overlay;
  }

  let _items = [];
  let _filtered = [];
  let _sel = 0;

  function renderResults() {
    const box = document.getElementById('cc-cmdk-results');
    if (!box) return;
    if (!_filtered.length) { box.innerHTML = '<div class="cc-cmdk-empty">Nada encontrado.</div>'; return; }
    box.innerHTML = _filtered.slice(0, 40).map((it, i) => {
      const icon = it.type === 'route' ? '➜' : '🃏';
      const num = it.type === 'card' && it.idShort != null ? `<span class="cc-cmdk-num">#${it.idShort}</span>` : '';
      const sub = it.sub ? `<small class="cc-cmdk-sub">${esc(it.sub)}</small>` : '';
      return `<div class="cc-cmdk-row ${i === _sel ? 'sel' : ''}" data-i="${i}">
        <span class="cc-cmdk-ico">${icon}</span>${num}
        <span class="cc-cmdk-lbl">${esc(it.label)}</span>${sub}</div>`;
    }).join('');
    box.querySelectorAll('.cc-cmdk-row').forEach(row => {
      row.addEventListener('mousemove', () => { _sel = +row.dataset.i; highlight(); });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); _sel = +row.dataset.i; activate(); });
    });
  }

  function highlight() {
    const box = document.getElementById('cc-cmdk-results');
    if (!box) return;
    box.querySelectorAll('.cc-cmdk-row').forEach(r => r.classList.toggle('sel', +r.dataset.i === _sel));
    const cur = box.querySelector('.cc-cmdk-row.sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function filter(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) {
      _filtered = _items.filter(it => it.type === 'route');
    } else {
      _filtered = _items.filter(it => {
        const hay = (it.label + ' ' + (it.sub || '') + ' ' + (it.idShort != null ? '#' + it.idShort : '')).toLowerCase();
        return hay.includes(q);
      });
    }
    _sel = 0;
    renderResults();
  }

  function activate() {
    const it = _filtered[_sel];
    if (!it) return;
    if (it.type === 'route') {
      location.hash = '#/' + it.route;
      closePalette();
    } else {
      // tenta abrir o modal de card do app; senão navega pra busca
      closePalette();
      if (window.openCardModal) { try { return window.openCardModal(it.id); } catch (_) {} }
      location.hash = '#/cards';
    }
  }

  function openPalette() {
    const overlay = buildPalette();
    _items = paletteRoutes().concat(paletteCards());
    overlay.style.display = 'flex';
    const input = document.getElementById('cc-cmdk-input');
    if (input) { input.value = ''; input.focus(); }
    filter('');
  }

  function closePalette() {
    const overlay = document.getElementById('cc-cmdk-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function isOpen() {
    const overlay = document.getElementById('cc-cmdk-overlay');
    return !!(overlay && overlay.style.display !== 'none');
  }

  function initCommandPalette() {
    if (_paletteWired) return;
    _paletteWired = true;
    document.addEventListener('keydown', (e) => {
      const k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault();
        isOpen() ? closePalette() : openPalette();
        return;
      }
      if (!isOpen()) return;
      if (k === 'escape') { e.preventDefault(); closePalette(); }
      else if (k === 'arrowdown') { e.preventDefault(); _sel = Math.min(_sel + 1, Math.max(_filtered.length - 1, 0)); highlight(); }
      else if (k === 'arrowup') { e.preventDefault(); _sel = Math.max(_sel - 1, 0); highlight(); }
      else if (k === 'enter') { e.preventDefault(); activate(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'cc-cmdk-input') filter(e.target.value);
    });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  return {
    getRules,
    onBeforeMove,
    onAfterMove,
    initCommandPalette,
    RULES_META,
    DEFAULTS,
  };
})();

if (typeof window !== 'undefined') window.CCAutomations = CCAutomations;

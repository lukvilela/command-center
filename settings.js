// ============================================================================
//  settings.js — Configurações por workspace + feature flags
//
//  Carregado como <script src="settings.js"> (clássico) DEPOIS do app.js.
//  Expõe window.CCSettings. Flags ficam em project.settings.flags (jsonb), por
//  workspace — cada projeto liga/desliga páginas, integrações e modos.
//
//  Depende de (todos opcionais — sempre defensivo):
//    window.CCNative  → .project (workspace atual) e .isNative()
//    window.CC        → .projects.update(id, patch)
//    window.showToast → feedback visual
//  Sem build step, vanilla puro.
// ============================================================================

const CCSettings = (() => {
  // ---- DEFAULTS -----------------------------------------------------------
  const defaults = {
    singleDev: false,
    views: {
      overview: true, epics: true, kanban: true, roadmap: true, cards: true,
      devs: true, github: true, timeline: true, notes: true, report: true, docs: true,
    },
    integrations: { github: true, gitlab: false, trello: true },
    realtime: true,
    wipEnforce: false,
  };

  // ---- helpers ------------------------------------------------------------
  const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

  // deep-merge `src` sobre `base`, sem mutar nenhum dos dois
  function deepMerge(base, src) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!isPlainObject(src)) return out;
    for (const k of Object.keys(src)) {
      if (isPlainObject(out[k]) && isPlainObject(src[k])) out[k] = deepMerge(out[k], src[k]);
      else out[k] = isPlainObject(src[k]) ? deepMerge({}, src[k]) : src[k];
    }
    return out;
  }

  function project() {
    return (window.CCNative && window.CCNative.project) || null;
  }

  function isNative() {
    return !!(window.CCNative && typeof window.CCNative.isNative === 'function'
      ? window.CCNative.isNative()
      : project());
  }

  // ---- GET ----------------------------------------------------------------
  // flags do workspace mescladas sobre os defaults (defaults vencem buracos)
  function get() {
    const p = project();
    const stored = (p && p.settings && p.settings.flags) || {};
    return deepMerge(defaults, stored);
  }

  // ---- SET ----------------------------------------------------------------
  // deep-merge do patch nas flags atuais, persiste no Supabase e atualiza
  // CCNative.project.settings em memória (pra apply() refletir sem reload).
  async function set(patch) {
    const p = project();
    if (!p) { console.warn('[CCSettings] sem workspace nativo — set() ignorado'); return get(); }

    const flags = deepMerge(get(), patch || {});
    const settings = deepMerge(p.settings || {}, { flags });

    // memória primeiro (apply imediato funciona mesmo offline)
    p.settings = settings;

    if (window.CC && CC.configured && CC.projects && typeof CC.projects.update === 'function') {
      try {
        await CC.projects.update(p.id, { settings });
      } catch (e) {
        console.error('[CCSettings] falha ao persistir flags:', e);
        throw e;
      }
    }
    return flags;
  }

  // ---- APPLY --------------------------------------------------------------
  // aplica as flags no DOM vivo (sidebar). Não toca app.js: só mostra/esconde.
  function apply() {
    const f = get();
    const items = document.querySelectorAll('.nav .nav-item[data-route], nav .nav-item[data-route]');
    items.forEach((el) => {
      const route = el.getAttribute('data-route');
      if (route === 'settings') { el.style.display = ''; return; } // nunca esconde a própria
      let visible = f.views && f.views[route] !== false; // default visível
      if (route === 'devs' && f.singleDev) visible = false;  // single-dev força esconder Devs
      el.style.display = visible ? '' : 'none';
    });
    return f;
  }

  // ---- RENDER PAGE --------------------------------------------------------
  const VIEW_LABELS = {
    overview: '📊 Overview', epics: '🎯 EPICs', kanban: '📋 Kanban', roadmap: '🗺️ Roadmap',
    cards: '🗂️ Cards', devs: '👥 Devs', github: '🐙 GitHub', timeline: '⏱️ Timeline',
    notes: '📝 Notas', report: '📊 Status Report', docs: '📚 Docs',
  };
  const INTEGRATION_META = {
    github: { label: '🐙 GitHub', hint: 'Issues, PRs, runs e cross-link de cards.' },
    gitlab: { label: '🦊 GitLab', hint: 'Em breve — merge requests e pipelines.' },
    trello: { label: '📌 Trello', hint: 'Importar/sincronizar boards do Trello.' },
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

  function toggleRow(id, label, checked, hint) {
    return `
      <label class="cc-set-row" for="${esc(id)}">
        <span class="cc-set-text">
          <span class="cc-set-label">${label}</span>
          ${hint ? `<small class="cc-set-hint">${esc(hint)}</small>` : ''}
        </span>
        <span class="cc-switch">
          <input type="checkbox" id="${esc(id)}" ${checked ? 'checked' : ''}>
          <span class="cc-switch-track"></span>
        </span>
      </label>`;
  }

  function renderPage(container) {
    if (!container) return;
    const toast = window.showToast || (() => {});

    if (!isNative()) {
      container.innerHTML = `
        <div class="cc-settings">
          <h1>⚙️ Configurações</h1>
          <div class="cc-set-empty">
            As configurações por workspace exigem o modo nativo (Supabase) ativo.
            Sem um workspace conectado não há onde persistir as flags.
          </div>
        </div>`;
      return;
    }

    const f = get();
    const p = project();

    const viewRows = Object.keys(VIEW_LABELS).map((k) =>
      toggleRow(`set-view-${k}`, VIEW_LABELS[k], f.views[k] !== false,
        k === 'devs' && f.singleDev ? 'Forçado oculto pelo modo dev único.' : '')
    ).join('');

    const intRows = Object.keys(INTEGRATION_META).map((k) => {
      const m = INTEGRATION_META[k];
      return toggleRow(`set-int-${k}`, m.label, f.integrations[k] === true, m.hint);
    }).join('');

    container.innerHTML = `
      <div class="cc-settings">
        <header class="cc-set-head">
          <h1>⚙️ Configurações</h1>
          <p class="cc-set-sub">Flags deste workspace — <strong>${esc(p.name)}</strong>.
            Cada projeto liga só o que usa; salvo por workspace.</p>
        </header>

        <section class="cc-set-group">
          <h2>Geral</h2>
          ${toggleRow('set-singleDev', '👤 Modo dev único', f.singleDev === true,
            'Esconde a página de Devs e a carga por pessoa — ideal pra projeto solo.')}
          ${toggleRow('set-realtime', '🔄 Realtime', f.realtime === true,
            'Sincroniza mudanças entre máquinas ao vivo (em vez de polling).')}
          ${toggleRow('set-wipEnforce', '🚦 Forçar WIP', f.wipEnforce === true,
            'Bloqueia mover card pra coluna que estourou o limite WIP.')}
        </section>

        <section class="cc-set-group">
          <h2>Páginas visíveis</h2>
          <p class="cc-set-grouphint">Esconde itens do menu lateral que este time não usa.</p>
          ${viewRows}
        </section>

        <section class="cc-set-group">
          <h2>Integrações</h2>
          <p class="cc-set-grouphint">Quais fontes externas este workspace consome.</p>
          ${intRows}
        </section>
      </div>`;

    // ---- wiring: cada toggle persiste via set() + reaplica apply() --------
    const bind = (id, applyPatch, successMsg) => {
      const el = container.querySelector('#' + CSS.escape(id));
      if (!el) return;
      el.addEventListener('change', async () => {
        const on = el.checked;
        try {
          await set(applyPatch(on));
          apply();
          // re-render pra refletir dependências (ex.: single-dev sobre o Devs)
          renderPage(container);
          toast(successMsg(on), 'success');
        } catch {
          el.checked = !on; // rollback visual
          toast('Erro ao salvar configuração', 'error');
        }
      });
    };

    bind('set-singleDev', (on) => ({ singleDev: on }),
      (on) => on ? '👤 Modo dev único ligado' : 'Modo dev único desligado');
    bind('set-realtime', (on) => ({ realtime: on }),
      (on) => on ? '🔄 Realtime ligado' : 'Realtime desligado');
    bind('set-wipEnforce', (on) => ({ wipEnforce: on }),
      (on) => on ? '🚦 WIP enforce ligado' : 'WIP enforce desligado');

    Object.keys(VIEW_LABELS).forEach((k) => {
      bind(`set-view-${k}`, (on) => ({ views: { [k]: on } }),
        (on) => `${VIEW_LABELS[k]} ${on ? 'visível' : 'oculto'}`);
    });
    Object.keys(INTEGRATION_META).forEach((k) => {
      bind(`set-int-${k}`, (on) => ({ integrations: { [k]: on } }),
        (on) => `${INTEGRATION_META[k].label} ${on ? 'ativado' : 'desativado'}`);
    });
  }

  // ---- AUTO-APPLY on load -------------------------------------------------
  // CCNative.project pode chegar depois (boot assíncrono). Tenta algumas vezes
  // e também escuta um evento custom opcional ('cc:ready').
  function autoApply() {
    let tries = 0;
    const tick = () => {
      if (isNative()) { apply(); return; }
      if (tries++ < 200) setTimeout(tick, 30);
    };
    tick();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoApply, { once: true });
    } else {
      autoApply();
    }
    document.addEventListener('cc:ready', apply);
  }

  return { defaults, get, set, apply, renderPage };
})();

if (typeof window !== 'undefined') window.CCSettings = CCSettings;

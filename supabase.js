// ============================================================================
//  supabase.js — camada de dados do modelo próprio (ESM, zero build step)
//
//  Carregado como <script type="module"> ANTES do app.js. Expõe:
//    window.CC          → API de dados (ou null se não configurado)
//    window.__ccReady   → Promise que resolve quando a inicialização termina
//
//  Config: lê config.json → bloco "supabase": { "url": "...", "anonKey": "..." }
//  Sem esse bloco, CC.configured = false e o app cai no fluxo Trello/derived.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SELECT_CARD = `
  *,
  card_members ( member_id ),
  card_labels ( label_id ),
  external_refs ( id, kind, ref_id, title, url, state, meta )
`;

async function init() {
  let cfg = {};
  try {
    const r = await fetch('config.json?_=' + Date.now());
    if (r.ok) cfg = await r.json();
  } catch { /* sem config.json — segue não-configurado */ }

  const sb = cfg.supabase || {};
  if (!sb.url || !sb.anonKey || /REPLACE|REPLACE_ME/i.test(sb.url + sb.anonKey)) {
    window.CC = { configured: false };
    return window.CC;
  }

  const client = createClient(sb.url, sb.anonKey, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });

  // helper: lança em erro do PostgREST
  const ok = ({ data, error }) => { if (error) throw error; return data; };

  const api = {
    configured: true,
    client,

    // ---- PROJECTS -------------------------------------------------------
    projects: {
      list: () => client.from('projects').select('*').eq('archived', false)
        .order('created_at', { ascending: true }).then(ok),
      get: (slug) => client.from('projects').select('*').eq('slug', slug).maybeSingle().then(ok),
      getById: (id) => client.from('projects').select('*').eq('id', id).maybeSingle().then(ok),
      create: (p) => client.from('projects').insert(p).select().single().then(ok),
      update: (id, patch) => client.from('projects').update(patch).eq('id', id).select().single().then(ok),
      remove: (id) => client.from('projects').delete().eq('id', id).then(ok),
    },

    // ---- SOURCES --------------------------------------------------------
    sources: {
      byProject: (pid) => client.from('sources').select('*').eq('project_id', pid)
        .order('created_at').then(ok),
      create: (s) => client.from('sources').insert(s).select().single().then(ok),
      update: (id, patch) => client.from('sources').update(patch).eq('id', id).select().single().then(ok),
      remove: (id) => client.from('sources').delete().eq('id', id).then(ok),
    },

    // ---- MEMBERS --------------------------------------------------------
    members: {
      byProject: (pid) => client.from('members').select('*').eq('project_id', pid)
        .order('created_at').then(ok),
      create: (m) => client.from('members').insert(m).select().single().then(ok),
      update: (id, patch) => client.from('members').update(patch).eq('id', id).select().single().then(ok),
      remove: (id) => client.from('members').delete().eq('id', id).then(ok),
    },

    // ---- LISTS (colunas) ------------------------------------------------
    lists: {
      byProject: (pid) => client.from('lists').select('*').eq('project_id', pid)
        .order('position').then(ok),
      create: (l) => client.from('lists').insert(l).select().single().then(ok),
      update: (id, patch) => client.from('lists').update(patch).eq('id', id).select().single().then(ok),
      remove: (id) => client.from('lists').delete().eq('id', id).then(ok),
    },

    // ---- CARDS ----------------------------------------------------------
    cards: {
      byProject: (pid, { includeArchived = false } = {}) => {
        let q = client.from('cards').select(SELECT_CARD).eq('project_id', pid);
        if (!includeArchived) q = q.eq('archived', false);
        return q.order('position').then(ok);
      },
      get: (id) => client.from('cards').select(SELECT_CARD).eq('id', id).maybeSingle().then(ok),
      create: (c) => client.from('cards').insert(c).select(SELECT_CARD).single().then(ok),
      update: (id, patch) => client.from('cards').update(patch).eq('id', id).select(SELECT_CARD).single().then(ok),
      // move: muda de coluna e/ou reposiciona (fractional indexing)
      move: (id, listId, position) =>
        client.from('cards').update({ list_id: listId, position }).eq('id', id).select(SELECT_CARD).single().then(ok),
      archive: (id) => client.from('cards').update({ archived: true }).eq('id', id).then(ok),
      remove: (id) => client.from('cards').delete().eq('id', id).then(ok),
      // upsert por origem externa (usado pelos connectors p/ sync 2-vias)
      upsertExternal: (rows) =>
        client.from('cards').upsert(rows, { onConflict: 'source_id,external_kind,external_id' })
          .select().then(ok),
    },

    // ---- ASSIGNEES / LABELS (junções) -----------------------------------
    assign:   (cardId, memberId) => client.from('card_members').upsert({ card_id: cardId, member_id: memberId }).then(ok),
    unassign: (cardId, memberId) => client.from('card_members').delete().match({ card_id: cardId, member_id: memberId }).then(ok),
    addLabel:    (cardId, labelId) => client.from('card_labels').upsert({ card_id: cardId, label_id: labelId }).then(ok),
    removeLabel: (cardId, labelId) => client.from('card_labels').delete().match({ card_id: cardId, label_id: labelId }).then(ok),
    labels: {
      byProject: (pid) => client.from('labels').select('*').eq('project_id', pid).then(ok),
      create: (l) => client.from('labels').insert(l).select().single().then(ok),
    },

    // ---- CHECKLISTS -----------------------------------------------------
    checklists: {
      byCard: (cardId) => client.from('checklists')
        .select('*, checklist_items(*)').eq('card_id', cardId).order('position').then(ok),
      create: (c) => client.from('checklists').insert(c).select().single().then(ok),
      remove: (id) => client.from('checklists').delete().eq('id', id).then(ok),
      addItem: (it) => client.from('checklist_items').insert(it).select().single().then(ok),
      toggleItem: (id, done) => client.from('checklist_items').update({ done }).eq('id', id).then(ok),
      removeItem: (id) => client.from('checklist_items').delete().eq('id', id).then(ok),
    },

    // ---- ATTACHMENTS ----------------------------------------------------
    attachments: {
      byCard: (cardId) => client.from('attachments').select('*').eq('card_id', cardId)
        .order('created_at').then(ok),
      add: (a) => client.from('attachments').insert(a).select().single().then(ok),
      remove: (id) => client.from('attachments').delete().eq('id', id).then(ok),
    },

    // ---- COMMENTS -------------------------------------------------------
    comments: {
      byCard: (cardId) => client.from('comments').select('*').eq('card_id', cardId)
        .order('created_at').then(ok),
      add: (c) => client.from('comments').insert(c).select().single().then(ok),
    },

    // ---- DEPENDENCIES (diferencial sobre o Trello) ----------------------
    deps: {
      byCard: (cardId) => client.from('card_dependencies').select('*').eq('card_id', cardId).then(ok),
      add: (d) => client.from('card_dependencies').insert(d).select().single().then(ok),
      remove: (id) => client.from('card_dependencies').delete().eq('id', id).then(ok),
    },

    // ---- EXTERNAL REFS (PRs/issues/commits vinculados) ------------------
    externalRefs: {
      upsertForCard: (cardId, refs) => client.from('external_refs')
        .upsert(refs.map(r => ({ ...r, card_id: cardId }))).then(ok),
    },

    // ---- SAVED VIEWS ----------------------------------------------------
    savedViews: {
      byProject: (pid) => client.from('saved_views').select('*').eq('project_id', pid).then(ok),
      create: (v) => client.from('saved_views').insert(v).select().single().then(ok),
      remove: (id) => client.from('saved_views').delete().eq('id', id).then(ok),
    },

    // ---- REALTIME — substitui o polling de 30s --------------------------
    // onChange é chamado a cada mudança em cards/lists do projeto.
    subscribe(projectId, onChange) {
      const ch = client.channel('cc:' + projectId);
      for (const table of ['cards', 'lists', 'card_members', 'card_labels',
                           'checklists', 'checklist_items', 'comments']) {
        ch.on('postgres_changes',
          { event: '*', schema: 'public', table, filter: table === 'cards' || table === 'lists'
              ? `project_id=eq.${projectId}` : undefined },
          (payload) => onChange(payload));
      }
      ch.subscribe();
      return () => client.removeChannel(ch);
    },
  };

  window.CC = api;
  return api;
}

window.__ccReady = init().catch((e) => {
  console.error('[CC] falha ao inicializar Supabase:', e);
  window.CC = { configured: false, error: String(e) };
  return window.CC;
});

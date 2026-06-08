// ============================================================================
//  connectors.js — Fase 3: absorção de fontes externas pro modelo nativo
//
//  syncGitHub(): pra cada source `github_repo` do projeto atual →
//    1. chama /.netlify/functions/github-sync (server-side, GH_PAT)
//    2. ABSORVE Issues → cards nativos (insert/update split: não desfaz o
//       drag do usuário em cards já existentes)
//    3. liga PRs/commits a cards pelo #NN → external_refs (durável) +
//       overlay state.github (o que a página GitHub / badges / timeline leem)
//
//  Carregado como <script src="connectors.js"> (clássico) ANTES do app.js.
//  Depende de window.CC (supabase.js) e window.CCNative (native.js).
// ============================================================================

const Connectors = (() => {

  const slug = (s) => String(s || '').toLowerCase();

  // garante uma lista pelo nome (cria se faltar); retorna id nativo
  async function ensureList(pid, name, { isDone = false } = {}) {
    const lists = CCNative.cache.lists.length ? CCNative.cache.lists : await CC.lists.byProject(pid);
    const found = lists.find(l => l.name === name);
    if (found) return found.id;
    const pos = (lists.reduce((m, l) => Math.max(m, l.position || 0), 0)) + 1000;
    const created = await CC.lists.create({ project_id: pid, name, position: pos, is_done: isDone });
    CCNative.cache.lists.push(created);
    return created.id;
  }

  // garante label pelo nome; retorna id
  async function ensureLabel(pid, name, color, labelCache) {
    if (labelCache[name]) return labelCache[name];
    const created = await CC.labels.create({ project_id: pid, name, color: color || '#6e7681' });
    labelCache[name] = created.id;
    return created.id;
  }

  // resolve as sources github_repo (seed do config.project.githubRepos se vazio)
  async function resolveGithubSources(pid) {
    let sources = (await CC.sources.byProject(pid)).filter(s => s.type === 'github_repo');
    if (sources.length === 0) {
      const cfgRepos = (window.CONFIG && window.CONFIG.project && window.CONFIG.project.githubRepos) || [];
      for (const r of cfgRepos) {
        if (!r.full) continue;
        await CC.sources.create({
          project_id: pid, type: 'github_repo',
          display_name: r.name || r.full.split('/')[1],
          config: { repo: r.full },
        });
      }
      sources = (await CC.sources.byProject(pid)).filter(s => s.type === 'github_repo');
    }
    return sources;
  }

  async function syncGitHub(onProgress = () => {}) {
    if (!CCNative.isNative()) throw new Error('Modo nativo (Supabase) não está ativo.');
    const project = CCNative.project;
    const pid = project.id;

    const sources = await resolveGithubSources(pid);
    if (!sources.length) throw new Error('Nenhum repo GitHub. Configure project.githubRepos ou adicione uma source.');

    // listas de destino p/ issues (não destrutivo: colunas próprias, claramente marcadas)
    const openListId = await ensureList(pid, '🐙 GitHub — Open');
    const doneListId = await ensureList(pid, '🐙 GitHub — Done', { isDone: true });

    // caches do projeto
    const existingCards = (await CC.cards.byProject(pid, { includeArchived: true }));
    const members = await CC.members.byProject(pid);
    const memberByLogin = {};
    for (const m of members) if (m.github_login) memberByLogin[slug(m.github_login)] = m.id;
    const labelCache = {};
    for (const l of await CC.labels.byProject(pid)) labelCache[l.name] = l.id;

    const overlay = { fetchedAt: new Date().toISOString(), repos: {}, cardLinks: {} };
    const mergeLink = (id, slot, arr) => {
      if (!overlay.cardLinks[id]) overlay.cardLinks[id] = { prs: [], commits: [] };
      overlay.cardLinks[id][slot].push(...arr);
    };

    let issuesAbsorbed = 0, issuesUpdated = 0;

    for (const src of sources) {
      const repo = (src.config && src.config.repo) || src.display_name;
      onProgress(`🐙 Sincronizando ${repo}…`);
      let res;
      try {
        const r = await fetch(`/.netlify/functions/github-sync?repo=${encodeURIComponent(repo)}&_=${Date.now()}`);
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error((j && j.erro) || `HTTP ${r.status}`);
        res = j.result;
      } catch (e) {
        onProgress(`⚠️ ${repo}: ${e.message}`);
        continue;
      }

      // overlay (página GitHub / badges)
      const key = src.display_name || repo.split('/')[1];
      overlay.repos[key] = res.repo;
      for (const [id, link] of Object.entries(res.cardLinks || {})) {
        mergeLink(id, 'prs', link.prs || []);
        mergeLink(id, 'commits', link.commits || []);
      }

      // ABSORÇÃO: issues → cards nativos
      const mineExisting = {};
      for (const c of existingCards) {
        if (c.source_id === src.id && c.external_kind === 'github_issue') mineExisting[String(c.external_id)] = c;
      }
      for (const iss of (res.issues || [])) {
        const eid = String(iss.number);
        const closed = iss.state === 'closed';
        const exist = mineExisting[eid];
        if (exist) {
          // update SÓ conteúdo — preserva coluna/posição (drag do usuário)
          await CC.cards.update(exist.id, {
            title: iss.title, body: iss.body || '', external_url: iss.url, external_raw: iss,
          });
          issuesUpdated++;
        } else {
          const card = await CC.cards.create({
            project_id: pid, list_id: closed ? doneListId : openListId,
            seq: iss.number, title: iss.title, body: iss.body || '',
            position: 1000 + iss.number,
            source_id: src.id, external_kind: 'github_issue',
            external_id: eid, external_url: iss.url, external_raw: iss,
          });
          existingCards.push({ ...card, source_id: src.id, external_kind: 'github_issue', external_id: eid });
          // assignees → membros existentes; labels → ensure + attach
          for (const login of (iss.assignees || [])) {
            const mid = memberByLogin[slug(login)];
            if (mid) await CC.assign(card.id, mid);
          }
          for (const lb of (iss.labels || [])) {
            const lid = await ensureLabel(pid, lb.name, lb.color, labelCache);
            await CC.addLabel(card.id, lid);
          }
          issuesAbsorbed++;
        }
      }

      try { await CC.sources.update(src.id, { last_synced_at: new Date().toISOString() }); } catch {}
    }

    // PERSISTÊNCIA dos links em external_refs (durável p/ próximas fases) —
    // mapeia #NN → card por seq (cobre cards do Trello E issues do GitHub)
    onProgress('Vinculando PRs aos cards…');
    const cardBySeq = {};
    for (const c of existingCards) if (c.seq != null) cardBySeq[c.seq] = c;
    for (const [idStr, link] of Object.entries(overlay.cardLinks)) {
      const card = cardBySeq[parseInt(idStr, 10)];
      if (!card) continue;
      const refs = [
        ...(link.prs || []).map(p => ({ kind: 'pr', ref_id: `${p.repo}#${p.number}`, title: p.title,
          url: p.url, state: (p.state || '').toLowerCase(), meta: { author: p.author, isDraft: p.isDraft } })),
        ...(link.commits || []).map(c => ({ kind: 'commit', ref_id: c.sha, title: c.message,
          url: c.url, state: null, meta: { author: c.author, date: c.date } })),
      ];
      try { await CC.externalRefs.replaceForCard(card.id, refs); } catch (e) { /* não-fatal */ }
    }

    // entrega o overlay pro app (página GitHub / badges / timeline)
    if (window.CCNative && CCNative.setGithub) CCNative.setGithub(overlay);

    onProgress(`✅ GitHub: ${issuesAbsorbed} issues novas, ${issuesUpdated} atualizadas, ${Object.keys(overlay.repos).length} repo(s).`);
    return { overlay, issuesAbsorbed, issuesUpdated };
  }

  return { syncGitHub, resolveGithubSources };
})();

window.Connectors = Connectors;

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

  // ── Cliente GitHub que roda NO NAVEGADOR (api.github.com tem CORS p/ token).
  //    Usado quando a fonte tem API key salva → puxa/manipula sem function/servidor.
  const GH = {
    async api(path, token, opts = {}) {
      const r = await fetch('https://api.github.com' + path, {
        ...opts,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.headers || {}),
        },
      });
      if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 160));
      return r.status === 204 ? null : r.json();
    },

    extractIds(text) {
      if (!text) return [];
      return [...new Set([...String(text).matchAll(/#(\d{1,4})\b/g)].map(m => parseInt(m[1], 10)))];
    },

    // mesmo shape que a function github-sync.js, porém client-side
    async fetchRepo(repo, token) {
      const [pulls, issuesRaw, runsRaw, commitsRaw] = await Promise.all([
        this.api(`/repos/${repo}/pulls?state=all&per_page=60&sort=updated&direction=desc`, token).catch(() => []),
        this.api(`/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`, token).catch(() => []),
        this.api(`/repos/${repo}/actions/runs?per_page=15`, token).catch(() => ({ workflow_runs: [] })),
        this.api(`/repos/${repo}/commits?per_page=25`, token).catch(() => []),
      ]);
      const short = repo.split('/')[1];
      const prs = (pulls || []).map(pr => ({
        repo: short, number: pr.number, title: pr.title,
        state: pr.merged_at ? 'MERGED' : (pr.state || '').toUpperCase(), isDraft: !!pr.draft,
        createdAt: pr.created_at, updatedAt: pr.updated_at, mergedAt: pr.merged_at, closedAt: pr.closed_at,
        author: pr.user && pr.user.login, headRefName: pr.head && pr.head.ref, baseRefName: pr.base && pr.base.ref,
        labels: (pr.labels || []).map(l => ({ name: l.name, color: l.color })),
        reviewDecision: null, mergeable: null, additions: null, deletions: null, url: pr.html_url, body: pr.body || '',
      }));
      const runs = ((runsRaw && runsRaw.workflow_runs) || []).map(r => ({
        databaseId: r.id, displayTitle: r.display_title, event: r.event, conclusion: r.conclusion, status: r.status,
        createdAt: r.created_at, updatedAt: r.updated_at, headBranch: r.head_branch, workflowName: r.name, url: r.html_url,
      }));
      const commits = (commitsRaw || []).map(c => ({
        sha: c.sha, message: c.commit.message, author: c.commit.author && c.commit.author.name,
        date: c.commit.author && c.commit.author.date, url: c.html_url,
      }));
      const issues = (issuesRaw || []).filter(i => !i.pull_request).map(i => ({
        number: i.number, title: i.title, body: i.body || '', state: i.state,
        labels: (i.labels || []).map(l => ({ name: l.name, color: l.color })),
        assignees: (i.assignees || []).map(a => a.login), author: i.user && i.user.login,
        createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at, url: i.html_url,
      }));
      const cardLinks = {};
      const push = (id, slot, o) => { (cardLinks[id] = cardLinks[id] || { prs: [], commits: [] })[slot].push(o); };
      for (const pr of prs) for (const id of [...this.extractIds(pr.title), ...this.extractIds(pr.body), ...this.extractIds(pr.headRefName)])
        push(id, 'prs', { repo: short, number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft,
          mergedAt: pr.mergedAt, closedAt: pr.closedAt, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
          headRefName: pr.headRefName, author: pr.author, mergeable: null, url: pr.url });
      for (const c of commits) for (const id of this.extractIds(c.message))
        push(id, 'commits', { repo: short, sha: c.sha.slice(0, 7), message: c.message.split('\n')[0].slice(0, 120), author: c.author, date: c.date, url: c.url });
      const stats = {
        openPRs: prs.filter(p => p.state === 'OPEN').length,
        mergedRecent: prs.filter(p => p.mergedAt && (Date.now() - new Date(p.mergedAt).getTime()) < 7 * 86400000).length,
        runsFailed: runs.filter(r => r.conclusion === 'failure').length,
        runsLastSuccess: runs.find(r => r.conclusion === 'success'),
        runsLastFailure: runs.find(r => r.conclusion === 'failure'),
      };
      return { fetchedAt: new Date().toISOString(), repo: { full: repo, url: `https://github.com/${repo}`, prs, runs, commits, stats }, issues, cardLinks };
    },

    // escrita direta (merge/close/reopen/comment/createIssue)
    write(action, d, token) {
      const J = (method, path, body) => this.api(path, token, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      switch (action) {
        case 'mergePR':      return J('PUT',   `/repos/${d.repo}/pulls/${d.number}/merge`, { merge_method: d.method || 'merge' });
        case 'closePR':      return J('PATCH', `/repos/${d.repo}/pulls/${d.number}`, { state: 'closed' });
        case 'reopenPR':     return J('PATCH', `/repos/${d.repo}/pulls/${d.number}`, { state: 'open' });
        case 'commentPR':
        case 'commentIssue': return J('POST',  `/repos/${d.repo}/issues/${d.number}/comments`, { body: d.body });
        case 'closeIssue':   return J('PATCH', `/repos/${d.repo}/issues/${d.number}`, { state: 'closed' });
        case 'reopenIssue':  return J('PATCH', `/repos/${d.repo}/issues/${d.number}`, { state: 'open' });
        case 'createIssue':  return J('POST',  `/repos/${d.repo}/issues`, { title: d.title, body: d.body || '' });
        default: throw new Error('ação GitHub desconhecida: ' + action);
      }
    },
  };

  // resolve o token salvo na source de um repo (p/ writes client-side)
  async function tokenForRepo(repoFull) {
    if (!CCNative.isNative()) return null;
    try {
      const srcs = await CC.sources.byProject(CCNative.project.id);
      const s = srcs.find(x => x.type === 'github_repo' && x.config && x.config.repo === repoFull && x.config.token);
      return s ? s.config.token : null;
    } catch { return null; }
  }

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

    let issuesAbsorbed = 0, issuesUpdated = 0, prsAbsorbed = 0, prsUpdated = 0;

    for (const src of sources) {
      const repo = (src.config && src.config.repo) || src.display_name;
      const token = src.config && src.config.token;
      onProgress(`🐙 Puxando ${repo}…`);
      let res;
      try {
        if (token) {
          // tem API key → puxa DIRETO do navegador (funciona sem servidor/function)
          res = await GH.fetchRepo(repo, token);
        } else {
          // sem key → usa a function (GH_PAT do servidor); só roda em netlify dev/deploy
          const r = await fetch(`/.netlify/functions/github-sync?repo=${encodeURIComponent(repo)}&_=${Date.now()}`);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error((j && j.erro) || `HTTP ${r.status} — cole a API key em 🔌 Fontes pra puxar sem servidor`);
          res = j.result;
        }
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

      // ABSORÇÃO: PRs → cards (repos que trabalham por PR, ex. projetos solo)
      const minePR = {};
      for (const c of existingCards) {
        if (c.source_id === src.id && c.external_kind === 'github_pr') minePR[String(c.external_id)] = c;
      }
      for (const pr of (res.repo.prs || [])) {
        const eid = String(pr.number);
        const closed = pr.state !== 'OPEN';   // MERGED ou CLOSED → coluna Done
        const title = `PR #${pr.number}: ${pr.title}`;
        const exist = minePR[eid];
        if (exist) {
          await CC.cards.update(exist.id, { title, body: pr.body || '', external_url: pr.url, external_raw: pr });
          prsUpdated++;
        } else {
          const card = await CC.cards.create({
            project_id: pid, list_id: closed ? doneListId : openListId,
            seq: pr.number, title, body: pr.body || '', position: 1000 + pr.number,
            source_id: src.id, external_kind: 'github_pr', external_id: eid, external_url: pr.url, external_raw: pr,
          });
          existingCards.push({ ...card });
          const mid = memberByLogin[slug(pr.author || '')];
          if (mid) await CC.assign(card.id, mid);
          for (const lb of (pr.labels || [])) {
            const lid = await ensureLabel(pid, lb.name, lb.color, labelCache);
            await CC.addLabel(card.id, lid);
          }
          prsAbsorbed++;
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

    onProgress(`✅ GitHub: ${issuesAbsorbed} issues + ${prsAbsorbed} PRs novos (${issuesUpdated + prsUpdated} atualizados), ${Object.keys(overlay.repos).length} repo(s).`);
    return { overlay, issuesAbsorbed, issuesUpdated, prsAbsorbed, prsUpdated };
  }

  return {
    syncGitHub, resolveGithubSources, tokenForRepo,
    ghWrite: (action, data, token) => GH.write(action, data, token),
  };
})();

window.Connectors = Connectors;

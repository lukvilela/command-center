// ============================================================================
//  connectors-gitlab.js — window.ConnectorsGitLab (Fase 4: integração GitLab)
//
//  Espelha o connector GitHub: absorve um projeto GitLab (issues → cards,
//  merge requests → cards) pro modelo nativo. Roda DIRETO do navegador com a
//  API key salva na fonte (gitlab.com API v4 tem CORS via header PRIVATE-TOKEN),
//  então funciona no `npx serve`, sem servidor.
//
//  Carregado como <script src="connectors-gitlab.js"> após connectors.js.
//  Depende de window.CC e window.CCNative. Sources do tipo 'gitlab_project'
//  com config { repo: 'group/name', token }.
// ============================================================================

const ConnectorsGitLab = (() => {
  const API = 'https://gitlab.com/api/v4';
  const slug = (s) => String(s || '').toLowerCase();
  const priorityFromLabels = (labels) => ((labels || []).map(l => l.name).find(n => /^P[0-3]$/.test(n))) || null;
  const epicFromTitle = (t) => (String(t || '').match(/\[(\w+)\]/) || [])[1] || null;
  const extractIds = (text) => [...new Set([...String(text || '').matchAll(/#(\d{1,4})\b/g)].map(m => parseInt(m[1], 10)))];

  // ── Cliente GitLab no navegador ──────────────────────────────────────────
  const GL = {
    async api(path, token) {
      const r = await fetch(API + path, { headers: { 'PRIVATE-TOKEN': token, 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('GitLab ' + r.status + ': ' + (await r.text()).slice(0, 160));
      return r.json();
    },
    mrState(mr) { const s = (mr.state || '').toLowerCase(); return s === 'merged' ? 'MERGED' : s === 'closed' ? 'CLOSED' : 'OPEN'; },
    pipeConclusion(s) { return ({ success: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped' })[(s || '').toLowerCase()] || null; },

    // mesmo shape do github GH.fetchRepo / gitlab-sync function
    async fetchProject(projectPath, token) {
      const idEnc = /^\d+$/.test(projectPath) ? projectPath : encodeURIComponent(projectPath);
      const meta = await this.api(`/projects/${idEnc}`, token).catch(() => ({}));
      const id = meta.id != null ? meta.id : idEnc;
      const full = meta.path_with_namespace || projectPath;
      const webUrl = meta.web_url || `https://gitlab.com/${full}`;
      const short = full.split('/').pop();

      const [mrsRaw, issuesRaw, pipesRaw, commitsRaw] = await Promise.all([
        this.api(`/projects/${id}/merge_requests?state=all&per_page=60&order_by=updated_at&sort=desc`, token).catch(() => []),
        this.api(`/projects/${id}/issues?state=all&per_page=100&order_by=updated_at&sort=desc`, token).catch(() => []),
        this.api(`/projects/${id}/pipelines?per_page=15&order_by=updated_at&sort=desc`, token).catch(() => []),
        this.api(`/projects/${id}/repository/commits?per_page=25`, token).catch(() => []),
      ]);

      const prs = (mrsRaw || []).map(mr => ({
        repo: short, number: mr.iid, title: mr.title, state: this.mrState(mr),
        isDraft: !!(mr.draft || mr.work_in_progress), createdAt: mr.created_at, updatedAt: mr.updated_at,
        mergedAt: mr.merged_at, closedAt: mr.closed_at, author: mr.author && mr.author.username,
        headRefName: mr.source_branch, baseRefName: mr.target_branch,
        labels: (mr.labels || []).map(l => ({ name: l, color: null })),
        reviewDecision: null, mergeable: null, additions: null, deletions: null, url: mr.web_url, body: mr.description || '',
      }));
      const runs = (pipesRaw || []).map(p => ({
        databaseId: p.id, displayTitle: p.ref, event: p.source, conclusion: this.pipeConclusion(p.status),
        status: p.status, createdAt: p.created_at, updatedAt: p.updated_at, headBranch: p.ref, workflowName: 'pipeline', url: p.web_url,
      }));
      const commits = (commitsRaw || []).map(c => ({
        sha: c.id, message: c.message, author: c.author_name, date: c.authored_date || c.created_at, url: c.web_url,
      }));
      const issues = (issuesRaw || []).map(i => ({
        number: i.iid, title: i.title, body: i.description || '', state: (i.state === 'closed' ? 'closed' : 'open'),
        labels: (i.labels || []).map(l => ({ name: l, color: null })), assignees: (i.assignees || []).map(a => a.username),
        author: i.author && i.author.username, createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at, url: i.web_url,
      }));

      const cardLinks = {};
      const push = (id, slot, o) => { (cardLinks[id] = cardLinks[id] || { prs: [], commits: [] })[slot].push(o); };
      for (const pr of prs) for (const id of [...extractIds(pr.title), ...extractIds(pr.body), ...extractIds(pr.headRefName)])
        push(id, 'prs', { repo: short, number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft,
          mergedAt: pr.mergedAt, closedAt: pr.closedAt, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
          headRefName: pr.headRefName, author: pr.author, mergeable: null, url: pr.url });
      for (const c of commits) for (const id of extractIds(c.message))
        push(id, 'commits', { repo: short, sha: String(c.sha).slice(0, 7), message: c.message.split('\n')[0].slice(0, 120), author: c.author, date: c.date, url: c.url });

      const stats = {
        openPRs: prs.filter(p => p.state === 'OPEN').length,
        mergedRecent: prs.filter(p => p.mergedAt && (Date.now() - new Date(p.mergedAt).getTime()) < 7 * 86400000).length,
        runsFailed: runs.filter(r => r.conclusion === 'failure').length,
        runsLastSuccess: runs.find(r => r.conclusion === 'success'), runsLastFailure: runs.find(r => r.conclusion === 'failure'),
      };
      return { fetchedAt: new Date().toISOString(), repo: { full, url: webUrl, prs, runs, commits, stats }, issues, cardLinks };
    },
  };

  // ── Absorção: issues + MRs → cards nativos (espelha syncGitHub) ───────────
  async function syncGitLab(onProgress = () => {}) {
    if (!window.CCNative || !CCNative.isNative()) return { skipped: 'no-native' };
    const project = CCNative.project, pid = project.id;
    const sources = (await CC.sources.byProject(pid)).filter(s => s.type === 'gitlab_project');
    if (!sources.length) return { skipped: 'no-sources' };

    const openListId = await ensureList(pid, '🦊 GitLab — Open');
    const doneListId = await ensureList(pid, '🦊 GitLab — Done', true);

    const existingCards = await CC.cards.byProject(pid, { includeArchived: true });
    const memberByLogin = {};
    for (const m of await CC.members.byProject(pid)) if (m.gitlab_username) memberByLogin[slug(m.gitlab_username)] = m.id;
    const labelCache = {};
    for (const l of await CC.labels.byProject(pid)) labelCache[l.name] = l.id;

    async function ensureMember(login) {
      if (!login) return null;
      const k = slug(login);
      if (memberByLogin[k]) return memberByLogin[k];
      const m = await CC.members.create({ project_id: pid, name: login, gitlab_username: login, emoji: '🦊', color: '#fc6d26' });
      memberByLogin[k] = m.id; return m.id;
    }
    async function ensureLabel(name, color) {
      if (labelCache[name]) return labelCache[name];
      const l = await CC.labels.create({ project_id: pid, name, color: color || '#fc6d26' });
      labelCache[name] = l.id; return l.id;
    }

    // overlay: MESCLA no overlay existente (não clobberar o GitHub)
    const overlay = (CCNative.getGithub && CCNative.getGithub()) || { fetchedAt: new Date().toISOString(), repos: {}, cardLinks: {} };
    overlay.repos = overlay.repos || {}; overlay.cardLinks = overlay.cardLinks || {};
    const mergeLink = (id, slot, arr) => { (overlay.cardLinks[id] = overlay.cardLinks[id] || { prs: [], commits: [] })[slot].push(...arr); };

    let issuesAbsorbed = 0, mrsAbsorbed = 0, updated = 0;

    for (const src of sources) {
      const repo = (src.config && src.config.repo) || src.display_name;
      const token = src.config && src.config.token;
      onProgress(`🦊 Puxando ${repo}…`);
      let res;
      try {
        if (token) res = await GL.fetchProject(repo, token);
        else {
          const r = await fetch(`/.netlify/functions/gitlab-sync?project=${encodeURIComponent(repo)}&_=${Date.now()}`);
          const j = await r.json();
          if (!r.ok || !j.ok) throw new Error((j && j.erro) || `HTTP ${r.status} — cole a API key em 🔌 Fontes`);
          res = j.result;
        }
      } catch (e) { onProgress(`⚠️ ${repo}: ${e.message}`); continue; }

      overlay.repos['🦊 ' + (src.display_name || repo.split('/').pop())] = res.repo;
      for (const [id, link] of Object.entries(res.cardLinks || {})) { mergeLink(id, 'prs', link.prs || []); mergeLink(id, 'commits', link.commits || []); }

      const mine = { issue: {}, mr: {} };
      for (const c of existingCards) {
        if (c.source_id !== src.id) continue;
        if (c.external_kind === 'gitlab_issue') mine.issue[String(c.external_id)] = c;
        if (c.external_kind === 'gitlab_mr') mine.mr[String(c.external_id)] = c;
      }

      // issues → cards
      for (const iss of (res.issues || [])) {
        const eid = String(iss.number), closed = iss.state === 'closed', exist = mine.issue[eid];
        const patch = { epic: epicFromTitle(iss.title), priority: priorityFromLabels(iss.labels) };
        if (exist) {
          await CC.cards.update(exist.id, Object.assign({ title: iss.title, body: iss.body || '', external_url: iss.url, external_raw: iss }, patch));
          for (const lg of (iss.assignees || [])) { const mid = await ensureMember(lg); if (mid) await CC.assign(exist.id, mid); }
          updated++;
        } else {
          const card = await CC.cards.create(Object.assign({
            project_id: pid, list_id: closed ? doneListId : openListId, seq: iss.number, title: iss.title, body: iss.body || '',
            position: 1000 + iss.number, source_id: src.id, external_kind: 'gitlab_issue', external_id: eid, external_url: iss.url, external_raw: iss,
          }, patch));
          existingCards.push({ ...card });
          for (const lg of (iss.assignees || [])) { const mid = await ensureMember(lg); if (mid) await CC.assign(card.id, mid); }
          for (const lb of (iss.labels || [])) { const lid = await ensureLabel(lb.name, lb.color); await CC.addLabel(card.id, lid); }
          issuesAbsorbed++;
        }
      }

      // merge requests → cards
      for (const mr of (res.repo.prs || [])) {
        const eid = String(mr.number), closed = mr.state !== 'OPEN', title = `MR !${mr.number}: ${mr.title}`, exist = mine.mr[eid];
        const patch = { epic: epicFromTitle(mr.title), priority: priorityFromLabels(mr.labels) };
        if (exist) {
          await CC.cards.update(exist.id, Object.assign({ title, body: mr.body || '', external_url: mr.url, external_raw: mr }, patch));
          const mid = await ensureMember(mr.author); if (mid) await CC.assign(exist.id, mid);
          updated++;
        } else {
          const card = await CC.cards.create(Object.assign({
            project_id: pid, list_id: closed ? doneListId : openListId, seq: mr.number, title, body: mr.body || '',
            position: 1000 + mr.number, source_id: src.id, external_kind: 'gitlab_mr', external_id: eid, external_url: mr.url, external_raw: mr,
          }, patch));
          existingCards.push({ ...card });
          const mid = await ensureMember(mr.author); if (mid) await CC.assign(card.id, mid);
          mrsAbsorbed++;
        }
      }

      try { await CC.sources.update(src.id, { last_synced_at: new Date().toISOString() }); } catch {}
    }

    // persiste o overlay mesclado
    try {
      await CC.projects.update(pid, { settings: Object.assign({}, project.settings, { githubOverlay: overlay }) });
      project.settings = Object.assign({}, project.settings, { githubOverlay: overlay });
    } catch {}
    if (CCNative.setGithub) CCNative.setGithub(overlay);

    onProgress(`✅ GitLab: ${issuesAbsorbed} issues + ${mrsAbsorbed} MRs novos`);
    return { issuesAbsorbed, mrsAbsorbed, updated };
  }

  // helper local (mesma assinatura do connectors.js)
  async function ensureList(pid, name, isDone = false) {
    const lists = (CCNative.cache && CCNative.cache.lists && CCNative.cache.lists.length) ? CCNative.cache.lists : await CC.lists.byProject(pid);
    const found = lists.find(l => l.name === name);
    if (found) return found.id;
    const pos = (lists.reduce((m, l) => Math.max(m, l.position || 0), 0)) + 1000;
    const created = await CC.lists.create({ project_id: pid, name, position: pos, is_done: isDone });
    if (CCNative.cache && CCNative.cache.lists) CCNative.cache.lists.push(created);
    return created.id;
  }

  return { syncGitLab, GL };
})();

window.ConnectorsGitLab = ConnectorsGitLab;

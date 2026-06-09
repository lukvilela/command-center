// ============================================================================
//  connectors-jira.js — window.ConnectorsJira (Jira Cloud)
//
//  Absorve um projeto Jira (issues → cards) pro modelo nativo. DIFERE do
//  GitHub/GitLab: o Jira Cloud NÃO libera CORS pro navegador, então SEMPRE
//  passa pela Netlify Function /jira-sync (precisa `netlify dev` ou deploy —
//  não roda no `npx serve` puro).
//
//  Carregado após connectors.js. Sources do tipo 'jira_project' com config
//  { site, projectKey, email, token }.
// ============================================================================

const ConnectorsJira = (() => {
  const slug = (s) => String(s || '').toLowerCase();
  const epicFromTitle = (t) => (String(t || '').match(/\[(\w+)\]/) || [])[1] || null;

  async function fetchProject(cfg) {
    const r = await fetch('/.netlify/functions/jira-sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: cfg.site, projectKey: cfg.projectKey, email: cfg.email, token: cfg.token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error((j && j.erro) || `HTTP ${r.status} — Jira exige a function (use netlify dev/deploy)`);
    return j.result;
  }

  async function ensureList(pid, name, isDone = false) {
    const lists = (CCNative.cache && CCNative.cache.lists && CCNative.cache.lists.length) ? CCNative.cache.lists : await CC.lists.byProject(pid);
    const found = lists.find(l => l.name === name);
    if (found) return found.id;
    const pos = (lists.reduce((m, l) => Math.max(m, l.position || 0), 0)) + 1000;
    const created = await CC.lists.create({ project_id: pid, name, position: pos, is_done: isDone });
    if (CCNative.cache && CCNative.cache.lists) CCNative.cache.lists.push(created);
    return created.id;
  }

  async function syncJira(onProgress = () => {}) {
    if (!window.CCNative || !CCNative.isNative()) return { skipped: 'no-native' };
    const project = CCNative.project, pid = project.id;
    const sources = (await CC.sources.byProject(pid)).filter(s => s.type === 'jira_project');
    if (!sources.length) return { skipped: 'no-sources' };

    const openListId = await ensureList(pid, '🟦 Jira — Open');
    const doneListId = await ensureList(pid, '🟦 Jira — Done', true);

    const existingCards = await CC.cards.byProject(pid, { includeArchived: true });
    const memberByName = {};
    for (const m of await CC.members.byProject(pid)) memberByName[slug(m.name)] = m.id;
    const labelCache = {};
    for (const l of await CC.labels.byProject(pid)) labelCache[l.name] = l.id;

    async function ensureMember(name) {
      if (!name) return null;
      const k = slug(name);
      if (memberByName[k]) return memberByName[k];
      const m = await CC.members.create({ project_id: pid, name, emoji: '🟦', color: '#2684ff' });
      memberByName[k] = m.id; return m.id;
    }
    async function ensureLabel(name, color) {
      if (labelCache[name]) return labelCache[name];
      const l = await CC.labels.create({ project_id: pid, name, color: color || '#2684ff' });
      labelCache[name] = l.id; return l.id;
    }

    let absorbed = 0, updated = 0;

    for (const src of sources) {
      const cfg = src.config || {};
      const ref = `${cfg.site || '?'}/${cfg.projectKey || '?'}`;
      onProgress(`🟦 Puxando Jira ${ref}…`);
      if (!cfg.token || !cfg.email || !cfg.site || !cfg.projectKey) { onProgress(`⚠️ ${ref}: faltam credenciais Jira`); continue; }
      let res;
      try { res = await fetchProject(cfg); }
      catch (e) { onProgress(`⚠️ ${ref}: ${e.message}`); continue; }

      const mine = {};
      for (const c of existingCards) if (c.source_id === src.id && c.external_kind === 'jira_issue') mine[String(c.external_id)] = c;

      let seqBase = 100000; // evita colisão de seq com #NN de GitHub/GitLab
      for (const iss of (res.issues || [])) {
        const eid = iss.key, closed = iss.state === 'closed', exist = mine[eid];
        const patch = { epic: epicFromTitle(iss.title), priority: iss.priority || null };
        if (exist) {
          await CC.cards.update(exist.id, Object.assign({ title: iss.title, body: iss.body || '', external_url: iss.url, external_raw: iss }, patch));
          for (const a of (iss.assignees || [])) { const mid = await ensureMember(a); if (mid) await CC.assign(exist.id, mid); }
          updated++;
        } else {
          const card = await CC.cards.create(Object.assign({
            project_id: pid, list_id: closed ? doneListId : openListId, seq: seqBase + iss.number,
            title: iss.title, body: iss.body || '', position: seqBase + iss.number,
            source_id: src.id, external_kind: 'jira_issue', external_id: eid, external_url: iss.url, external_raw: iss,
          }, patch));
          existingCards.push({ ...card });
          for (const a of (iss.assignees || [])) { const mid = await ensureMember(a); if (mid) await CC.assign(card.id, mid); }
          for (const lb of (iss.labels || [])) { const lid = await ensureLabel(lb.name, lb.color); await CC.addLabel(card.id, lid); }
          absorbed++;
        }
      }

      try { await CC.sources.update(src.id, { last_synced_at: new Date().toISOString() }); } catch {}
    }

    onProgress(`✅ Jira: ${absorbed} issues novas (${updated} atualizadas)`);
    return { absorbed, updated };
  }

  return { syncJira, fetchProject };
})();

window.ConnectorsJira = ConnectorsJira;

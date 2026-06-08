# Connectors — absorvendo fontes externas (Fase 3+)

O Command Center tem modelo próprio (Fase 1). **Connectors** trazem fontes
externas pra dentro dele. Hoje: **GitHub**. Próximos: GitLab, Trello 2-vias.

## 🐙 GitHub

### Pré-requisitos
1. **Modo nativo ativo** (Supabase configurado — ver `SETUP-SUPABASE.md`).
2. Env **`GH_PAT`** no Netlify (Site settings → Environment variables) — um
   Personal Access Token com escopo `repo` (read). Já é o mesmo usado pelo modal.
3. O projeto precisa de **sources** `github_repo`. Se não houver, o connector
   semeia automaticamente a partir de `config.project.githubRepos` no 1º sync.

### Como usar
No seletor de projeto (topo do sidebar) → botão **🐙 Sync**.

### O que ele faz
- **Issues → cards nativos.** Cada issue vira um card (colunas `🐙 GitHub — Open`
  e `🐙 GitHub — Done`, criadas se faltarem). Re-sync **atualiza só conteúdo**
  (título/corpo) — **não desfaz** o card que você arrastou pra outra coluna.
- **PRs / commits → vínculos.** Liga ao card pelo `#NN` (título/branch/mensagem),
  populando o overlay (página GitHub, badges, timeline) **e** `external_refs`
  (durável no banco).
- **Labels & assignees.** Labels viram labels do projeto; assignees são casados
  com membros existentes via `github_login`.
- **Deploys.** Status das Actions runs (deploy quebrado destacado).

### Arquitetura
```
🐙 Sync ─▶ Connectors.syncGitHub()            (connectors.js, cliente)
             │  pra cada source github_repo:
             ├─▶ GET /.netlify/functions/github-sync?repo=owner/name   (GH_PAT server-side)
             │       └─ retorna { repo:{prs,runs,commits,stats}, issues, cardLinks }
             ├─▶ upsert Issues → cards   (CC.cards, insert/update split)
             ├─▶ PRs/commits → external_refs  (CC.externalRefs.replaceForCard)
             └─▶ CCNative.setGithub(overlay) → app renderiza página GitHub/badges
```

### Vários repos
O projeto absorve **N repos** ao mesmo tempo. Gerencie em **🔌 Fontes** (no
seletor de projeto): cole vários `owner/name` (um por linha), remova, e
"Sincronizar tudo" puxa todos de uma vez. O Sync itera todas as sources
`github_repo` e mescla os resultados num overlay só.

### Manipulação (write-back) — não é só leitura
Linkado de verdade: dá pra **agir** no GitHub de dentro do Command Center.
Gated pelo secret compartilhado (`X-TCC-Secret` → `TRYEVO_DASH_SECRET`); o
`GH_PAT` precisa de escopo de **escrita** (`repo`).

| Onde | Ação |
|---|---|
| Modal de PR | **✅ Merge** (bloqueia se em conflito), **🚫 Fechar**, **♻️ Reabrir**, **💬 Comentar** |
| Card (Ações) | **🐙 Criar issue no GitHub** (resolve o repo das sources; escolhe se houver vários) |

Fluxo: `github-write.js` (function POST, secret-gated) → GitHub API. Após a ação,
o modal e o overlay recarregam. Próximo: fechar issue ao mover card pra Done (automação, Fase 2).

### Limitações conhecidas (v1)
- `mergeable`/`reviewDecision`/`additions` não vêm na listagem (evita N chamadas);
  o **modal** do PR já busca o detalhe completo sob demanda (`github-api`).
- Issues e cards do Trello dividem o namespace `#NN` (`seq`). Em projeto misto,
  números podem colidir — ok pra projetos GitHub-nativos ou Trello-nativos.
- Sync é manual (botão). Fase futura: webhook/automação agendada.

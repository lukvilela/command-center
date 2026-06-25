# Trello Command Center

> **Substitui o Trello (e expande)** — kanban editável, drag-and-drop, modal com checklists/comments/labels/members, integração GitHub (PRs/runs), métricas (velocity, lead time), docs estruturada, multi-usuário e auto-sync entre máquinas.

**Stack:** HTML/CSS/JS vanilla + Netlify Functions + Trello API + gh CLI. Sem build step. Sem framework. Pronto pra deploy em 5 minutos.

---

## ✨ Features

### 📋 Kanban completo
- Drag-and-drop cards entre listas (desktop + mobile/touch)
- Quick add card inline ou via FAB flutuante (+)
- Criar / renomear / arquivar listas direto da UI
- Live sync: outras máquinas veem mudanças em até 30s

### 🎴 Modal de card editável (Trello-style)
- Editar título inline
- Editar descrição
- Adicionar/remover **members** (clicáveis)
- Adicionar/remover **labels**
- **Checklists** com toggle de items (criar, marcar, deletar)
- **Comentários** com lista + novo
- **Due date** com checkbox de "concluída"
- Mover entre listas (dropdown)
- Arquivar / deletar

### 🐙 Integração GitHub
- PRs abertos / mergeados / em conflito por dev
- Status de Actions runs (deploy quebrado destacado)
- Cross-link cards Trello ↔ PRs (via tag `#NN` no título do PR)
- Timeline cronológica de PRs/commits/runs

### 📊 Painéis
- **Overview:** stats, alertas auto-detectados, notas executivas, seus cards, tua atividade GitHub
- **EPICs:** painel de progresso por domínio com barra de progresso e drill-down
- **Cards:** tabela densa filtrável por dev/EPIC/prioridade
- **Devs:** carga por pessoa (In Progress + Sandbox + Blocked)
- **GitHub:** PRs abertos, deploys, conflitos
- **Timeline:** atividade cronológica
- **Docs:** 13 markdowns estruturados navegáveis (template Scrum/POP/INVEST)

### 🔄 Live sync entre máquinas
- Function `trello-snapshot` lê Trello LIVE
- Polling automático cada 30s (só quando aba ativa)
- Auto-update após qualquer escrita
- Toast `🔄 Dados atualizados` quando outra máquina mudou algo

### 👥 Multi-usuário
- Picker "Quem é você?" no primeiro acesso
- Avatar/cor/emoji por pessoa
- Cada um vê seus cards, seus PRs, seu nome no header
- Visitante (Read-only) vê tudo sem editar

### 🔐 Auth simples
- Secret compartilhado pelo time pra escrita
- Quem souber o secret pode editar; quem não, só vê
- Token Trello fica server-side no Netlify (não vaza)

### 📚 Docs estruturada
- 13 documentos numerados (Visão, Arquitetura, EPICs, etc.)
- Renderização com TOC scroll-spy, breadcrumbs, prev/next
- Search global em todos os docs
- Cross-links automáticos
- Reading time + word count

---

## 🚀 Setup rápido (5 min)

Ver [SETUP.md](SETUP.md) pro passo-a-passo completo. Resumo:

1. Clone este repo
2. `cp config.example.json config.json` → edita com seu projeto
3. `cp .env.example .env` → edita com Trello credentials
4. `node refresh.js` → puxa Trello + gera dashboards
5. `npx serve -l 8000 .` → abre http://localhost:8000

Pra equipe acessar via link público:
1. Push pra repo GitHub
2. Importa no Netlify
3. Adiciona env vars no painel Netlify
4. Pronto — link `https://seu-projeto.netlify.app`

---

## 🤖 Setup via Claude (mais rápido ainda)

Tem [PROMPT-CLAUDE.md](PROMPT-CLAUDE.md) com prompt pronto pra colar no Claude. Ele lê seu Trello + GitHub e configura tudo sozinho.

---

## 🏗️ Arquitetura

```
┌──────────────────────────────────────────────────┐
│  Browser (HTML/CSS/JS vanilla)                   │
│  config.json + data/derived.json + Marked.js     │
└─────────────────────┬────────────────────────────┘
                      │ fetch
                      ▼
       ┌──────────────────────────────────┐
       │ Netlify Functions                 │
       │ ├─ trello-snapshot (read live)    │
       │ └─ trello-write (proxy escrita)   │
       └──────────┬────────────────────────┘
                  │ HTTPS + API key
                  ▼
       ┌──────────────────────────────────┐
       │ Trello API + GitHub API (gh CLI)  │
       └──────────────────────────────────┘
```

Auto-refresh via GitHub Actions (cron a cada 30min) regenera `data/*.json` no repo, Netlify re-deploya.

---

## 🛠️ Customização

### `config.json` — tudo numa só fonte

```json
{
  "project": {
    "name": "Meu Projeto",
    "icon": "🎯",
    "trelloBoardId": "abc12345",
    "githubRepos": [{ "name": "api", "full": "minha-org/api" }]
  },
  "team": [
    { "name": "Dev1", "trelloName": "Dev 1", "githubLogin": "dev1", "color": "#58a6ff", ... }
  ],
  "epics": {
    "INFRA": { "name": "Infraestrutura", "priority": "P0", "icon": "🛡️" }
  }
}
```

### Adicionar uma nova action de escrita

Em `netlify/functions/trello-write.js`:

```js
const handlers = {
  // ... existentes
  async minhaAcao(d) {
    return trelloRequest('POST', '/...', { ... });
  },
};
```

E chama do client com `trelloWrite('minhaAcao', { ... })`.

---

## 📦 Estrutura

```
trello-command-center/
├── index.html             # UI
├── app.js                 # Render client-side (router, modal, kanban, etc.)
├── style.css              # Visual (dark theme)
├── config.example.json    # Copiar pra config.json e editar
├── .env.example           # Copiar pra .env e editar (segredos Trello)
├── refresh.js             # Pipeline: Trello API → derived.json
├── trello-api.js          # Cliente API Trello
├── gh-sync.js             # Sync com GitHub via gh CLI
├── netlify.toml           # Config deploy
├── netlify/functions/
│   ├── trello-write.js    # Endpoints de escrita
│   └── trello-snapshot.js # Read live do Trello
├── docs/                  # 13 templates de documentação estruturada
└── data/                  # Gerado pelo refresh
    ├── board.json
    ├── derived.json
    └── github.json
```

---

## 🔒 Segurança

- Token Trello **nunca** vai pro client — fica em env var do Netlify
- Escrita protegida por secret compartilhado pelo time (header `X-TCC-Secret`)
- Repo pode ser **privado** (Netlify suporta deploy de repos privados)
- Site pode ser público (read-only) ou protegido com Netlify Identity / Cloudflare Access

---

## 📜 Licença

MIT — use, modifique, fork à vontade.

---

## 🙏 Inspiração

Template baseado no padrão de documentação estruturada da Amanda (GoHosp/GoCare healthcare).

Construído como portfolio + ferramenta interna.

Exemplo de uso real em uma instância privada (config-driven).

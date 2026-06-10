# Setup — Trello Command Center

Guia passo-a-passo pra colocar o dashboard rodando pro seu projeto. **Tempo total: ~10 min.**

---

## Pré-requisitos

- **Node.js 20+** instalado
- **gh CLI** autenticado (`gh auth login`) — pra puxar PRs do GitHub
- Conta **Trello** com acesso ao board que você quer monitorar
- Conta **Netlify** (free) — pra deploy
- Conta **GitHub** — pra hospedar o código

---

## Passo 1 — Clonar e configurar

```bash
git clone <este-repo> meu-command-center
cd meu-command-center

cp config.example.json config.json
cp .env.example .env
```

### Edite `config.json`

```json
{
  "project": {
    "name": "Meu Projeto",
    "tagline": "Command Center",
    "icon": "🎯",
    "trelloBoardId": "ABC12345",                          // ← short ID do board (8 chars)
    "trelloBoardUrl": "https://trello.com/b/ABC12345/...",
    "githubOrg": "minha-org",
    "githubRepos": [
      { "name": "api", "full": "minha-org/projeto-api" },
      { "name": "web", "full": "minha-org/projeto-web" }
    ],
    "columns": {                                          // ← OPCIONAL: role → listas reais do SEU board
      "doing":   { "label": "Em andamento", "match": ["In Progress", "Doing"] },
      "review":  { "label": "Review",       "match": ["Testing", "QA"] },
      "blocked": { "label": "Bloqueado",    "match": ["Blocked"] },
      "done":    { "label": "Concluído",    "match": ["Done", "Deployed"] }
    },                                                    //   sem isso, detecta por heurística; role sem lista some
    "wipLimit": 2,                                        // ← limite de "em andamento" por pessoa (opcional)
    "docsRepo": "owner/repo",                             // ← repo das docs ('Editar no GitHub'); vazio esconde o link
    "repoPrefix": "projeto-"                              // ← prefixo a esconder no nome dos repos (opcional)
  },
  "team": [
    {
      "id": "manual:fulano",
      "name": "Fulano da Silva",
      "role": "Dev",
      "emoji": "👨‍💻",
      "color": "#58a6ff",
      "trelloName": "Fulano da Silva",                    // ← exato como aparece no Trello
      "githubLogin": "fulano"                             // ← exato como aparece no GitHub
    }
  ],
  "epics": {
    "INFRA": { "name": "Infraestrutura", "priority": "P0", "icon": "🛡️", "color": "#ff8a3d" }
    // adicione seus EPICs (prefixos do título dos cards Trello)
  }
}
```

**Onde achar o board ID:** abre teu Trello no browser → URL é `trello.com/b/<board_id>/<nome>` → o `<board_id>` é a parte após `/b/`.

---

## Passo 2 — Gerar credenciais Trello

### 2.1 Criar Power-Up (necessário pra ter API Key)

1. Vai em https://trello.com/power-ups/admin
2. Se aparecer "você não é membro de uma área de trabalho":
   - Cria um **workspace pessoal** em https://trello.com/ → "+ Workspace"
   - Volta em `/power-ups/admin`
3. **Criar novo Power-Up** com qualquer nome
4. Aba **API Key** → copia a **API Key** (32 chars hex)

### 2.2 Gerar Token

Cole no browser (substitua `SUA_KEY`):

```
https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=Command+Center&key=SUA_KEY
```

Click **Allow** → copia o **token** (começa com `ATTA...`)

### 2.3 Edite `.env`

```
TRELLO_KEY=sua_api_key_aqui
TRELLO_TOKEN=ATTAseu_token_aqui
TRELLO_BOARD_ID=ABC12345
TCC_DASH_SECRET=mude-esta-senha-pra-uma-forte
```

> O `TCC_DASH_SECRET` é o que você compartilha com o time pra eles editarem cards. Qualquer string forte serve (16+ chars).

---

## Passo 3 — Rodar local

```bash
node refresh.js               # puxa Trello + GitHub → gera data/*.json
npx serve -l 8000 .           # abre http://localhost:8000
```

Recarrega o browser. Modal "Quem é você?" aparece → escolhe → vê dashboard.

> ⚠️ Quick add / drag não funciona local (precisa Netlify Functions). Pra desenvolvimento full-stack local, instala Netlify CLI: `npm i -g netlify-cli` e roda `netlify dev`.

---

## Passo 4 — Push pra GitHub

```bash
git init -b main
git add .
git commit -m "initial command center"

# Cria repo (privado é melhor)
gh repo create meu-command-center --private --source=. --push
```

---

## Passo 5 — Deploy no Netlify

### 5.1 Importar repo

1. https://app.netlify.com/start
2. **Import from Git** → autoriza GitHub
3. Procura `meu-command-center` → Deploy

Configurações via `netlify.toml` ✅ automático.

### 5.2 Adicionar env vars

No painel Netlify → **Site configuration → Environment variables → Add a variable**:

| Key | Value |
|---|---|
| `TRELLO_KEY` | (copia do .env) |
| `TRELLO_TOKEN` | (copia do .env) |
| `TRELLO_BOARD_ID` | (copia do .env) |
| `TCC_DASH_SECRET` | (copia do .env) |

### 5.3 Re-deploy

**Deploys → Trigger deploy → Deploy site** pra pegar as env vars.

URL final: `https://random-name.netlify.app` — você pode renomear em **Site settings → Change site name**.

---

## Passo 6 — Auto-refresh via GitHub Actions

O workflow `.github/workflows/auto-refresh.yml` roda a cada 30min. Pra funcionar precisa configurar **secrets do GitHub**:

```bash
gh secret set TRELLO_KEY --body "sua_key"
gh secret set TRELLO_TOKEN --body "ATTA..."
gh secret set TRELLO_BOARD_ID --body "ABC12345"
gh secret set GH_PAT --body "ghp_seu_personal_access_token"
```

> `GH_PAT`: gera em https://github.com/settings/tokens com scope `repo` (ou granular pros teus repos específicos).

Trigger manual:
```bash
gh workflow run auto-refresh.yml
```

---

## Passo 7 — Compartilhar com o time

Manda no grupo:

```
🎯 [Nome do Projeto] Command Center

Link: https://meu-projeto.netlify.app

Pra adicionar/editar cards, cole este secret quando o site pedir:
[seu TCC_DASH_SECRET]

Atalhos:
- Ctrl+N → novo card
- Ctrl+R → atualizar
- /  → busca global
```

---

## Troubleshooting

| Problema | Solução |
|---|---|
| "config.json não encontrado" | `cp config.example.json config.json` e edita |
| "invalid key" no Trello | Confirma que a Key é do Power-Up, não Token. Token tem 64 chars `ATTA...` |
| Card não move (drag) | Salvou o secret? Click no FAB "+" e cola |
| Function 401 | Secret no header `X-TCC-Secret` não bate com `TCC_DASH_SECRET` no Netlify |
| Function 500 | Confere logs em Netlify → Functions → Logs |
| Auto-refresh não roda | GitHub Actions billing? Confere `gh run list` |

---

## Próximos passos (opcionais)

- Editar os 13 docs em `docs/` substituindo placeholders
- Customizar paleta de cores em `style.css` (`:root` no topo)
- Adicionar handlers customizados em `trello-write.js`
- Configurar `notes.md` com tuas notas executivas

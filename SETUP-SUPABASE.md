# Setup do Modo Nativo (Supabase) — Fase 1

O Command Center agora tem um **modelo próprio** de cards (multi-projeto, kanban
nativo), persistido no **Supabase** (Postgres + Realtime, tier grátis).

> Sem o bloco `supabase` no `config.json`, o app continua funcionando no **modo
> Trello legado** — nada quebra. Este guia ativa o modo nativo.

---

## 1. Criar o projeto Supabase (grátis, ~2 min)

1. Acesse <https://supabase.com> → **Start your project** → entre com GitHub.
2. **New project** → escolha um nome (ex: `command-center`), defina uma senha de
   banco (guarde-a) e a região mais próxima (ex: South America / São Paulo).
3. Espere ~1 min provisionar.

## 2. Rodar o schema

1. No painel do projeto → menu lateral **SQL Editor** → **New query**.
2. Cole **todo** o conteúdo de [`db/schema.sql`](db/schema.sql) e clique **Run**.
3. Deve aparecer `Success. No rows returned`. (É idempotente — pode rodar de novo.)

## 3. Pegar as chaves

No painel → **Project Settings** (engrenagem) → **API**:

- **Project URL** → ex: `https://abcdxyz.supabase.co`
- **Project API keys → `anon` `public`** → uma string longa começando com `eyJ...`

> A `anon key` é pública por design (fica no front). Na Fase 1 a segurança é
> permissiva (ferramenta pessoal). A Fase 2 adiciona Supabase Auth + RLS por usuário.

## 4. Colar no `config.json`

```jsonc
{
  "supabase": {
    "url": "https://abcdxyz.supabase.co",
    "anonKey": "eyJhbGciOiJI...sua-anon-key..."
  },
  "project": { "name": "o projeto", "tagline": "Command Center", "icon": "🎯" }
  // ...resto do config
}
```

No Netlify, garanta que o `config.json` está publicado (ele é servido como estático).

## 5. Criar o primeiro projeto e importar o board

1. Abra o app. No topo do sidebar aparece o **seletor de projeto** (`＋` e `⬇️ Trello`).
2. Se ainda não houver projeto, clique **＋** → dê um nome (ex: "o projeto"). A página recarrega.
3. Clique **⬇️ Trello** → confirma → ele lê o board atual (via `trello-snapshot`) e
   **semeia colunas, membros, labels e cards nativos**, preservando os números `#NNN`.
4. Pronto: agora os cards são **seus**. Drag-and-drop, edição, checklists, comentários
   e anexos gravam no Supabase. O sync entre máquinas passa a ser **em tempo real**
   (substitui o polling de 30s).

---

## O que muda por baixo

| | Antes (Trello) | Agora (nativo) |
|---|---|---|
| Dono dos cards | Trello | **Supabase (seu)** |
| Projetos | 1 (hardcoded) | **N (seletor)** |
| Sync | polling 30s | **realtime** |
| Diferenciais | — | WIP limit, dependências, campos custom, saved views (schema pronto p/ Fase 2) |

## Troubleshooting

- **App abriu em modo Trello?** O bloco `supabase` está vazio/`REPLACE_ME`, ou o
  `config.json` não foi publicado. Confira o console: `[CC] ...`.
- **Erro de permissão (RLS)?** O passo 2 (schema) não rodou completo — rode de novo.
- **Importou duplicado?** Cada clique em "⬇️ Trello" reimporta. Apague os cards do
  projeto no SQL Editor (`delete from cards where project_id = '...'`) e reimporte.

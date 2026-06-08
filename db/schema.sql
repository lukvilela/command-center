-- ============================================================================
--  Command Center — schema do modelo próprio (Supabase / Postgres)
--  Fase 1: Fundação. Cards são NOSSOS (não do Trello). Connectors sincronizam
--  fontes externas (GitHub/GitLab/Trello) para dentro deste modelo.
--
--  Como usar: cole TODO este arquivo no SQL Editor do seu projeto Supabase
--  e rode (Run). Idempotente — pode rodar de novo sem quebrar.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- PROJECTS — a "casca". Cada projeto absorve um conjunto de fontes.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  tagline     text default 'Command Center',
  icon        text default '🎯',
  settings    jsonb not null default '{}'::jsonb,  -- epics, personasByEpic, feature flags
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- SOURCES — fontes conectadas a um projeto (o que ele "absorve").
-- type: github_repo | github_project | gitlab_project | trello_board | git | website
-- config guarda o que cada fonte precisa: {owner,repo} / {boardId} / {url} ...
-- ---------------------------------------------------------------------------
create table if not exists sources (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  type            text not null check (type in
                    ('github_repo','github_project','gitlab_project','trello_board','git','website')),
  display_name    text not null,
  config          jsonb not null default '{}'::jsonb,
  sync_enabled    boolean not null default true,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_sources_project on sources(project_id);

-- ---------------------------------------------------------------------------
-- MEMBERS — time do projeto (mapeia identidades por fonte).
-- ---------------------------------------------------------------------------
create table if not exists members (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  name            text not null,
  role            text default 'Dev',
  emoji           text default '👤',
  color           text default '#58a6ff',
  trello_name     text,
  github_login    text,
  gitlab_username text,
  is_guest        boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists idx_members_project on members(project_id);

-- ---------------------------------------------------------------------------
-- LISTS — colunas do kanban NATIVO. Aqui mora a superioridade:
-- wip_limit (limite de cards), is_done (coluna de conclusão p/ automações).
-- ---------------------------------------------------------------------------
create table if not exists lists (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  position    double precision not null default 1000,
  wip_limit   int,                                   -- null = sem limite
  is_done     boolean not null default false,
  color       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_lists_project on lists(project_id, position);

-- ---------------------------------------------------------------------------
-- CARDS — o modelo próprio. Rastreia origem externa p/ sync 2-vias.
-- position: fractional indexing (insere entre dois sem renumerar tudo).
-- fields: campos customizados (jsonb). external_*: vínculo com a fonte.
-- ---------------------------------------------------------------------------
create table if not exists cards (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects(id) on delete cascade,
  list_id       uuid references lists(id) on delete set null,
  seq           integer,              -- "#NNN" curto por projeto (preserva idShort do Trello na importação)
  title         text not null,
  body          text default '',
  position      double precision not null default 1000,
  epic          text,
  priority      text check (priority in ('P0','P1','P2','P3') or priority is null),
  due_at        timestamptz,
  cover         text,
  archived      boolean not null default false,
  fields        jsonb not null default '{}'::jsonb,
  -- origem (quando importado/sincronizado de uma fonte):
  source_id     uuid references sources(id) on delete set null,
  external_kind text,                 -- trello_card | github_issue | github_pr | gitlab_issue ...
  external_id   text,                 -- id na fonte
  external_url  text,
  external_raw  jsonb,                 -- snapshot bruto da fonte (p/ diffs no sync)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_cards_project on cards(project_id, archived);
create index if not exists idx_cards_list on cards(list_id, position);
create unique index if not exists idx_cards_external
  on cards(source_id, external_kind, external_id)
  where source_id is not null and external_id is not null;
create index if not exists idx_cards_seq on cards(project_id, seq);

-- ---------------------------------------------------------------------------
-- LABELS + junção
-- ---------------------------------------------------------------------------
create table if not exists labels (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  color       text default '#6e7681'
);
create index if not exists idx_labels_project on labels(project_id);

create table if not exists card_labels (
  card_id   uuid not null references cards(id) on delete cascade,
  label_id  uuid not null references labels(id) on delete cascade,
  primary key (card_id, label_id)
);

-- ---------------------------------------------------------------------------
-- ASSIGNEES (card ↔ member)
-- ---------------------------------------------------------------------------
create table if not exists card_members (
  card_id    uuid not null references cards(id) on delete cascade,
  member_id  uuid not null references members(id) on delete cascade,
  primary key (card_id, member_id)
);

-- ---------------------------------------------------------------------------
-- CHECKLISTS + items
-- ---------------------------------------------------------------------------
create table if not exists checklists (
  id        uuid primary key default gen_random_uuid(),
  card_id   uuid not null references cards(id) on delete cascade,
  title     text not null default 'Checklist',
  position  double precision not null default 1000
);
create index if not exists idx_checklists_card on checklists(card_id);

create table if not exists checklist_items (
  id            uuid primary key default gen_random_uuid(),
  checklist_id  uuid not null references checklists(id) on delete cascade,
  text          text not null,
  done          boolean not null default false,
  position      double precision not null default 1000
);
create index if not exists idx_checklist_items on checklist_items(checklist_id, position);

-- ---------------------------------------------------------------------------
-- COMMENTS
-- ---------------------------------------------------------------------------
create table if not exists comments (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references cards(id) on delete cascade,
  member_id   uuid references members(id) on delete set null,
  author_name text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_comments_card on comments(card_id, created_at);

-- ---------------------------------------------------------------------------
-- DEPENDENCIES — diferencial sobre o Trello: dependências entre cards.
-- kind: blocks | relates | duplicates
-- ---------------------------------------------------------------------------
create table if not exists card_dependencies (
  id                  uuid primary key default gen_random_uuid(),
  card_id             uuid not null references cards(id) on delete cascade,
  depends_on_card_id  uuid not null references cards(id) on delete cascade,
  kind                text not null default 'blocks' check (kind in ('blocks','relates','duplicates')),
  check (card_id <> depends_on_card_id),
  unique (card_id, depends_on_card_id, kind)
);
create index if not exists idx_deps_card on card_dependencies(card_id);

-- ---------------------------------------------------------------------------
-- ATTACHMENTS + EXTERNAL REFS (PRs, commits, issues, pipelines vinculados)
-- ---------------------------------------------------------------------------
create table if not exists attachments (
  id        uuid primary key default gen_random_uuid(),
  card_id   uuid not null references cards(id) on delete cascade,
  name      text,
  url       text not null,
  kind      text default 'link',     -- link | image | cover
  created_at timestamptz not null default now()
);
create index if not exists idx_attachments_card on attachments(card_id);

create table if not exists external_refs (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references cards(id) on delete cascade,
  source_id   uuid references sources(id) on delete set null,
  kind        text not null,          -- pr | issue | commit | mr | pipeline | run
  ref_id      text not null,
  title       text,
  url         text,
  state       text,                   -- open | merged | closed | success | failed ...
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_extrefs_card on external_refs(card_id);

-- ---------------------------------------------------------------------------
-- SAVED VIEWS — filtros/visões salvas por projeto (diferencial sobre o Trello).
-- ---------------------------------------------------------------------------
create table if not exists saved_views (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  config      jsonb not null default '{}'::jsonb,  -- filtros, agrupamento, swimlane
  created_at  timestamptz not null default now()
);
create index if not exists idx_views_project on saved_views(project_id);

-- ---------------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------------
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists trg_projects_touch on projects;
create trigger trg_projects_touch before update on projects
  for each row execute function touch_updated_at();

drop trigger if exists trg_cards_touch on cards;
create trigger trg_cards_touch before update on cards
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- REALTIME — habilita sync em tempo real (substitui o polling de 30s).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['projects','lists','cards','card_members','card_labels',
                           'checklists','checklist_items','comments','card_dependencies',
                           'attachments','external_refs','labels','members','sources']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — Fase 1: ferramenta pessoal, política permissiva p/ a anon key.
--  ⚠️  A anon key fica exposta no front (é assim no Supabase). Em Fase 2
--      trocamos por Supabase Auth + políticas por usuário/projeto.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['projects','sources','members','lists','cards','labels',
                           'card_labels','card_members','checklists','checklist_items',
                           'comments','card_dependencies','attachments','external_refs','saved_views']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "cc_all" on %I', t);
    execute format('create policy "cc_all" on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

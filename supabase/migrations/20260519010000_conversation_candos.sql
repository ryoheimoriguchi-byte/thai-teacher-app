-- Step C3: can-do 判定・ミッション
--
-- user_candos … can-do ごとの進捗（word_progress と同型: 連続成功数 + 達成フラグ）
-- conversation_sessions.mission_cando_ids … そのセッションで提示したミッション（can-do id の配列）
--
-- 実行しない。Ryo が Supabase で実行してから push する。

create table if not exists public.user_candos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  language text not null default 'JP',
  cando_id text not null,
  consecutive_success integer not null default 0,
  achieved boolean not null default false,
  achieved_at timestamptz,
  last_practiced timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint user_candos_unique unique (user_id, language, cando_id)
);

create index if not exists idx_user_candos_user
  on public.user_candos (user_id, language);

-- セッションで提示したミッション（can-do id の配列。freetalk は常に空配列）
alter table public.conversation_sessions
  add column if not exists mission_cando_ids jsonb not null default '[]'::jsonb;

-- RLS: conversation_sessions と同じパターン（操作ごとに 4本、using(true) / with check(true)）
alter table public.user_candos enable row level security;

create policy "user_candos_select" on public.user_candos
  for select using (true);

create policy "user_candos_insert" on public.user_candos
  for insert with check (true);

create policy "user_candos_update" on public.user_candos
  for update using (true) with check (true);

create policy "user_candos_delete" on public.user_candos
  for delete using (true);

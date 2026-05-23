-- Achievement Badge テーブル
create table if not exists public.user_badges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete cascade not null,
  module       text not null,            -- 'listening' / 'speaking-word' / 'speaking-sentence' / 'reading_word' / 'sentence'
  category     text not null,            -- 'Animals', 'Food', 'Family' 等
  threshold    integer not null,         -- 10, 20, 30...（累計語数の閾値）
  earned_at    timestamptz not null default now(),
  viewed_at    timestamptz,              -- 未閲覧の場合 null
  unique (user_id, module, category, threshold)
);

-- インデックス
create index if not exists idx_user_badges_user on public.user_badges(user_id);
create index if not exists idx_user_badges_unviewed on public.user_badges(user_id, viewed_at) where viewed_at is null;

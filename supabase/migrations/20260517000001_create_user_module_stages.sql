-- Create user_module_stages table
create table if not exists public.user_module_stages (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.users(id) on delete cascade,
  language      text not null,
  module        text not null,
  current_stage integer not null default 1,
  updated_at    timestamptz not null default now(),
  unique (user_id, language, module)
);

-- Module values:
-- 'listening'           (Listening word-to-en + en-to-word 両方)
-- 'sentence'            (Sentence Listening)
-- 'speaking-word'       (Speaking Word mode)
-- 'speaking-sentence'   (Speaking Sentence mode)
-- 'reading_word'        (Reading Word mode)
-- 'reading_character'   (Reading Character mode: 1=hiragana, 2=katakana)

-- Initialize existing users
-- For each user × language × module:
--   If mastered count / total Stage 1 words >= 0.9 → current_stage = 2
--   Otherwise → current_stage = 1
-- Note: At this point all words are Stage 1, so Stage 2 won't be triggered yet.
-- This INSERT sets everyone to stage 1 as safe default.
-- (Auto-calculation will be added in application logic)

insert into public.user_module_stages
  (user_id, language, module, current_stage)
select
  u.id as user_id,
  lang.language,
  mod.module,
  1 as current_stage
from public.users u
cross join (values ('JP'), ('TH')) as lang(language)
cross join (values
  ('listening'),
  ('sentence'),
  ('speaking-word'),
  ('speaking-sentence'),
  ('reading_word'),
  ('reading_character')
) as mod(module)
on conflict (user_id, language, module) do nothing;

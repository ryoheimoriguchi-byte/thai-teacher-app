-- Add stage column to cards
alter table public.cards
  add column if not exists stage integer not null default 1;

-- All existing words are Stage 1
update public.cards set stage = 1 where type = 'word';

-- Characters (hiragana/katakana) are also Stage 1
update public.cards set stage = 1 where type = 'character';

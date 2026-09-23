-- Step C4.2 + C5: ラリー数制セッション + Show English を「助け」として扱う
--
-- 実行しない。Ryo が Supabase で実行してから push する。
-- (2026-09-23 時点で Ryo が word-card-app プロジェクトに既に適用済み。
--  このファイルはリポジトリへの記録用。)

alter table public.conversation_turns
  add column if not exists translation_shown boolean not null default false;

alter table public.conversation_sessions
  add column if not exists planned_turns integer;

-- 既存データ: translation_shown = false, planned_turns = null のまま。
-- planned_turns が null のセッションは時間ベースとして扱う（過去セッションの
-- 判定には影響させない）。

-- Conversation: per-turn scoring-design flags.
--
-- support_given    … このターンで先生が生徒に与えた支援の強さ
--                     ("none" | "repeat" | "rephrase" | "options" | "english" ほか)
-- response_quality … 直前の生徒の発話が問いかけにどう応答できたか
--                     ("answered" | "partial" | "no_answer" | "english" ほか、
--                      最初のターンでは null)
--
-- Cambridge YLE の Interaction 観点に相当するデータをターン単位で貯め始めるための列。
-- 値の種類が今後増える可能性があるため、CHECK 制約や enum 型は付けない（text のまま）。
alter table public.conversation_turns
  add column if not exists support_given text,
  add column if not exists response_quality text;

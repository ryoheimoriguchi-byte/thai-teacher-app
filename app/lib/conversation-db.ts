import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchAllWordProgress } from "./word-progress";

/**
 * Conversation 機能の DB アクセス層。
 * 列名は supabase/migrations (Step A: conversation_sessions / conversation_turns) に厳密に合わせる。
 */

export function getSupabaseClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export type ConversationSessionStatus = "active" | "completed" | "abandoned";

export type ConversationSessionRow = {
  id: string;
  user_id: string;
  language: string;
  scenario_id: string;
  planned_duration_sec: number;
  actual_duration_sec: number | null;
  speaking_ms: number;
  turn_count: number;
  status: ConversationSessionStatus;
  reviewed: boolean;
  feedback_positive: string | null;
  feedback_improvement: string | null;
  highlight: string | null;
  /** そのセッションで提示した can-do ミッションの id 配列（Step C3）。freetalk は常に []。 */
  mission_cando_ids: string[];
  started_at: string;
  ended_at: string | null;
  created_at: string;
};

export type UserCandoRow = {
  id: string;
  user_id: string;
  language: string;
  cando_id: string;
  consecutive_success: number;
  achieved: boolean;
  achieved_at: string | null;
  last_practiced: string | null;
  updated_at: string;
  created_at: string;
};

export type ConversationScores = {
  vocab: number;
  grammar: number;
  fluency: number;
};

export type ConversationTurnRow = {
  id: string;
  session_id: string;
  user_id: string;
  turn_index: number;
  tutor_text: string;
  tutor_text_en: string | null;
  transcript: string | null;
  recording_ms: number | null;
  char_count: number | null;
  scores: ConversationScores | null;
  phrases_used: string[];
  vocab_used: string[];
  bonus_words: string[];
  /** このターンで先生が生徒に与えた支援の強さ（記録用、UI非表示）。値は今後増える可能性があるため text のまま。 */
  support_given: string | null;
  /** 直前の生徒の発話が問いかけにどう応答できたか（記録用、UI非表示）。最初のターンは null。 */
  response_quality: string | null;
  created_at: string;
};

/* ------------------------------------------------------------------ */
/* users / cards 由来のヘルパー                                        */
/* ------------------------------------------------------------------ */

export async function getStudentName(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("users")
    .select("name")
    .eq("id", userId)
    .single();

  if (error) throw error;
  return data?.name ?? "きみ";
}

/**
 * 該当言語・stage<=2 の単語のうち、そのユーザーが（どのモジュールでも）
 * mastered=true にした語の cards.word 一覧を返す。
 * 毎ターン DB から取り直す想定（セッション中はキャッシュしない。
 * Vercel のサーバーレス環境ではプロセスが毎回別インスタンスになり得るため、
 * in-memory キャッシュは動作が不安定になるリスクがあり見送っている）。
 *
 * @param categories 指定すると cards.category をこの一覧に絞り込む（input tokens 削減用）。
 *   未指定なら全カテゴリ。シナリオごとの絞り込みは
 *   conversation-scenarios.ts の ConversationScenario.vocabCategories で管理する。
 */
export async function fetchMasteredWords(
  supabase: SupabaseClient,
  userId: string,
  language: string,
  categories?: string[]
): Promise<string[]> {
  let query = supabase
    .from("cards")
    .select("id, word")
    .eq("language", language)
    .eq("type", "word")
    .lte("stage", 2);

  if (categories && categories.length > 0) {
    query = query.in("category", categories);
  }

  const { data: cards, error: cardsError } = await query;

  if (cardsError) throw cardsError;
  if (!cards || cards.length === 0) return [];

  // fetchAllWordProgress は PostgREST の 1,000行制限をページネーションで回避する
  const progress = await fetchAllWordProgress(supabase, userId);
  const masteredCardIds = new Set(
    progress.filter((p) => p.mastered).map((p) => p.card_id)
  );

  return cards
    .filter((c) => masteredCardIds.has(c.id))
    .map((c) => c.word as string);
}

/* ------------------------------------------------------------------ */
/* conversation_sessions                                              */
/* ------------------------------------------------------------------ */

export async function createConversationSession(
  supabase: SupabaseClient,
  params: {
    userId: string;
    language: string;
    scenarioId: string;
    plannedDurationSec: number;
    /** Step C3: このセッションで提示する can-do ミッション。freetalk では [] を渡す。 */
    missionCandoIds?: string[];
  }
): Promise<ConversationSessionRow> {
  const { data, error } = await supabase
    .from("conversation_sessions")
    .insert({
      user_id: params.userId,
      language: params.language,
      scenario_id: params.scenarioId,
      planned_duration_sec: params.plannedDurationSec,
      mission_cando_ids: params.missionCandoIds ?? [],
    })
    .select()
    .single();

  if (error) throw error;
  return data as ConversationSessionRow;
}

export async function getConversationSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<ConversationSessionRow | null> {
  const { data, error } = await supabase
    .from("conversation_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw error;
  return (data as ConversationSessionRow) ?? null;
}

export async function updateSessionProgress(
  supabase: SupabaseClient,
  sessionId: string,
  params: { turnCount: number; speakingMs: number }
): Promise<void> {
  const { error } = await supabase
    .from("conversation_sessions")
    .update({
      turn_count: params.turnCount,
      speaking_ms: params.speakingMs,
    })
    .eq("id", sessionId);

  if (error) throw error;
}

export async function completeConversationSession(
  supabase: SupabaseClient,
  sessionId: string,
  params: { actualDurationSec: number | null }
): Promise<void> {
  const { error } = await supabase
    .from("conversation_sessions")
    .update({
      status: "completed",
      ended_at: new Date().toISOString(),
      actual_duration_sec: params.actualDurationSec,
    })
    .eq("id", sessionId);

  if (error) throw error;
}

/**
 * Step C3: 場面説明画面 [2] から「← Choose a different topic」で戻った際に呼ぶ。
 * ミッションが選定済み（mission_cando_ids が非空になり得る）のに 0ターンで終わる
 * セッションが active のまま溜まると、can-do 判定の対象として拾われた場合に
 * 「機会がなかったのにリセットされる」誤判定を招くため、明示的に abandoned にする。
 * 冪等（既に active でなくなっていても無害な update）。
 */
export async function abandonConversationSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<void> {
  const { error } = await supabase
    .from("conversation_sessions")
    .update({
      status: "abandoned",
      ended_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .eq("status", "active"); // 既に completed/abandoned なら上書きしない

  if (error) throw error;
}

export async function finalizeSessionReview(
  supabase: SupabaseClient,
  sessionId: string,
  params: {
    feedbackPositive: string;
    feedbackImprovement: string;
    highlight: string;
  }
): Promise<void> {
  const { error } = await supabase
    .from("conversation_sessions")
    .update({
      feedback_positive: params.feedbackPositive,
      feedback_improvement: params.feedbackImprovement,
      highlight: params.highlight,
      reviewed: true,
    })
    .eq("id", sessionId);

  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* conversation_turns                                                 */
/* ------------------------------------------------------------------ */

export async function fetchConversationTurns(
  supabase: SupabaseClient,
  sessionId: string
): Promise<ConversationTurnRow[]> {
  const { data, error } = await supabase
    .from("conversation_turns")
    .select("*")
    .eq("session_id", sessionId)
    .order("turn_index", { ascending: true });

  if (error) throw error;
  return (data as ConversationTurnRow[]) ?? [];
}

export async function insertConversationTurn(
  supabase: SupabaseClient,
  params: {
    sessionId: string;
    userId: string;
    turnIndex: number;
    tutorText: string;
    tutorTextEn: string | null;
    /** 記録用（UI非表示）。省略時は null（値の種類が増える可能性があるため制約なし）。 */
    supportGiven?: string | null;
    /** 記録用（UI非表示）。最初のターンは常に null。 */
    responseQuality?: string | null;
  }
): Promise<ConversationTurnRow> {
  const { data, error } = await supabase
    .from("conversation_turns")
    .insert({
      session_id: params.sessionId,
      user_id: params.userId,
      turn_index: params.turnIndex,
      tutor_text: params.tutorText,
      tutor_text_en: params.tutorTextEn,
      support_given: params.supportGiven ?? null,
      response_quality: params.responseQuality ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ConversationTurnRow;
}

export async function updateTurnTranscript(
  supabase: SupabaseClient,
  turnId: string,
  params: {
    transcript: string;
    recordingMs: number | null;
    charCount: number;
  }
): Promise<void> {
  const { error } = await supabase
    .from("conversation_turns")
    .update({
      transcript: params.transcript,
      recording_ms: params.recordingMs,
      char_count: params.charCount,
    })
    .eq("id", turnId);

  if (error) throw error;
}

/**
 * Fix 2 (2026-09-19, mis-send undo): deletes a turn row outright. Used to
 * remove the tutor reply that was generated in response to the exchange
 * being undone.
 */
export async function deleteConversationTurn(
  supabase: SupabaseClient,
  turnId: string
): Promise<void> {
  const { error } = await supabase.from("conversation_turns").delete().eq("id", turnId);
  if (error) throw error;
}

/**
 * Fix 2 (2026-09-19, mis-send undo): resets a turn back to "open" (as if
 * the student had never replied to it yet) — the same shape a turn has
 * right after insertConversationTurn, before updateTurnTranscript /
 * updateTurnScoring ever ran on it.
 */
export async function resetTurnToOpen(
  supabase: SupabaseClient,
  turnId: string
): Promise<void> {
  const { error } = await supabase
    .from("conversation_turns")
    .update({
      transcript: null,
      recording_ms: null,
      char_count: null,
      scores: null,
      phrases_used: [],
      vocab_used: [],
      bonus_words: [],
    })
    .eq("id", turnId);

  if (error) throw error;
}

export async function updateTurnScoring(
  supabase: SupabaseClient,
  turnId: string,
  params: {
    scores: ConversationScores;
    phrasesUsed: string[];
    vocabUsed: string[];
    bonusWords: string[];
  }
): Promise<void> {
  const { error } = await supabase
    .from("conversation_turns")
    .update({
      scores: params.scores,
      phrases_used: params.phrasesUsed,
      vocab_used: params.vocabUsed,
      bonus_words: params.bonusWords,
    })
    .eq("id", turnId);

  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* user_candos / 会話 Stage（Step C3）                                 */
/* ------------------------------------------------------------------ */

export async function fetchUserCandos(
  supabase: SupabaseClient,
  userId: string,
  language: string
): Promise<UserCandoRow[]> {
  const { data, error } = await supabase
    .from("user_candos")
    .select("*")
    .eq("user_id", userId)
    .eq("language", language);

  if (error) throw error;
  return (data as UserCandoRow[]) ?? [];
}

/**
 * word_progress と同じ「都度アップサート」の形。cando_id 単位で
 * consecutive_success / achieved を丸ごと書き換える（差分更新ではない）。
 */
export async function upsertUserCando(
  supabase: SupabaseClient,
  params: {
    userId: string;
    language: string;
    candoId: string;
    consecutiveSuccess: number;
    achieved: boolean;
    achievedAt: string | null;
    lastPracticed: string;
  }
): Promise<void> {
  const { error } = await supabase.from("user_candos").upsert(
    {
      user_id: params.userId,
      language: params.language,
      cando_id: params.candoId,
      consecutive_success: params.consecutiveSuccess,
      achieved: params.achieved,
      achieved_at: params.achievedAt,
      last_practiced: params.lastPracticed,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,language,cando_id" }
  );

  if (error) throw error;
}

const CONVERSATION_STAGE_MODULE = "conversation";

/** module='conversation' の現在の Stage。レコードが無ければ Stage 1 で作成する。 */
export async function getOrCreateConversationStage(
  supabase: SupabaseClient,
  userId: string,
  language: string
): Promise<number> {
  const { data, error } = await supabase
    .from("user_module_stages")
    .select("current_stage")
    .eq("user_id", userId)
    .eq("language", language)
    .eq("module", CONVERSATION_STAGE_MODULE)
    .maybeSingle();

  if (error) throw error;
  if (data) return data.current_stage as number;

  const { data: created, error: insertError } = await supabase
    .from("user_module_stages")
    .insert({
      user_id: userId,
      language,
      module: CONVERSATION_STAGE_MODULE,
      current_stage: 1,
    })
    .select("current_stage")
    .single();

  if (insertError) throw insertError;
  return created.current_stage as number;
}

export async function setConversationStage(
  supabase: SupabaseClient,
  userId: string,
  language: string,
  newStage: number
): Promise<void> {
  const { error } = await supabase
    .from("user_module_stages")
    .update({ current_stage: newStage, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("language", language)
    .eq("module", CONVERSATION_STAGE_MODULE);

  if (error) throw error;
}

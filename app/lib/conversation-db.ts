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
  started_at: string;
  ended_at: string | null;
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
  }
): Promise<ConversationSessionRow> {
  const { data, error } = await supabase
    .from("conversation_sessions")
    .insert({
      user_id: params.userId,
      language: params.language,
      scenario_id: params.scenarioId,
      planned_duration_sec: params.plannedDurationSec,
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

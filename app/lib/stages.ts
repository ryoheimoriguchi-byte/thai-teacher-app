import type { SupabaseClient } from "@supabase/supabase-js";

export const STAGE_MODULES = {
  LISTENING: "listening",
  SENTENCE: "sentence",
  SPEAKING_WORD: "speaking-word",
  SPEAKING_SENTENCE: "speaking-sentence",
  READING_WORD: "reading_word",
  READING_CHARACTER: "reading_character",
} as const;

export type StageModule = (typeof STAGE_MODULES)[keyof typeof STAGE_MODULES];

const EN_TO_WORD_ONLY_MODULES: StageModule[] = [
  STAGE_MODULES.SPEAKING_WORD,
  STAGE_MODULES.READING_WORD,
];

export async function getUserStage(
  supabase: SupabaseClient,
  userId: string,
  language: string,
  module: StageModule
): Promise<number> {
  const { data } = await supabase
    .from("user_module_stages")
    .select("current_stage")
    .eq("user_id", userId)
    .eq("language", language)
    .eq("module", module)
    .single();
  return data?.current_stage ?? 1;
}

export async function checkAndAdvanceStage(
  supabase: SupabaseClient,
  userId: string,
  language: string,
  module: StageModule,
  currentStage: number
): Promise<boolean> {
  let cardIds: string[];
  let totalCount: number;

  if (module === STAGE_MODULES.READING_CHARACTER) {
    if (language !== "JP") return false;
    const characterType = currentStage === 1 ? "hiragana" : "katakana";
    const { data: cards } = await supabase
      .from("cards")
      .select("id")
      .eq("language", "JP")
      .eq("type", "character")
      .eq("character_type", characterType);
    if (!cards || cards.length === 0) return false;
    totalCount = cards.length;
    cardIds = cards.map((c) => c.id);
  } else {
    const { data: cards } = await supabase
      .from("cards")
      .select("id")
      .eq("language", language)
      .eq("type", "word")
      .eq("stage", currentStage);
    if (!cards || cards.length === 0) return false;
    totalCount = cards.length;
    cardIds = cards.map((c) => c.id);
  }

  let masteredCount = 0;

  if (module === STAGE_MODULES.LISTENING) {
    const { data: progress } = await supabase
      .from("word_progress")
      .select("card_id, direction")
      .eq("user_id", userId)
      .eq("module", module)
      .eq("mastered", true)
      .in("card_id", cardIds);

    const masteredByCard = new Map<string, Set<string>>();
    (progress ?? []).forEach((p) => {
      if (!masteredByCard.has(p.card_id)) masteredByCard.set(p.card_id, new Set());
      masteredByCard.get(p.card_id)!.add(p.direction);
    });
    masteredCount = Array.from(masteredByCard.values()).filter(
      (dirs) => dirs.has("word-to-en") && dirs.has("en-to-word")
    ).length;
  } else {
    let query = supabase
      .from("word_progress")
      .select("card_id")
      .eq("user_id", userId)
      .eq("module", module)
      .eq("mastered", true)
      .in("card_id", cardIds);

    if (EN_TO_WORD_ONLY_MODULES.includes(module)) {
      query = query.eq("direction", "en-to-word");
    }

    const { data: progress } = await query;
    const uniqueCards = new Set((progress ?? []).map((p) => p.card_id));
    masteredCount = uniqueCards.size;
  }

  const masteredRate = masteredCount / totalCount;
  if (masteredRate < 0.9) return false;

  const nextStage = currentStage + 1;
  await supabase
    .from("user_module_stages")
    .update({ current_stage: nextStage, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("language", language)
    .eq("module", module);

  return true;
}

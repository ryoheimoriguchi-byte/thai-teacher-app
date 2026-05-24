import type { SupabaseClient } from "@supabase/supabase-js";

// バッジ対象モジュール（5種類、reading_character は除外）
export const BADGE_MODULES = [
  "listening",
  "speaking-word",
  "speaking-sentence",
  "reading_word",
  "sentence",
] as const;

export type BadgeModule = (typeof BADGE_MODULES)[number];

// バッジ判定：あるモジュール・カテゴリで何個のバッジを獲得すべきかを計算
// 累計マスター数を10で割った商が、獲得すべきバッジ数
// 例：23語 master → threshold 10, 20 の2つのバッジ
export async function checkAndAwardBadges(
  supabase: SupabaseClient,
  userId: string,
  language: string,
  module: BadgeModule,
  category: string
): Promise<{ threshold: number; isNew: boolean }[]> {
  if (language !== "JP") return []; // JP のみ対象

  // カテゴリ内のマスター済み語数を取得
  const { data: cards } = await supabase
    .from("cards")
    .select("id")
    .eq("language", "JP")
    .eq("type", "word")
    .eq("category", category);

  if (!cards || cards.length === 0) return [];

  const cardIds = cards.map((c) => c.id);

  // マスター済みカード（重複除去）
  // listening は両方向必要、それ以外は重複除去のみ
  let masteredCount = 0;

  if (module === "listening") {
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
    const { data: progress } = await supabase
      .from("word_progress")
      .select("card_id")
      .eq("user_id", userId)
      .eq("module", module)
      .eq("mastered", true)
      .in("card_id", cardIds);

    const uniqueCards = new Set((progress ?? []).map((p) => p.card_id));
    masteredCount = uniqueCards.size;
  }

  // 獲得すべきバッジ数 = floor(masteredCount / 10)
  const shouldHaveCount = Math.floor(masteredCount / 10);
  if (shouldHaveCount === 0) return [];

  // 既に持っているバッジを取得
  const { data: existing } = await supabase
    .from("user_badges")
    .select("threshold")
    .eq("user_id", userId)
    .eq("module", module)
    .eq("category", category);

  const existingThresholds = new Set((existing ?? []).map((b) => b.threshold));

  // 不足分のバッジを INSERT
  const newBadges: { threshold: number; isNew: boolean }[] = [];
  for (let i = 1; i <= shouldHaveCount; i++) {
    const threshold = i * 10;
    if (!existingThresholds.has(threshold)) {
      const { error } = await supabase.from("user_badges").insert({
        user_id: userId,
        module,
        category,
        threshold,
      });
      if (!error) {
        newBadges.push({ threshold, isNew: true });
      }
    }
  }

  return newBadges;
}

// 未閲覧バッジ数を取得（Home/Nav用）
export async function getUnviewedBadgeCount(
  supabase: SupabaseClient,
  userId: string
): Promise<number> {
  const { count } = await supabase
    .from("user_badges")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("viewed_at", null);
  return count ?? 0;
}

// モジュール別の未閲覧バッジ数（Achievementタブ用）
export async function getUnviewedBadgeCountByModule(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<string, number>> {
  const { data } = await supabase
    .from("user_badges")
    .select("module")
    .eq("user_id", userId)
    .is("viewed_at", null);

  const counts: Record<string, number> = {};
  (data ?? []).forEach((b) => {
    counts[b.module] = (counts[b.module] ?? 0) + 1;
  });
  return counts;
}

// あるモジュールの未閲覧バッジを既読にする
export async function markModuleBadgesAsViewed(
  supabase: SupabaseClient,
  userId: string,
  module: BadgeModule
): Promise<void> {
  await supabase
    .from("user_badges")
    .update({ viewed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("module", module)
    .is("viewed_at", null);
}

// 単一バッジの既読化（モジュール単位の markModuleBadgesAsViewed とは別）
export async function markBadgeAsViewed(
  supabase: SupabaseClient,
  badgeId: string
): Promise<void> {
  await supabase
    .from("user_badges")
    .update({ viewed_at: new Date().toISOString() })
    .eq("id", badgeId)
    .is("viewed_at", null);
}

export function getModuleDisplayLabel(module: string): string {
  const labels: Record<string, string> = {
    listening: "Listening",
    "speaking-word": "Speaking (Word)",
    "speaking-sentence": "Speaking (Sentence)",
    reading_word: "Reading",
    sentence: "Sentence",
  };
  return labels[module] ?? module;
}

// 既存ユーザーの過去の進捗から遡及的にバッジを発行する
// 通知爆発を防ぐため、viewed_at = now() で既読扱い
// 一度だけ実行されることを想定（重複実行しても unique 制約で安全）
export async function backfillBadgesForUser(
  supabase: SupabaseClient,
  userId: string,
  language: string
): Promise<{ totalAwarded: number; byModule: Record<string, number> }> {
  if (language !== "JP") return { totalAwarded: 0, byModule: {} };

  const { data: categories } = await supabase
    .from("cards")
    .select("category")
    .eq("language", "JP")
    .eq("type", "word");

  const uniqueCategories = [...new Set((categories ?? []).map((c) => c.category))];

  const byModule: Record<string, number> = {};
  let totalAwarded = 0;

  for (const module of BADGE_MODULES) {
    let moduleCount = 0;
    for (const category of uniqueCategories) {
      const newBadges = await checkAndAwardBadges(
        supabase,
        userId,
        language,
        module,
        category
      );
      moduleCount += newBadges.length;
    }

    if (moduleCount > 0) {
      await supabase
        .from("user_badges")
        .update({ viewed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("module", module)
        .is("viewed_at", null);
    }

    byModule[module] = moduleCount;
    totalAwarded += moduleCount;
  }

  return { totalAwarded, byModule };
}

export function getBadgeEmoji(category: string, threshold: number): string {
  const tier = Math.ceil(threshold / 10);

  const emojiMap: Record<string, string[]> = {
    Animals: ["🐸", "🐯", "🦁", "🐉", "🦅", "🐺", "🦊", "🐼", "🦄", "🦖"],
    Food: ["🍎", "🍜", "🍱", "🍷", "🍰", "🍣", "🥘", "🍲", "🍤", "🍢"],
    Family: ["👨", "👵", "👶", "👴", "👨‍👩‍👧", "👨‍👩‍👧‍👦", "🤵", "👰", "🧑‍🤝‍🧑", "👯"],
    "Health & Body": ["💪", "🦴", "🧠", "👁️", "👂", "👃", "👄", "🦷", "❤️", "🫀"],
    Colors: ["🎨", "🌈", "🖍️", "🖌️", "🎭", "🪄", "🌸", "🌟", "✨", "💫"],
    "Dates & Time": ["⏰", "📅", "📆", "🕐", "⌛", "⏳", "🌅", "🌇", "🌙", "☀️"],
    Places: ["🏠", "🏫", "🏥", "🏪", "🏯", "🏰", "🗼", "🗽", "🌉", "🗾"],
    Number: ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"],
    Greetings: ["👋", "🙋", "🤝", "🙇", "🙌", "🫂", "💬", "🗣️", "👍", "✋"],
    "Common Verbs": ["⚡", "🔥", "⚔️", "🌟", "👑", "💎", "🏆", "🎯", "🚀", "⭐"],
    "Useful Phrases": ["💬", "🗨️", "🗯️", "💭", "📢", "📣", "🔊", "🎤", "📻", "📺"],
    Adjectives: ["🎯", "✨", "🌈", "⭐", "🌟", "💫", "🌠", "💥", "🎆", "🎇"],
    School: ["📚", "📖", "✏️", "📝", "🎒", "🏫", "👨‍🏫", "🎓", "📐", "📏"],
    Weather: ["☀️", "☁️", "🌧️", "❄️", "🌪️", "🌈", "⛅", "🌤️", "⛈️", "🌨️"],
    Transport: ["🚗", "🚕", "🚌", "🚇", "🚲", "✈️", "🚢", "🚀", "🚊", "🏎️"],
    Clothing: ["👕", "👖", "👗", "👔", "🧥", "🧣", "🧦", "👟", "👒", "🎩"],
    Position: ["⬆️", "⬇️", "⬅️", "➡️", "↗️", "↘️", "↖️", "↙️", "🎯", "📍"],
  };

  const list = emojiMap[category] ?? ["🏆"];
  return list[Math.min(tier - 1, list.length - 1)];
}

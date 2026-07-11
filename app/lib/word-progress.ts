import type { SupabaseClient } from "@supabase/supabase-js";

export type WordProgress = {
  card_id: string;
  module: string;
  direction: string;
  consecutive_correct: number;
  mastered: boolean;
  mastered_at?: string;
};

/**
 * Fetch all word_progress rows for a user, paginating past PostgREST's default 1,000-row limit.
 */
export async function fetchAllWordProgress(
  supabase: SupabaseClient,
  userId: string,
  opts?: { module?: string }
): Promise<WordProgress[]> {
  const pageSize = 1000;
  let from = 0;
  const all: WordProgress[] = [];

  while (true) {
    let query = supabase
      .from("word_progress")
      .select("*")
      .eq("user_id", userId);

    if (opts?.module) {
      query = query.eq("module", opts.module);
    }

    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;

    all.push(...(data as WordProgress[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

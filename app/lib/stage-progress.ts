import type { SupabaseClient } from "@supabase/supabase-js";
import { STAGE_MODULES, type StageModule } from "@/app/lib/stages";

export const HOME_STAGE_ROWS: { label: string; module: StageModule }[] = [
  { label: "Listening", module: STAGE_MODULES.LISTENING },
  { label: "Speaking", module: STAGE_MODULES.SPEAKING_WORD },
  { label: "Reading", module: STAGE_MODULES.READING_WORD },
  { label: "Sentence", module: STAGE_MODULES.SENTENCE },
];

export const STAGE_COLUMN_NUMBERS = [1, 2, 3, 4, 5] as const;

export type WordProgressRow = {
  card_id: string;
  module: string;
  direction: string;
  mastered: boolean;
};

export function countMasteredInStage(
  module: StageModule,
  cardIds: string[],
  wordProgress: WordProgressRow[]
): number {
  if (cardIds.length === 0) return 0;
  const idSet = new Set(cardIds);

  if (module === STAGE_MODULES.LISTENING) {
    const masteredByCard = new Map<string, Set<string>>();
    for (const p of wordProgress) {
      if (p.module !== module || !p.mastered || !idSet.has(p.card_id)) continue;
      if (!masteredByCard.has(p.card_id)) masteredByCard.set(p.card_id, new Set());
      masteredByCard.get(p.card_id)!.add(p.direction);
    }
    return Array.from(masteredByCard.values()).filter(
      (dirs) => dirs.has("word-to-en") && dirs.has("en-to-word")
    ).length;
  }

  const unique = new Set<string>();
  for (const p of wordProgress) {
    if (p.module !== module || !p.mastered || !idSet.has(p.card_id)) continue;
    if (
      module === STAGE_MODULES.SPEAKING_WORD ||
      module === STAGE_MODULES.READING_WORD
    ) {
      if (p.direction !== "en-to-word") continue;
    }
    unique.add(p.card_id);
  }
  return unique.size;
}

export type StageCellDisplay =
  | { kind: "done" }
  | { kind: "locked" }
  | { kind: "progress"; percent: number };

export function getStageCellDisplay(
  stageNum: number,
  currentStage: number,
  mastered: number,
  total: number
): StageCellDisplay {
  if (stageNum < currentStage) return { kind: "done" };
  if (stageNum > currentStage) return { kind: "locked" };
  const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;
  return { kind: "progress", percent };
}

export async function fetchHomeStageData(
  supabase: SupabaseClient,
  userId: string
): Promise<{
  currentByModule: Record<string, number>;
  cardsByStage: Map<number, string[]>;
}> {
  const [{ data: stageRows }, { data: cards }] = await Promise.all([
    supabase
      .from("user_module_stages")
      .select("module, current_stage")
      .eq("user_id", userId)
      .eq("language", "JP"),
    supabase.from("cards").select("id, stage").eq("language", "JP").eq("type", "word"),
  ]);

  const currentByModule: Record<string, number> = {};
  (stageRows ?? []).forEach((r) => {
    currentByModule[r.module] = r.current_stage;
  });

  const cardsByStage = new Map<number, string[]>();
  (cards ?? []).forEach((c) => {
    const s = c.stage ?? 1;
    if (!cardsByStage.has(s)) cardsByStage.set(s, []);
    cardsByStage.get(s)!.push(c.id);
  });

  return { currentByModule, cardsByStage };
}

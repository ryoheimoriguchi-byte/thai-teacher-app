import { NextRequest, NextResponse } from "next/server";
import {
  getSupabaseClient,
  fetchUserCandos,
  getOrCreateConversationStage,
  fetchCompletedConversationSessions,
  fetchConversationTurnsForSessions,
} from "@/app/lib/conversation-db";
import { ALL_CANDOS, STAGE_INFO, computeTurnsAnsweredAloneStats } from "@/app/lib/conversation-candos";
import { toErrorMessage } from "@/app/lib/api-error";

/**
 * Step C5: Achievement "Talking" tab data — GET
 * /api/conversation/progress?userId=...&language=JP
 *
 * All can-do progress (Stage 1-5, Stage 3-5 shown as empty/locked shells —
 * see STAGE_INFO's doc comment) plus cumulative stats across every
 * `completed` session. turnsAnsweredAlone here reuses
 * computeTurnsAnsweredAloneStats() (the same function the review screen and
 * judgeCandos use) — no new judgment logic is written here.
 */
export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get("userId");
    const language = req.nextUrl.searchParams.get("language");

    if (!userId || !language) {
      return NextResponse.json({ error: "Missing userId or language" }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    const [userCandos, currentStage, completedSessions] = await Promise.all([
      fetchUserCandos(supabase, userId, language),
      getOrCreateConversationStage(supabase, userId, language),
      fetchCompletedConversationSessions(supabase, userId, language),
    ]);

    const progressByCandoId = new Map(
      userCandos.map((c) => [c.cando_id, { consecutiveSuccess: c.consecutive_success, achieved: c.achieved }])
    );

    const stages = STAGE_INFO.map((info) => {
      const stageCandos = ALL_CANDOS.filter((c) => c.stage === info.stage);
      const candos = stageCandos.map((c) => {
        const progress = progressByCandoId.get(c.id);
        return {
          candoId: c.id,
          en: c.en,
          example: c.example,
          topic: c.topic,
          consecutiveSuccess: progress?.consecutiveSuccess ?? 0,
          achieved: progress?.achieved ?? false,
        };
      });

      const topicIds = Array.from(new Set(stageCandos.map((c) => c.topic)));
      const topics = topicIds.map((topic) => {
        const inTopic = candos.filter((c) => c.topic === topic);
        return {
          topic,
          achieved: inTopic.filter((c) => c.achieved).length,
          total: inTopic.length,
        };
      });

      return {
        stage: info.stage,
        name: info.name,
        description: info.description,
        achieved: candos.filter((c) => c.achieved).length,
        total: candos.length,
        unlocked: info.stage <= currentStage,
        topics,
        candos,
      };
    });

    const totalAchieved = stages.reduce((sum, s) => sum + s.achieved, 0);

    // Cumulative stats: sum turnsAnsweredAlone/turnsTotal across every
    // completed session (single shared judgment function — see doc comment
    // above), and speaking_ms straight from the session rows.
    const sessionIds = completedSessions.map((s) => s.id);
    const turnsBySession = await fetchConversationTurnsForSessions(supabase, sessionIds);

    let turnsAnsweredAlone = 0;
    let turnsTotal = 0;
    let speakingMs = 0;
    for (const session of completedSessions) {
      const turns = turnsBySession.get(session.id) ?? [];
      const stats = computeTurnsAnsweredAloneStats(turns);
      turnsAnsweredAlone += stats.turnsAnsweredAlone;
      turnsTotal += stats.turnsTotal;
      speakingMs += session.speaking_ms ?? 0;
    }

    return NextResponse.json({
      currentStage,
      totalAchieved,
      stages,
      totals: {
        conversations: completedSessions.length,
        turnsAnsweredAlone,
        turnsTotal,
        speakingMs,
      },
    });
  } catch (error: unknown) {
    console.error("Conversation progress API error:", error);
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

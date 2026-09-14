import { NextRequest, NextResponse } from "next/server";
import { ALL_CANDOS } from "@/app/lib/conversation-candos";
import { getSupabaseClient, fetchUserCandos, getOrCreateConversationStage } from "@/app/lib/conversation-db";
import { toErrorMessage } from "@/app/lib/api-error";

/**
 * Step C3: デバッグ専用エンドポイント。?debug=1 パネルで
 * user_candos の全レコード（26個すべて、未着手のものも consecutive=0 で表示）と
 * 現在の会話 Stage を確認するために使う。UI の通常フローでは呼ばない。
 */
export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get("userId");
    const language = req.nextUrl.searchParams.get("language");
    if (!userId || !language) {
      return NextResponse.json({ error: "Missing userId or language" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const [rows, stage] = await Promise.all([
      fetchUserCandos(supabase, userId, language),
      getOrCreateConversationStage(supabase, userId, language),
    ]);
    const byId = new Map(rows.map((r) => [r.cando_id, r]));

    const candos = ALL_CANDOS.map((c) => {
      const row = byId.get(c.id);
      return {
        candoId: c.id,
        en: c.en,
        stage: c.stage,
        isStrategy: Boolean(c.isStrategy),
        consecutiveSuccess: row?.consecutive_success ?? 0,
        achieved: row?.achieved ?? false,
      };
    });

    return NextResponse.json({ stage, candos });
  } catch (error: unknown) {
    console.error("Conversation candos debug API error:", error);
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

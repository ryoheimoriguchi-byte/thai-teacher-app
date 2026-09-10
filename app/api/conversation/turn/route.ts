import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildConversationPrompt } from "@/app/lib/conversation-prompts";
import { getVocabCategories } from "@/app/lib/conversation-scenarios";
import {
  getSupabaseClient,
  fetchMasteredWords,
  getStudentName,
  getConversationSession,
  fetchConversationTurns,
  updateTurnTranscript,
  insertConversationTurn,
  updateSessionProgress,
} from "@/app/lib/conversation-db";
import { callClaudeForJson } from "@/app/lib/claude-json";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4-5"; // Opus は使わない（遅すぎる）

type TurnReply = {
  reply: string;
  reply_en: string;
  should_end: boolean;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sessionId = body.sessionId as string;
    const transcript = body.transcript as string;
    const recordingMs = (body.recordingMs as number | undefined) ?? null;
    const isClosing = Boolean(body.isClosing);

    if (!sessionId || typeof transcript !== "string") {
      return NextResponse.json(
        { error: "Missing sessionId or transcript" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseClient();

    const session = await getConversationSession(supabase, sessionId);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (session.status !== "active") {
      return NextResponse.json(
        { error: `Session is not active (status: ${session.status})` },
        { status: 409 }
      );
    }

    // クライアントから履歴を受け取らない。DB を唯一の真実として全ターンを再構築する。
    const turns = await fetchConversationTurns(supabase, sessionId);
    const lastTurn = turns[turns.length - 1];
    if (!lastTurn || lastTurn.transcript !== null) {
      return NextResponse.json(
        { error: "No open turn is awaiting a transcript for this session" },
        { status: 409 }
      );
    }

    const charCount = transcript.length;
    await updateTurnTranscript(supabase, lastTurn.id, {
      transcript,
      recordingMs,
      charCount,
    });
    // メッセージ組み立て用にローカルでも反映する
    lastTurn.transcript = transcript;

    // mastered 語彙は毎ターン DB から取り直す（セッション中のキャッシュはしない）
    // シナリオ関連カテゴリのみに絞り込む（input tokens 削減。conversation-scenarios.ts で管理）
    const [studentName, masteredWords] = await Promise.all([
      getStudentName(supabase, session.user_id),
      fetchMasteredWords(
        supabase,
        session.user_id,
        session.language,
        getVocabCategories(session.scenario_id)
      ),
    ]);

    const messages: { role: "user" | "assistant"; content: string }[] = [
      // セッション開始時と同じダミー user メッセージ。Claude の messages は user から始める必要がある。
      { role: "user", content: "(会話を始めてください)" },
    ];
    for (const t of turns) {
      messages.push({ role: "assistant", content: t.tutor_text });
      if (t.transcript) {
        messages.push({ role: "user", content: t.transcript });
      }
    }

    const systemPrompt = buildConversationPrompt({
      scenarioId: session.scenario_id,
      studentName,
      masteredWords,
      isOpening: false,
      isClosing,
    });

    const nextTurn = await callClaudeForJson<TurnReply>(async () => {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 150, // 実出力は60〜82 tokens程度。暴走時の上限として抑える
        system: systemPrompt,
        messages,
      });
      return response.content[0].type === "text" ? response.content[0].text : "";
    });

    const newTurnIndex = turns.length;
    await insertConversationTurn(supabase, {
      sessionId,
      userId: session.user_id,
      turnIndex: newTurnIndex,
      tutorText: nextTurn.reply,
      tutorTextEn: nextTurn.reply_en,
    });

    await updateSessionProgress(supabase, sessionId, {
      turnCount: session.turn_count + 1,
      speakingMs: session.speaking_ms + (recordingMs ?? 0),
    });

    return NextResponse.json({
      turnIndex: newTurnIndex,
      tutorText: nextTurn.reply,
      tutorTextEn: nextTurn.reply_en,
      shouldEnd: Boolean(nextTurn.should_end),
    });
  } catch (error: unknown) {
    console.error("Conversation turn API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

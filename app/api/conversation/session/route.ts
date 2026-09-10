import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildConversationPrompt, buildReviewPrompt } from "@/app/lib/conversation-prompts";
import { getScenario, getVocabCategories } from "@/app/lib/conversation-scenarios";
import {
  getSupabaseClient,
  fetchMasteredWords,
  getStudentName,
  createConversationSession,
  getConversationSession,
  completeConversationSession,
  finalizeSessionReview,
  fetchConversationTurns,
  insertConversationTurn,
  updateTurnScoring,
  type ConversationScores,
} from "@/app/lib/conversation-db";
import { callClaudeForJson } from "@/app/lib/claude-json";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4-5";

type OpeningReply = {
  reply: string;
  reply_en: string;
  should_end: boolean;
};

type ReviewResult = {
  turns: {
    index: number;
    scores: ConversationScores;
    phrases_used: string[];
    vocab_used: string[];
    bonus_words: string[];
  }[];
  session: {
    feedback_positive: string;
    feedback_improvement: string;
    highlight: string;
  };
};

async function askClaudeText(params: {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens: number;
}): Promise<string> {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: params.maxTokens,
    ...(params.system ? { system: params.system } : {}),
    messages: params.messages,
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "start") {
      return await handleStart(body);
    }
    if (body.action === "end") {
      return await handleEnd(body);
    }
    return NextResponse.json(
      { error: "action must be 'start' or 'end'" },
      { status: 400 }
    );
  } catch (error: unknown) {
    console.error("Conversation session API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleStart(body: Record<string, unknown>) {
  const userId = body.userId as string;
  const language = body.language as string;
  const scenarioId = body.scenarioId as string;
  const plannedDurationSec = body.plannedDurationSec as number;

  if (!userId || !language || !scenarioId || !plannedDurationSec) {
    return NextResponse.json(
      { error: "Missing userId, language, scenarioId, or plannedDurationSec" },
      { status: 400 }
    );
  }

  const scenario = getScenario(scenarioId);
  if (!scenario) {
    return NextResponse.json(
      { error: `Unknown scenarioId: ${scenarioId}` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseClient();

  const [studentName, masteredWords] = await Promise.all([
    getStudentName(supabase, userId),
    fetchMasteredWords(supabase, userId, language, getVocabCategories(scenarioId)),
  ]);

  const session = await createConversationSession(supabase, {
    userId,
    language,
    scenarioId,
    plannedDurationSec,
  });

  const systemPrompt = buildConversationPrompt({
    scenarioId,
    studentName,
    masteredWords,
    isOpening: true,
    isClosing: false,
  });

  const opening = await callClaudeForJson<OpeningReply>(() =>
    askClaudeText({
      system: systemPrompt,
      // Claude の messages は user から始める必要があるため、開始トリガーのみのダミー user メッセージを渡す。
      // このメッセージ自体は conversation_turns には保存しない。
      messages: [{ role: "user", content: "(会話を始めてください)" }],
      maxTokens: 300,
    })
  );

  await insertConversationTurn(supabase, {
    sessionId: session.id,
    userId,
    turnIndex: 0,
    tutorText: opening.reply,
    tutorTextEn: opening.reply_en,
  });

  return NextResponse.json({
    sessionId: session.id,
    turnIndex: 0,
    tutorText: opening.reply,
    tutorTextEn: opening.reply_en,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      intro: scenario.intro,
    },
  });
}

async function handleEnd(body: Record<string, unknown>) {
  const sessionId = body.sessionId as string;
  const actualDurationSec = (body.actualDurationSec as number) ?? null;

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  const session = await getConversationSession(supabase, sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // 会話の記録が失われる方が損失が大きいため、採点の成否にかかわらず先に completed にする。
  await completeConversationSession(supabase, sessionId, { actualDurationSec });

  const turns = await fetchConversationTurns(supabase, sessionId);
  const answeredTurns = turns.filter((t) => t.transcript);

  let feedbackPositive: string | null = null;
  let feedbackImprovement: string | null = null;
  let highlight: string | null = null;
  let vocabUsedCount = 0;

  if (answeredTurns.length > 0) {
    try {
      const [studentName, knownVocabulary] = await Promise.all([
        getStudentName(supabase, session.user_id),
        fetchMasteredWords(
          supabase,
          session.user_id,
          session.language,
          getVocabCategories(session.scenario_id)
        ),
      ]);

      const reviewPrompt = buildReviewPrompt({
        studentName,
        scenarioId: session.scenario_id,
        studentTurns: answeredTurns.map((t) => t.transcript as string),
        tutorTurns: answeredTurns.map((t) => t.tutor_text),
        knownVocabulary,
      });

      const review = await callClaudeForJson<ReviewResult>(() =>
        askClaudeText({
          messages: [{ role: "user", content: reviewPrompt }],
          maxTokens: 4000,
        })
      );

      const vocabSet = new Set<string>();
      for (const turnResult of review.turns) {
        const targetTurn = answeredTurns[turnResult.index - 1];
        if (!targetTurn) continue;
        await updateTurnScoring(supabase, targetTurn.id, {
          scores: turnResult.scores,
          phrasesUsed: turnResult.phrases_used ?? [],
          vocabUsed: turnResult.vocab_used ?? [],
          bonusWords: turnResult.bonus_words ?? [],
        });
        (turnResult.vocab_used ?? []).forEach((w) => vocabSet.add(w));
      }
      vocabUsedCount = vocabSet.size;

      feedbackPositive = review.session.feedback_positive;
      feedbackImprovement = review.session.feedback_improvement;
      highlight = review.session.highlight;

      await finalizeSessionReview(supabase, sessionId, {
        feedbackPositive,
        feedbackImprovement,
        highlight,
      });
    } catch (reviewError) {
      // 指示書どおり: 採点に失敗してもセッションは completed のまま、reviewed=false で残す。
      console.error(
        `Conversation review failed for session ${sessionId}; left unreviewed:`,
        reviewError
      );
      feedbackPositive = null;
      feedbackImprovement = null;
      highlight = null;
      vocabUsedCount = 0;
    }
  }

  return NextResponse.json({
    sessionId,
    speakingMs: session.speaking_ms,
    turnCount: session.turn_count,
    vocabUsedCount,
    feedbackPositive,
    feedbackImprovement,
    highlight,
  });
}

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildConversationPrompt, buildReviewPrompt } from "@/app/lib/conversation-prompts";
import { getScenario, getVocabCategories } from "@/app/lib/conversation-scenarios";
import {
  ALL_CANDOS,
  selectMissionCandos,
  judgeCandos,
  getCando,
  type CandoProgressState,
  type CandoJudgmentEvent,
} from "@/app/lib/conversation-candos";
import {
  getSupabaseClient,
  fetchMasteredWords,
  getStudentName,
  createConversationSession,
  getConversationSession,
  completeConversationSession,
  abandonConversationSession,
  finalizeSessionReview,
  fetchConversationTurns,
  insertConversationTurn,
  updateSessionProgress,
  updateTurnScoring,
  deleteConversationTurn,
  resetTurnToOpen,
  fetchUserCandos,
  upsertUserCando,
  getOrCreateConversationStage,
  setConversationStage,
  type ConversationScores,
} from "@/app/lib/conversation-db";
import { callClaudeForJson } from "@/app/lib/claude-json";
import { toErrorMessage } from "@/app/lib/api-error";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4-5";

type OpeningReply = {
  reply: string;
  reply_en: string;
  // 記録用（UI非表示、スコアリング設計中）。最初のターンは response_quality は null。
  support_given?: string | null;
  response_quality?: string | null;
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
  console.log(
    `[conversation/session] Claude usage: input=${response.usage.input_tokens} output=${response.usage.output_tokens} stop_reason=${response.stop_reason}`
  );
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
    if (body.action === "abandon") {
      return await handleAbandon(body);
    }
    if (body.action === "undo_last_turn") {
      return await handleUndoLastTurn(body);
    }
    return NextResponse.json(
      { error: "action must be 'start', 'end', 'abandon', or 'undo_last_turn'" },
      { status: 400 }
    );
  } catch (error: unknown) {
    console.error("Conversation session API error:", error);
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
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

  const [studentName, masteredWords, existingCandos, currentStage] = await Promise.all([
    getStudentName(supabase, userId),
    fetchMasteredWords(supabase, userId, language, getVocabCategories(scenarioId)),
    fetchUserCandos(supabase, userId, language),
    getOrCreateConversationStage(supabase, userId, language),
  ]);

  // Step C3: ミッション選定。freetalk は ALL_CANDOS のどの can-do も
  // scenarioIds に 'freetalk' を含まないため、自然に候補0件 → 空配列になる。
  const progressByCandoId = new Map<string, CandoProgressState>(
    existingCandos.map((c) => [
      c.cando_id,
      { consecutiveSuccess: c.consecutive_success, achieved: c.achieved },
    ])
  );
  const missions = selectMissionCandos({ scenarioId, currentStage, progressByCandoId });

  const session = await createConversationSession(supabase, {
    userId,
    language,
    scenarioId,
    plannedDurationSec,
    missionCandoIds: missions.map((m) => m.id),
  });

  const systemPrompt = buildConversationPrompt({
    scenarioId,
    studentName,
    masteredWords,
    isOpening: true,
    isClosing: false,
    missions,
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
    supportGiven: opening.support_given ?? null,
    responseQuality: opening.response_quality ?? null,
  });

  return NextResponse.json({
    sessionId: session.id,
    turnIndex: 0,
    tutorText: opening.reply,
    tutorTextEn: opening.reply_en,
    // デバッグパネル表示用（?debug=1）。
    supportGiven: opening.support_given ?? null,
    responseQuality: opening.response_quality ?? null,
    scenario: {
      id: scenario.id,
      title: scenario.title,
      intro: scenario.intro,
    },
    // Step C3: 場面説明画面 [2] に表示するミッション（英語表記 + 例文）。
    missions: missions.map((m) => ({ candoId: m.id, en: m.en, example: m.example })),
    conversationStage: currentStage,
  });
}

/**
 * Step C3: [2] 場面説明画面の「← Choose a different topic」で戻ったときに呼ぶ。
 * 採点・can-do 判定は一切行わない（0ターンのまま単に abandoned にするだけ）。
 */
async function handleAbandon(body: Record<string, unknown>) {
  const sessionId = body.sessionId as string;
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const supabase = getSupabaseClient();
  await abandonConversationSession(supabase, sessionId);

  return NextResponse.json({ sessionId, status: "abandoned" });
}

/**
 * Fix 2 (2026-09-19): "Not what I said" — a persistent, no-time-limit
 * control next to the most recent student bubble (replacing the earlier
 * timed pre-send cancel window, which was too easy to miss while
 * scrolling). Undoes exactly the last exchange:
 *   - deletes the tutor reply that was generated in response to it
 *     (turns[last], which is the currently "open" turn awaiting a reply)
 *   - resets the turn before it (turns[last-1]) back to "open", so
 *     recording again just re-answers that same tutor line
 *   - rolls back turn_count / speaking_ms on the session accordingly
 * Deliberately only supports undoing the single most recent exchange, not
 * arbitrary history — see the instructions this was built from.
 */
async function handleUndoLastTurn(body: Record<string, unknown>) {
  const sessionId = body.sessionId as string;
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
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

  const turns = await fetchConversationTurns(supabase, sessionId);
  // turns[last] should be the currently open turn (transcript===null,
  // awaiting the student's next reply) — the same invariant /turn relies
  // on. turns[last-1] is the exchange we're undoing (it has the transcript
  // we're discarding).
  const lastTurn = turns[turns.length - 1];
  const prevTurn = turns[turns.length - 2];
  if (!lastTurn || lastTurn.transcript !== null || !prevTurn || prevTurn.transcript === null) {
    return NextResponse.json({ error: "Nothing to undo" }, { status: 409 });
  }

  await deleteConversationTurn(supabase, lastTurn.id);
  await resetTurnToOpen(supabase, prevTurn.id);
  await updateSessionProgress(supabase, sessionId, {
    turnCount: Math.max(0, session.turn_count - 1),
    speakingMs: Math.max(0, session.speaking_ms - (prevTurn.recording_ms ?? 0)),
  });

  return NextResponse.json({
    // The tutor line the student is back to answering — the client
    // restores this as currentTurn and drops the last history entry.
    tutorText: prevTurn.tutor_text,
    tutorTextEn: prevTurn.tutor_text_en,
  });
}

async function handleEnd(body: Record<string, unknown>) {
  const sessionId = body.sessionId as string;
  // Math.round defensively — actual_duration_sec is an `integer` DB column.
  const actualDurationSecRaw = body.actualDurationSec as number | undefined;
  const actualDurationSec =
    typeof actualDurationSecRaw === "number" && Number.isFinite(actualDurationSecRaw)
      ? Math.round(actualDurationSecRaw)
      : null;

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

  // Step C3: can-do 判定結果。振り返り採点（phrases_used / support_given の確定）が
  // 成功した場合のみ実行する。answeredTurns が0件、または採点自体が失敗した場合は
  // 判定を行わない（機会があったかどうかの情報が無いまま失敗リセットしてしまうのを防ぐ）。
  let candoResults: ReturnType<typeof judgeCandos> = [];
  let missionsResult: { candoId: string; en: string; achieved: boolean }[] = [];
  let turnsAnsweredAlone = 0;
  let stageUp = false;

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
        const phrasesUsed = turnResult.phrases_used ?? [];
        await updateTurnScoring(supabase, targetTurn.id, {
          scores: turnResult.scores,
          phrasesUsed,
          vocabUsed: turnResult.vocab_used ?? [],
          bonusWords: turnResult.bonus_words ?? [],
        });
        // ローカルの turns 配列にも反映しておく — can-do 判定はこの後、DB を
        // 読み直さずにこの配列から phrases_used / support_given を組み立てる。
        targetTurn.phrases_used = phrasesUsed;
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

      // ---- Step C3: can-do 判定 -------------------------------------
      // 1往復 = turns[i]（生徒の発話 = transcript, phrases_used）+
      //         turns[i+1]（その発話を受けた先生の返答の support_given）。
      // transcript と直後の turn 挿入は /turn 内で同じリクエストの中で
      // 一緒に行われるため、transcript がある turn には必ず i+1 が存在する。
      const events: CandoJudgmentEvent[] = [];
      for (let i = 0; i < turns.length - 1; i++) {
        if (!turns[i].transcript) continue;
        events.push({
          phrasesUsed: turns[i].phrases_used ?? [],
          supportGiven: turns[i + 1].support_given,
        });
      }
      turnsAnsweredAlone = events.filter((e) => e.supportGiven === "none").length;

      const existingCandos = await fetchUserCandos(supabase, session.user_id, session.language);
      const progressByCandoId = new Map<string, CandoProgressState>(
        existingCandos.map((c) => [
          c.cando_id,
          { consecutiveSuccess: c.consecutive_success, achieved: c.achieved },
        ])
      );

      // Fetched once here and reused below for the stage-up check — judgment
      // itself is capped at this stage (see judgeCandos's currentStage doc).
      const currentStage = await getOrCreateConversationStage(
        supabase,
        session.user_id,
        session.language
      );

      candoResults = judgeCandos({
        events,
        missionCandoIds: session.mission_cando_ids ?? [],
        progressByCandoId,
        currentStage,
      });

      const now = new Date().toISOString();
      for (const r of candoResults) {
        await upsertUserCando(supabase, {
          userId: session.user_id,
          language: session.language,
          candoId: r.candoId,
          consecutiveSuccess: r.after,
          achieved: r.achieved,
          achievedAt: r.justAchieved ? now : r.achieved ? now : null,
          lastPracticed: now,
        });
      }

      missionsResult = (session.mission_cando_ids ?? []).map((candoId) => {
        const cando = getCando(candoId);
        const changed = candoResults.find((r) => r.candoId === candoId);
        const alreadyAchieved = progressByCandoId.get(candoId)?.achieved ?? false;
        return {
          candoId,
          en: cando?.en ?? candoId,
          achieved: changed ? changed.achieved : alreadyAchieved,
        };
      });

      // ---- Stage 解放判定（100%。語彙側の90%とは異なる） --------------
      // currentStage is the same value fetched above, before judgeCandos.
      const stageCandos = ALL_CANDOS.filter((c) => c.stage === currentStage);
      if (stageCandos.length > 0) {
        const allAchieved = stageCandos.every((c) => {
          const changed = candoResults.find((r) => r.candoId === c.id);
          if (changed) return changed.achieved;
          return progressByCandoId.get(c.id)?.achieved ?? false;
        });
        // Stage 3 以降は can-do 未定義（このファイルは Stage 1-2 のみ扱う）。
        if (allAchieved && currentStage < 2) {
          await setConversationStage(supabase, session.user_id, session.language, currentStage + 1);
          stageUp = true;
        }
      }
    } catch (reviewError) {
      // 指示書どおり: 採点に失敗してもセッションは completed のまま、reviewed=false で残す。
      // can-do 判定も、phrases_used / support_given が確定していない以上ここでは行わない。
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

  // デバッグパネル表示用。can-do 判定の成否にかかわらず、常に最新値を返す。
  const conversationStage = await getOrCreateConversationStage(
    supabase,
    session.user_id,
    session.language
  );

  return NextResponse.json({
    sessionId,
    speakingMs: session.speaking_ms,
    turnCount: session.turn_count,
    vocabUsedCount,
    feedbackPositive,
    feedbackImprovement,
    highlight,
    // Step C3 (Step C4 の振り返り画面が使う。今は生 JSON のまま表示)
    turnsAnsweredAlone,
    turnsTotal: answeredTurns.length,
    missions: missionsResult,
    candoProgress: candoResults.map((r) => ({
      candoId: r.candoId,
      en: getCando(r.candoId)?.en ?? r.candoId,
      before: r.before,
      after: r.after,
      justAchieved: r.justAchieved,
    })),
    stageUp,
    conversationStage,
  });
}

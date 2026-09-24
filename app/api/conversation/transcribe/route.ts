import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { transcribeAudio } from "@/app/lib/whisper";
import { buildWhisperPrompt, getVocabCategories } from "@/app/lib/conversation-scenarios";
import { getSupabaseClient, getConversationSession, fetchMasteredWords } from "@/app/lib/conversation-db";
import { toErrorMessage } from "@/app/lib/api-error";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Speed over quality: this is just a display-only reading conversion, not
// scoring/judgement, so the fast/cheap model is the right choice here.
const HAIKU_MODEL = "claude-haiku-4-5";

/**
 * Converts a (possibly kanji-mixed) Japanese transcript to hiragana-only,
 * for display to a child who can't read kanji yet. This is DISPLAY ONLY:
 * - The original transcript (with kanji) is what gets saved to the DB and
 *   sent to /api/conversation/turn, since collapsing everything to kana
 *   would lose homophone distinctions that matter for scoring/phrase
 *   matching at session end.
 * - char_count must also be measured on the ORIGINAL transcript (kana
 *   inflates character counts and would distort the "average utterance
 *   length over time" growth metric).
 * Never throws: on any failure, falls back to the original transcript so a
 * conversion hiccup never blocks the conversation.
 */
async function toHiragana(text: string): Promise<{ kana: string; ms: number }> {
  const t0 = Date.now();
  try {
    const response = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content:
            "以下の日本語をひらがなだけに変換してください。意味を変えず、読みだけを変えること。" +
            "説明や前置きは不要、変換結果のみを返してください。\n\n" +
            text,
        },
      ],
    });
    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "";
    return { kana: raw || text, ms: Date.now() - t0 };
  } catch (error) {
    console.error("Hiragana conversion failed, falling back to the original transcript:", error);
    return { kana: text, ms: Date.now() - t0 };
  }
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio") as File | null;
    const sessionId = formData.get("sessionId") as string | null;

    if (!audio || !sessionId) {
      return NextResponse.json(
        { error: "Missing audio or sessionId" },
        { status: 400 }
      );
    }

    // Step C4.2: prime Whisper with this session's scenario phrases +
    // mastered vocabulary, to cut down on the child-speech mis-hearing that
    // was corrupting both Claude's replies and can-do/scoring judgment.
    // Best-effort — a failure to build the prompt must never block
    // transcription itself, so this never throws past this block.
    let prompt: string | undefined;
    try {
      const supabase = getSupabaseClient();
      const session = await getConversationSession(supabase, sessionId);
      if (session) {
        const masteredWords = await fetchMasteredWords(
          supabase,
          session.user_id,
          session.language,
          getVocabCategories(session.scenario_id)
        );
        prompt = buildWhisperPrompt(session.scenario_id, masteredWords);
      }
    } catch (e) {
      console.error("Failed to build Whisper prompt, transcribing without one:", e);
    }

    // この段階では DB には書かない。DB への保存は /turn 側で行う。
    const transcript = await transcribeAudio(audio, "ja", prompt);

    // 無音・聞き取り不能で空文字が返ることがあるが、ここではエラーにしない。呼び出し側が判断する。
    let transcriptKana = transcript;
    let kanaConversionMs: number | null = null;
    if (transcript) {
      const result = await toHiragana(transcript);
      transcriptKana = result.kana;
      kanaConversionMs = result.ms;
    }

    return NextResponse.json({
      transcript, // 元のまま（漢字混じり）。DB保存・採点用
      transcriptKana, // ひらがな。表示専用
      charCount: transcript.length, // 必ず元の transcript で数える
      kanaConversionMs,
    });
  } catch (error: unknown) {
    console.error("Conversation transcribe API error:", error);
    return NextResponse.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

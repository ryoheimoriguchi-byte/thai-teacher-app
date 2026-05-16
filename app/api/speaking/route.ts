import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio") as File;
    const targetWord = formData.get("targetWord") as string;
    const targetPronunciation = formData.get("targetPronunciation") as string;
    const language = formData.get("language") as string;
    const mode = formData.get("mode") as string;

    if (!audio || !targetWord) {
      return NextResponse.json({ error: "Missing audio or target" }, { status: 400 });
    }

    const isReadingCharacter = mode === "reading-character";
    const isReadingWord = mode === "reading-word";

    const whisperLanguage = isReadingCharacter || isReadingWord
      ? "ja"
      : language === "TH"
        ? "th"
        : "ja";

    const transcription = await openai.audio.transcriptions.create({
      file: audio,
      model: "whisper-1",
      language: whisperLanguage,
    });

    const spokenText = transcription.text.trim();

    const langLabel = language === "TH" ? "Thai" : "Japanese";

    let prompt: string;

    if (isReadingCharacter) {
      prompt = `You evaluate Japanese reading aloud for young learners.

The student was shown a character and asked to read it with the correct Japanese sound.

- Shown on screen (hiragana, katakana, or kanji): ${targetWord}
- Expected reading in hiragana (correct answer): ${targetPronunciation}

Speech recognition output (often hiragana; may include katakana or extra particles): "${spokenText}"

Compare what was heard to the expected hiragana. Treat hiragana and katakana as equivalent if they represent the same sounds. Minor filler sounds alone should not earn a high score unless the core reading matches.

Evaluate on a scale of 1-5:
5/5 - Matches the expected reading (allowing script variants)
4/5 - Very close (small slip)
3/5 - Partially correct
2/5 - Clearly wrong sounds
1/5 - Unrelated or unintelligible

Respond ONLY with a valid JSON object:
{
  "score": 4,
  "label": "Very Good!",
  "heard": "${spokenText}",
  "feedback": "brief encouraging feedback in English, max 1 sentence",
  "tip": "one specific improvement tip in English, max 1 sentence"
}`;
    } else if (isReadingWord) {
      prompt = `You are a Japanese pronunciation and reading evaluator.

The student was asked to read this Japanese word aloud:
- Word: ${targetWord}
- Reading / pronunciation guide: ${targetPronunciation}

What the speech recognition heard: "${spokenText}"

Evaluate the pronunciation on a scale of 1-5:
5/5 - Perfect! The word matches exactly or is phonetically identical
4/5 - Very close, minor accent or reading issue
3/5 - Understandable but needs practice
2/5 - Some sounds were off, hard to understand
1/5 - Very different, keep practicing

Respond ONLY with a valid JSON object:
{
  "score": 4,
  "label": "Very Good!",
  "heard": "${spokenText}",
  "feedback": "brief encouraging feedback in English, max 1 sentence",
  "tip": "one specific improvement tip in English, max 1 sentence"
}`;
    } else if (mode === "word") {
      prompt = `You are a ${langLabel} pronunciation evaluator.

The student was asked to say this ${langLabel} word:
- Word: ${targetWord}
- Pronunciation guide: ${targetPronunciation}

What the speech recognition heard: "${spokenText}"

Evaluate the pronunciation on a scale of 1-5:
5/5 - Perfect! The word matches exactly or is phonetically identical
4/5 - Very close, minor accent or tone issue
3/5 - Understandable but needs practice
2/5 - Some sounds were off, hard to understand
1/5 - Very different, keep practicing

Respond ONLY with a valid JSON object:
{
  "score": 4,
  "label": "Very Good!",
  "heard": "${spokenText}",
  "feedback": "brief encouraging feedback in English, max 1 sentence",
  "tip": "one specific improvement tip in English, max 1 sentence"
}`;
    } else {
      prompt = `You are a ${langLabel} pronunciation evaluator.

The student was asked to say this ${langLabel} sentence:
- Sentence: ${targetWord}
- Pronunciation guide: ${targetPronunciation}

What the speech recognition heard: "${spokenText}"

Evaluate the pronunciation on a scale of 1-5:
5/5 - Perfect! Matches exactly or is phonetically identical
4/5 - Very close, minor issues
3/5 - Understandable but needs practice
2/5 - Some parts were off
1/5 - Very different, keep practicing

Respond ONLY with a valid JSON object:
{
  "score": 4,
  "label": "Very Good!",
  "heard": "${spokenText}",
  "feedback": "brief encouraging feedback in English, max 1 sentence",
  "tip": "one specific improvement tip in English, max 1 sentence"
}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const result = JSON.parse(cleaned);

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Speaking API error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

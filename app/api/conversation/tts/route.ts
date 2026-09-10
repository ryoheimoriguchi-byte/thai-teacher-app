import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { speak, type TtsProvider } from "@/app/lib/tts-server";

// ストリーミング分岐専用（Step C1: conversation-lab の検証用）。
// 既存の一括モードは tts-server.ts の speak() をそのまま使う（下の else 側）。
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OPENAI_TTS_INSTRUCTIONS =
  "Speak slowly and gently, as if talking to a young child learning Japanese.";

type StreamFormat = "mp3" | "wav" | "pcm";

const CONTENT_TYPE_BY_FORMAT: Record<StreamFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "application/octet-stream", // ヘッダ無しの raw PCM (16bit/24kHz/mono)
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = body.text as string;
    const provider = (body.provider as TtsProvider | undefined) ?? "openai";
    const stream = Boolean(body.stream);
    const format = ((body.format as StreamFormat | undefined) ?? "mp3") as StreamFormat;

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    if (stream) {
      // Step C1 検証用: gpt-4o-mini-tts のストリーミング応答をそのままブラウザへ中継する。
      const response = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "shimmer",
        input: text,
        instructions: OPENAI_TTS_INSTRUCTIONS,
        response_format: format,
      });

      if (!response.body) {
        return NextResponse.json(
          { error: "OpenAI response had no readable body" },
          { status: 500 }
        );
      }

      return new NextResponse(response.body, {
        status: 200,
        headers: {
          "Content-Type": CONTENT_TYPE_BY_FORMAT[format],
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // 既存の一括モード（Step B から変更なし）
    const audioBuffer = await speak(text, provider);

    return new NextResponse(new Uint8Array(audioBuffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audioBuffer.length),
      },
    });
  } catch (error: unknown) {
    console.error("Conversation TTS API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

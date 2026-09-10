import { NextRequest, NextResponse } from "next/server";
import { speak, type TtsProvider } from "@/app/lib/tts-server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = body.text as string;
    const provider = (body.provider as TtsProvider | undefined) ?? "openai";

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

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

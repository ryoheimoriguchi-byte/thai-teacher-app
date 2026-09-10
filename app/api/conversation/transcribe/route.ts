import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/app/lib/whisper";

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

    // この段階では Claude は呼ばない。文字起こし結果のみを返す。DB への保存は /turn 側で行う。
    const transcript = await transcribeAudio(audio, "ja");

    // 無音・聞き取り不能で空文字が返ることがあるが、ここではエラーにしない。呼び出し側が判断する。
    return NextResponse.json({ transcript, charCount: transcript.length });
  } catch (error: unknown) {
    console.error("Conversation transcribe API error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * サーバー側 TTS 抽象化（Conversation 機能用）。
 *
 * NOTE: app/lib/tts.ts はクライアント用の Web Speech API ラッパーで、
 * 既存の複数ページ（speaking, listening, vocabulary, index-card,
 * sentence-listening）が import している。名前が衝突しないよう、また
 * 既存ページの発音機能に影響を与えないよう、このファイルは別ファイルとして
 * 新規作成している。
 *
 * provider を後から切り替えられるようにするため、呼び出し側
 * (app/api/conversation/tts/route.ts) は speak() をそのまま呼ぶだけにすること。
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type TtsProvider = "openai" | "google";

const OPENAI_TTS_INSTRUCTIONS =
  "Speak slowly and gently, as if talking to a young child learning Japanese.";

async function speakWithOpenAi(text: string): Promise<Buffer> {
  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "shimmer",
    input: text,
    instructions: OPENAI_TTS_INSTRUCTIONS,
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function speakWithGoogle(_text: string): Promise<Buffer> {
  throw new Error("not implemented");
}

/**
 * テキストを音声（mp3 バイナリ）に変換する。
 * @param text 読み上げるテキスト
 * @param provider "openai"（実装済み）| "google"（未実装）
 */
export async function speak(
  text: string,
  provider: TtsProvider = "openai"
): Promise<Buffer> {
  if (provider === "google") {
    return speakWithGoogle(text);
  }
  return speakWithOpenAi(text);
}

/**
 * Whisper (OpenAI) を使った音声文字起こしの共通ヘルパー。
 *
 * NOTE: app/api/speaking/route.ts にも同種の Whisper 呼び出しがある
 * (openai.audio.transcriptions.create({ model: "whisper-1", ... }))。
 * speaking/route.ts はモード別の言語判定ロジックを含んでおり、既存動作に
 * 影響を与えないよう今回は変更していない。将来的にそちらもこのヘルパー経由に
 * 統一できる余地があるが、Step B の範囲外として見送った。
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type WhisperLanguage = "ja" | "th";

/**
 * 音声ファイルを Whisper で文字起こしする。
 * 無音や聞き取り不能な場合、空文字や無意味な文字列が返ることがある。
 * 呼び出し側でその判断を行うこと（ここではエラーにしない）。
 */
/**
 * @param prompt Whisper's optional priming text — biases recognition
 *   toward the vocabulary/phrasing likely to appear (Step C4.2, real-device
 *   bug: children's speech was badly misheard, e.g. 「りんごをください」→
 *   「リングをください」, feeding garbage into Claude and can-do judgment).
 *   Keep short; Whisper reportedly ignores prompts past ~200 tokens or so.
 */
export async function transcribeAudio(
  audio: File,
  language: WhisperLanguage,
  prompt?: string
): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    file: audio,
    model: "whisper-1",
    language,
    ...(prompt ? { prompt } : {}),
  });

  return transcription.text.trim();
}

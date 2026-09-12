/**
 * Claude が JSON を返すエンドポイント (session start / turn / session end review) で
 * 共通して使う、コードブロック記号除去 + パース失敗時のリトライ。
 *
 * 指示書のファイル一覧には無いが、3箇所で同じ防御ロジックを書くと保守しづらいため
 * 小さな共通ヘルパーとして切り出した（報告済み）。
 */

function stripJsonFences(raw: string): string {
  return raw.replace(/```json\n?|```\n?/g, "").trim();
}

/**
 * @param callModel Claude を呼び出し、生のテキストレスポンスを返す関数。
 *   パース失敗時は同じ関数を再度呼び出してリトライする（モデル呼び出しからやり直す）。
 * @param maxRetries パース失敗時の最大リトライ回数（合計呼び出し回数は maxRetries + 1）。
 *   デフォルト2（= 最大3回試行）。
 */
export async function callClaudeForJson<T>(
  callModel: () => Promise<string>,
  maxRetries = 2
): Promise<T> {
  let lastRaw = "";
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await callModel();
    lastRaw = raw;
    try {
      return JSON.parse(stripJsonFences(raw)) as T;
    } catch (e) {
      lastError = e;
      console.error(
        `[claude-json] JSON parse failed (attempt ${attempt + 1}/${maxRetries + 1}). Raw response:`,
        raw
      );
    }
  }

  throw new Error(
    `Failed to parse Claude response as JSON after ${maxRetries + 1} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}. ` +
      `Last raw response: ${lastRaw.slice(0, 200)}`
  );
}

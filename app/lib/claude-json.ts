/**
 * Claude が JSON を返すエンドポイント (session start / turn / session end review) で
 * 共通して使う、コードブロック記号除去 + パース失敗時の1回リトライ。
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
 */
export async function callClaudeForJson<T>(
  callModel: () => Promise<string>
): Promise<T> {
  const first = await callModel();
  try {
    return JSON.parse(stripJsonFences(first)) as T;
  } catch {
    console.error(
      "[claude-json] JSON parse failed, retrying once. Raw response:",
      first
    );
    const second = await callModel();
    try {
      return JSON.parse(stripJsonFences(second)) as T;
    } catch (e) {
      console.error(
        "[claude-json] JSON parse failed again after retry. Raw response:",
        second
      );
      throw new Error(
        `Failed to parse Claude response as JSON after retry: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
}

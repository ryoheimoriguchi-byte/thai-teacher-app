# Home Stage 3 集計バグ 調査報告

調査日: 2026-07-11  
対象: Home 画面 Progress セクション — Listening Stage 3 が `0 / 165` と表示される問題  
方針: **コード調査のみ**（修正・DB 変更・push は未実施）

---

## 原因

**Supabase（PostgREST）のデフォルト行数上限 1,000 件により、`app/page.tsx` が取得した `word_progress` が途中で切れており、Stage 3 の進捗行がクライアント側データに含まれていない。**

- 該当箇所: `app/page.tsx` の `fetchData`（L107 付近）  
  `supabase.from("word_progress").select("*").eq("user_id", currentUser.id)` に **ページネーション（`.range()` ループ）がない**
- 集計関数 `countMasteredInStageByDirection`（`app/lib/stage-progress.ts` L73–88）自体のロジックは正しいが、**入力の `wordProgress` が欠損している**ため Stage 3 だけ 0 になる
- Stage 1・2 が正しく見える理由: 学習が早い Stage の `word_progress` 行が先に INSERT され、返却される先頭 ~1,000 行に含まれやすい。Stage 3 は後から追加・学習された行が多く、**1,000 行目以降に押し出されている**と推定

### 調査観点ごとの結論

| 観点 | 結論 |
|------|------|
| 1. 集計関数の特定 | Progress 行は `buildStageModuleProgressRows` → `countMasteredInStageByDirection`（方向別）。Stage 表は `countMasteredInStage`（Listening のみ両方向必須） |
| 2. Stage 上限のハードコード | **該当なし**。`MODULE_MAX_STAGE` は `reading_character` のみ（max=2）。Listening 集計には影響しない |
| 3. 両方向 mastered ロジックの混在 | **Progress 行には混在していない**（方向別カウント）。ただし同じ欠損 `wordProgress` により Stage 表の Stage 3 も過小表示になりうる |
| 4. Stage 1/2 と 3 の境界 | `b744b83` で導入した Stage 別表示が、**全件取得前提の `word_progress` 取得**と組み合わさり、行数増加で Stage 3 から顕在化 |

### 表示設計の整理（0 にならない場合の期待値）

Home **Progress 行**は **方向別**（`countMasteredInStageByDirection`）:

| 行 | 期待される mastered（Mirei 例） |
|----|----------------------------------|
| Listening: 🇯🇵→🇬🇧 (Stage 3) | **77**（`word-to-en`） |
| Listening: 🇬🇧→🇯🇵 (Stage 3) | **8**（`en-to-word`） |

Home **Stage 表**の Listening 行は **両方向 mastered で 1 語**（`countMasteredInStage`）:

| セル | 期待される定義 |
|------|----------------|
| Listening × Stage 3 | **8 / 165**（両方向 mastered の語数。en-to-word が 8 語のため上限 8） |

いずれの設計でも **0 は誤り**。今回の主因は設計の不一致ではなく **データ未取得**。

---

## 該当コード

### 1. 根本原因: `word_progress` 全件取得なし（上限 1,000 行）

```typescript
// app/page.tsx L100-107
const [{ data: cardData }, { data: progressData }, ...] =
  await Promise.all([
    supabase.from("cards").select("id, language")...,
    supabase.from("word_progress").select("*").eq("user_id", currentUser.id), // ← ページネーションなし
    ...
  ]);
if (progressData) setWordProgress(progressData);
```

PostgREST / Supabase のデフォルト `max-rows` は **1,000**。Mirei のような JP ユーザーはモジュール × 方向 × 語数で容易に超過する。

概算: JP 単語 ~500 語 ×（listening 2 + sentence 2 + speaking 2 + reading 1）≒ **3,500 行**上限。実際の学習済み行数でも 1,000 超は十分ありうる。

### 2. Stage 3 行の組み立て（ロジック自体は正しい）

```typescript
// app/page.tsx L293-306
const buildStageModuleProgressRows = (): ProgressRow[] => {
  ...
  for (let stage = 1; stage <= currentStage; stage++) {
    const cardIds = stageHome.cardsByStage.get(stage) ?? []; // 分母 165 はここで正しく取れる
    rows.push({
      ...
      mastered: countMasteredInStageByDirection(module, direction, cardIds, wordProgress),
      total: cardIds.length,
    });
  }
};
```

```typescript
// app/lib/stage-progress.ts L73-88
export function countMasteredInStageByDirection(...) {
  const idSet = new Set(cardIds);
  return wordProgress.filter(
    (p) =>
      p.module === module &&
      p.direction === direction &&
      p.mastered &&
      idSet.has(p.card_id)
  ).length;
}
```

`cardsByStage`（`fetchHomeStageData`）は `cards` テーブルから Stage 別 ID を正しく構築しており、**分母 165 は正しい**。分子だけ `wordProgress` 欠損で 0。

### 3. 参考: 両方向カウントは Stage 表のみ（Progress には未使用）

```typescript
// app/lib/stage-progress.ts L28-37（Listening のみ）
if (module === STAGE_MODULES.LISTENING) {
  ...
  return Array.from(masteredByCard.values()).filter(
    (dirs) => dirs.has("word-to-en") && dirs.has("en-to-word")
  ).length;
}
```

---

## 修正案

### 案 A（推奨）: `word_progress` をページネーションで全件取得

`app/page.tsx` の `fetchData` で 1,000 行ずつループ取得し、結合して `setWordProgress` する。

```typescript
async function fetchAllWordProgress(userId: string) {
  const pageSize = 1000;
  let from = 0;
  const all: WordProgress[] = [];
  while (true) {
    const { data, error } = await supabase
      .from("word_progress")
      .select("*")
      .eq("user_id", userId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}
```

| | |
|--|--|
| **Pros** | 変更範囲が小さい（主に `page.tsx` 1 箇所）。既存の集計関数をそのまま使える。Stage 1–5 すべて改善 |
| **Cons** | ユーザー行数に比例して転送量・メモリ増。将来的にはサーバー集計の方がスケールしやすい |

**補足**: `app/vocabulary/page.tsx`・`app/index-card/page.tsx` も同じ全件取得パターンのため、同様の潜在バグあり。共通化するなら `app/lib/word-progress.ts` にヘルパー抽出を検討。

### 案 B: Home 用に DB 側で Stage 別集計（RPC / View）

`module × direction × stage` ごとの mastered 数を SQL で返す API を追加し、Home は集計済み JSON のみ受け取る。

| | |
|--|--|
| **Pros** | 転送量最小。行数増加に強い |
| **Cons** | マイグレーション + RPC + フロント変更が必要。今回の「最小限修正」方針からは範囲が広い |

### 案 C: Supabase の `max-rows` 設定を引き上げ

| | |
|--|--|
| **Pros** | コード変更なし |
| **Cons** | 根本解決にならない（5,000 行で再発）。本番設定変更が必要 |

**推奨**: **案 A** を `app/page.tsx` に先行適用。余力があれば `fetchAllWordProgress` を共通化して vocabulary / index-card にも適用。

---

## 影響範囲

| 対象 | 影響 |
|------|------|
| Home Progress（全モジュール × 全 Stage） | **修正で改善**。Stage 3 以外も過小表示の可能性あり |
| Home Stage 表 | 同じ `wordProgress` を参照するため **同様に改善** |
| Reading Hiragana/Katakana 行 | `word_progress` 全件依存のため改善の可能性あり |
| `checkAndAdvanceStage`（`stages.ts`） | **影響なし**（サーバー側で直接 `word_progress` クエリ） |
| Listening / 各学習ページ | モジュール絞り込みあり。listening のみでも ~1,600 行になりうるため **別途潜在バグ**（listening page L172–176） |
| TH ユーザー | JP + Stage 表示が無いため Progress は flat 表示だが、`word_progress` 欠損は **同様に起こりうる** |

`MODULE_MAX_STAGE`・`reading_character` の Stage 2 上限とは **無関係**。

---

## 確認方法

### 修正前の再現確認（任意）

1. ブラウザ DevTools → Network → `word_progress` リクエストの Response 行数が **ちょうど 1,000 件**か確認
2. Response Headers の `Content-Range` が `0-999/XXXX` 形式で、総数 XXXX > 1000 なら切り詰め確定
3. Console で Stage 3 の card ID のいずれかに対応する `word_progress` 行が `wordProgress` state に存在するか確認

### 修正後の検証

1. Mirei（JP）で Home を開く
2. Progress 行:
   - `Listening: 🇯🇵→🇬🇧 (Stage 3)` → **77 / 165** 前後
   - `Listening: 🇬🇧→🇯🇵 (Stage 3)` → **8 / 165** 前後
3. Stage 表 Listening × S3 → **約 5%**（8/165、両方向 mastered 定義）
4. Stage 1・2 の表示が **修正前と同値**であること（退行なし）
5. Sentence / Speaking / Reading Word の Stage 3 行も 0 でないこと
6. `npm run build` が通ること

---

## やらなかったこと（指示どおり）

- コード修正・push は未実施
- DB 変更なし
- SQL 再調査なし（Ryo 確認済みデータを前提）

---

最終更新: 2026-07-11

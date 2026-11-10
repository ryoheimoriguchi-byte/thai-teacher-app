# Code Investigation Report (調査結果)

調査日: 2026-05-26  
対象: Reading Character 拡張・Writing Character 新設・`reading_type` 列追加の設計前調査  
方針: **コード変更なし**（リポジトリ現状の読み取りのみ）

---

## サマリ

- **影響が大きい箇所**: `app/reading/page.tsx` の Character モード全体。現状は「Stage 1=ひらがなのみ / Stage 2 以上=カタカナ追加」という **旧2段階モデル** で、`cards.stage` 列も `character_type='kanji'` も出題クエリに使っていない。DB が Stage 1 に清音カタカナ+名前漢字、Stage 2 に濁音+数字漢字…という新構成になっても、**アプリはそのデータを正しく出題・集計できない**。
- **Stage 進行ロジックの二重体系**: 単語系モジュールは `cards.stage` + `user_module_stages.current_stage` で統一。Character 系だけ `stages.ts` / `reading/page.tsx` が **`character_type` 切替（hiragana↔katakana）** で Stage を表現しており、新 DB の `cards.stage` 設計と非整合。
- **mastered 集計**: ほぼすべて **`card_id` 単位**（Listening のみ両 direction 必須）。Reading Character は **`en-to-word` 単方向のみ**。訓読み/音読みを別 `card_id` に分ければ `word_progress` スキーマはそのまま使えるが、採点 API は **1 つの `pronunciation` しか比較しない**。
- **Achievement Badge**: `reading_character` は意図どおり対象外。バッジカウントは **`card_id` ベース**（`cards.category` 単位）。`reading_type` 分割は Reading Character には影響しないが、将来 Writing 用バッジを足すなら `badges.ts` / `emojiMap` の拡張が必要。
- **Stage 3–5 単語**: Listening / Sentence / Speaking / Reading Word は **`lte("stage", currentStage)`** により、Stage 解放さえ進めば **追加コードなしで新単語が出題対象** になる見込み。Index Card / Vocabulary は全 Stage を一括取得し UI フィルタのみ（Stage 4–5 タブ未対応）。

### 設計検討が必要な論点

- Reading Character を **`cards.stage <= current_stage` + `character_type` フィルタ** に統一するか、旧 hiragana/katakana 切替を維持するか
- 漢字の訓読み/音読みを **別 card レコード** にしたとき、採点プロンプト・複数読み（`/` 区切り）の扱い
- Home の Hiragana / Katakana 進捗行を **Stage ベース** に再設計するか（現状は全 hiragana / 全 katakana ID 集合）
- `checkAndAdvanceStage(READING_CHARACTER)` を **cards.stage ベース** に書き換え（現状 Stage 3+ への進行不可）
- Writing Character 新設時のルーティング、`word_progress.module` 名、Stage 表への行追加
- Index Card / Vocabulary の Stage フィルタ UI（現状 Stage 3 まで）を Stage 5 まで拡張するか

---

## 1. Reading Character ページ

### 1-1. 出題ロジック

**対象ファイル/関数**: `app/reading/page.tsx` — `useEffect`（cards 取得）、`pickNextCard`

**現状の動作**:
- Character モード: `type='character'`, `language='JP'`, `character_type IN (...)` で取得。**`cards.stage` フィルタはない**。
- `stageCharacter >= 2` なら `["hiragana","katakana"]`、否则 `["hiragana"]` のみ。**`kanji` は含まれない**。
- `display_order` 昇順でソート。1 セッションあたりの出題数上限はなく、**1 字ずつ**表示。
- 順序: デフォルト「あいうえお順」（`gojuon` = 配列順巡回）または「シャッフル」（デッキ再シャッフル）。
- Word モード: `type='word'`, `lte("stage", stageWord)`、ランダム 1 語。

**コード抜粋**:

```typescript
// app/reading/page.tsx L184-202
if (subMode === "character") {
  const characterTypes =
    stageCharacter >= 2 ? ["hiragana", "katakana"] : ["hiragana"];
  const { data: cardData } = await supabase
    .from("cards")
    .select("*")
    .eq("language", "JP")
    .eq("type", "character")
    .in("character_type", characterTypes)
    .order("display_order", { ascending: true });
} else {
  const { data: cardData } = await supabase
    .from("cards")
    .select("*")
    .eq("language", "JP")
    .eq("type", "word")
    .lte("stage", stageWord);
}
```

**表示**: Character は `fontSize: 72px` で `card.word` を中央表示。Category は `card.category` を小さく表示（DB 上は `'hiragana'` / `'katakana'` 等）。

**新仕様への対応必要性**: **設計検討必要**  
理由: 新 DB の Stage 1（清音カタカナ+漢字混在）・Stage 2（濁音+漢字）と現ロジックが根本的に不一致。`kanji` 非対応、`cards.stage` 未使用。

---

### 1-2. 採点ロジック

**対象ファイル/関数**:
- `app/reading/page.tsx::processAudio`
- `app/api/speaking/route.ts::POST`（`mode === "reading-character"` 分岐）

**現状の動作**:
1. ブラウザで録音 → `/api/speaking` に POST
2. **Whisper** (`whisper-1`, `language: ja`) で文字起こし
3. **Claude** (`claude-sonnet-4-5`) が JSON `{ score, label, heard, feedback, tip }` を返す
4. クライアント: **`score >= 4` を pass** → `consecutive_correct` +1、否则 0
5. **`consecutive_correct >= 3` で mastered**（Reading / Speaking 共通パターン）
6. `word_progress` は **`direction: "en-to-word"` 固定**

**pronunciation 比較**: API プロンプトに `targetPronunciation` を **1 文字列** として渡す。Claude に「期待するひらがな読みと比較」と指示。アプリ側に **`/` 区切り複数読みのパースはない**（`word-breakdown.tsx` の `" / "` split は `breakdown` 列専用）。

**コード抜粋**:

```typescript
// app/reading/page.tsx L402-408
const isPassed = data.score >= 4;
const { mastered, masteredAt } = await updateWordProgress(
  currentUser.id, cardId, moduleKey, "en-to-word", isPassed, currentProgress
);

// app/api/speaking/route.ts L42-52 (reading-character)
// Expected reading in hiragana (correct answer): ${targetPronunciation}
// Compare what was heard to the expected hiragana.
```

**新仕様への対応必要性**: **設計検討必要**  
理由: 訓読み/音読み別レコードなら単一 `pronunciation` 比較は足りるが、1 レコードに複数読みを `/` で入れる方式には未対応。漢字向けプロンプト調整も必要。

---

### 1-3. Stage 切替 UI

**対象ファイル/関数**: `app/reading/page.tsx` — UI タブ、`getUserStage` / `checkAndAdvanceStage`

**現状の動作**:
- **Character / Word のサブモード切替**タブあり（Stage 番号の直接選択 UI は **ない**）
- ひらがな/カタカナの区別は **UI ラベルではなく取得フィルタ**で実施（Stage 1 ユーザーにはカタカナ非表示）
- Stage 番号は `user_module_stages` の `reading_character` / `reading_word` を別管理
- Character の Stage Up は 90% mastered で `stageCharacter++`（演出モーダル表示）

**コード抜粋**:

```typescript
// app/reading/page.tsx L528-550 — Character / Word タブのみ
{ value: "character", label: "Character 文字" },
{ value: "word", label: "Word 単語" },

// characterTypes フィルタ — L185-186
stageCharacter >= 2 ? ["hiragana", "katakana"] : ["hiragana"];
```

**新仕様への対応必要性**: **設計検討必要**  
理由: Stage 3–5 漢字ブロックへの UI・進行モデルが存在しない。

---

### 1-4. `character_type='kanji'` への対応状況

**grep 結果**: アプリ TS/TSX 内に **`'kanji'` リテラルは 0 件**。存在するのは:
- `supabase/migrations/20260513120000_reading_feature.sql`（CHECK 制約）
- `scripts/build-reading-migration.mjs`

**判定**: **kanji を学習対象に含める想定で書かれていない**。DB 制約上は許可されているが、出題・Stage 進行・Home 集計のいずれも未対応。

**新仕様への対応必要性**: **設計検討必要**

---

## 2. word_progress と mastered 集計

### 2-1. word_progress テーブルへの書き込み

| モジュール | ファイル | pass 条件 | mastered 条件 | direction |
|-----------|---------|-----------|---------------|-----------|
| Listening | `app/listening/page.tsx` | 正解 | `consecutive_correct >= 3` | `word-to-en` / `en-to-word` |
| Sentence | `app/sentence-listening/page.tsx` | 正解 | 同上 | 両方向 |
| Speaking | `app/speaking/page.tsx` | `score >= 4` | 同上 | `en-to-word` |
| Reading Character / Word | `app/reading/page.tsx` | `score >= 4` | 同上 | **`en-to-word` のみ** |

**Reading Character の mastered**: pass（score≥4）が **3 回連続**で `mastered=true`（指示書の「score≥4 を3回連続」と一致）。

**コード抜粋**:

```typescript
// app/reading/page.tsx L90-94
const consecutive = isPassed ? (currentProgress?.consecutive_correct ?? 0) + 1 : 0;
const mastered = consecutive >= 3;
```

**新仕様への対応必要性**: **軽微な修正で OK**（訓・音別 card_id ならスキーマ変更不要。module/direction の命名方針だけ確認）

---

### 2-2. 「Stage N での mastered 字数」集計

**実装箇所**:

| 用途 | ファイル | 集計単位 |
|------|---------|---------|
| Home Stage 表 | `app/lib/stage-progress.ts::countMasteredInStage` | **`card_id`**（Listening は両 direction 必須） |
| Home Progress（Stage 別行） | `app/page.tsx` + `countMasteredInStageByDirection` | **`card_id` × direction** |
| Stage Up 判定 | `app/lib/stages.ts::checkAndAdvanceStage` | **`card_id` ユニーク数 / 該当 card 総数** |
| Achievement Badge | `app/lib/badges.ts::checkAndAwardBadges` | **`card_id`**（Listening のみ両 direction） |

**注意**:
- `fetchHomeStageData` の `cardsByStage` は **`type='word'` のみ**。Character（ひらがな/漢字）は Stage 表に **出てこない**。
- Home の「Reading: Hiragana / Katakana」行は **`character_type` で ID 集合を作り**、Stage 列とは無関係。
- **`cards.word` でのグルーピングはどこにもない**。

**新仕様への対応必要性**: **設計検討必要**（Character を `cards.stage` ベースに移行する場合、Home Progress・Stage Up・Home Stage 表すべて見直し）

---

### 2-3. Reading Character の direction

**現状**: **`en-to-word` のみ**。`word-to-en` レコードは作られない。

**訓・音 2 レコード化の想像**:
- 各レコード独立の `card_id` → 現行 upsert（`user_id,card_id,module,direction`）で **別 progress 行**として自然に保存可能
- direction は引き続き `en-to-word` でよい（「文字を読む」方向のみ）
- Badge / Stage 表には Character モジュールが含まれないため、当面バッジへの波及なし

**新仕様への対応必要性**: **無修正で OK**（progress 保存構造としては。採点・出題側は別途）

---

## 3. Achievement Badge

### 3-1. 対象モジュール

**対象ファイル/関数**: `app/lib/badges.ts` — `BADGE_MODULES`

```typescript
export const BADGE_MODULES = [
  "listening",
  "speaking-word",
  "speaking-sentence",
  "reading_word",
  "sentence",
] as const;
// コメント: reading_character は除外
```

**引き継ぎサマリとの一致**: **一致**（`reading_character` なし）。`app/reading/page.tsx` も Word モード pass 時のみ `checkAndAwardBadges(READING_WORD, ...)` を呼ぶ。

**新仕様への対応必要性**: **無修正で OK**（Reading Character / Writing 用バッジを新設する場合のみ拡張）

---

### 3-2. 累計カウントの単位

**対象ファイル/関数**: `app/lib/badges.ts::checkAndAwardBadges`

- カテゴリ内の **全 `card_id`（`type='word'`, 全 Stage 含む）** を母集団
- mastered 数 = **`card_id` ごとに 1 カウント**（Listening は両 direction 揃った card のみ）
- threshold = `floor(masteredCount / 10) * 10`

**漢字訓・音 2 レコード**: Reading Character 対象外のため **バッジには影響しない**。Reading Word / Listening 等で同一 `word` 文字列の card が複数あれば **別 card_id として別カウント**される。

**新仕様への対応必要性**: **軽微な修正で OK**（将来 Writing バッジ追加時は module 定義追加）

---

### 3-3. emojiMap の構造

**対象ファイル/関数**: `app/lib/badges.ts::getBadgeEmoji`

- `Record<string, string[]>` — **カテゴリ名 → 10 段 tier の emoji 配列**
- tier = `Math.ceil(threshold / 10)` でインデックス
- 未定義カテゴリは `["🏆"]` フォールバック
- ハードコードカテゴリ例: `Animals`, `Food`, `Colors`, `Number`, …（約 17 種）

**新カテゴリ（Kana Writing / Kanji Writing）追加時**:
- `emojiMap` にキー追加
- `checkAndAwardBadges` のカテゴリ一覧は DB から動的取得のため、**cards.category に新カテゴリが入れば自動対象**（emoji だけ要追加）
- Achievement UI のモジュールタブは `BADGE_MODULES` ベース — Writing 用タブも別途必要

**新仕様への対応必要性**: **軽微な修正で OK**（新カテゴリ追加時）

---

## 4. 他モジュールのカード取得ロジック

### 4-1. cards 取得 WHERE 句（学習ページ）

| モジュール | ファイル | type | language | stage |
|-----------|---------|------|----------|-------|
| Listening | `app/listening/page.tsx` | `word` | `currentUser.language` | **`lte(stage, currentStage)`** |
| Sentence | `app/sentence-listening/page.tsx` | `word` | `filterLanguage` | **`lte(stage, currentStage)`** |
| Speaking (Word/Sentence) | `app/speaking/page.tsx` | `word` | `currentUser.language` | **`lte(stage, activeStage)`** |
| Reading Word | `app/reading/page.tsx` | `word` | `JP` | **`lte(stage, stageWord)`** |
| Reading Character | `app/reading/page.tsx` | `character` | `JP` | **なし**（character_type のみ） |

**Stage 3–5 単語**: 単語系 4 モジュールは **`current_stage` が進めば自動的に新 Stage の card が pool に入る**。追加実装不要（前提: `user_module_stages` が正しく更新されること）。

**Index Card / Vocabulary**: `type='word'` のみ全件取得。**stage によるサーバ側フィルタなし**。UI で Stage 1–3 タブフィルタ（`card.stage === N`）。

---

### 4-2. ハードコードの有無

| 種類 | 箇所 | 内容 |
|------|------|------|
| Character Stage モデル | `reading/page.tsx`, `stages.ts` | Stage 1=hiragana, Stage 2+=katakana（**cards.stage 不使用**） |
| Stage フィルタ UI | `index-card/page.tsx`, `vocabulary/page.tsx` | Stage 1–3 ボタンのみ（**4–5 なし**） |
| カテゴリ名 | `badges.ts::emojiMap` | 17 カテゴリ名ハードコード |
| カテゴリ名 | 学習ページ distractor 生成 | DB から動的（`card.category`）— 特定名の固定リストなし |
| Home Character 進捗 | `app/page.tsx` | `character_type === 'hiragana'|'katakana'` 固定 |

**新仕様への対応必要性**: **設計検討必要**（Character 系）/ **軽微な修正で OK**（Index Card Stage 4–5 タブ）

---

## 5. Stage Up 演出

**対象ファイル/関数**: `app/lib/stage-up-celebration.tsx::StageUpCelebration`

**現状の動作**:
- `MODULE_LABELS` で内部 module 名 → 表示名（例: `reading_character` → `"Reading"`）
- 文言: `Stage {newStage}` + `{displayModule} unlocked!` + `You mastered {masteredCount} words`
- **漢字専用演出なし** — 全モジュール共通 UI + confetti
- Reading Character でも `masteredCount` は `checkAndAdvanceStage` の戻り値（character_type ベース集計）

**コード抜粋**:

```typescript
const MODULE_LABELS: Record<string, string> = {
  listening: "Listening",
  reading_character: "Reading",
  reading_word: "Reading",
  // ...
};
const displayModule = MODULE_LABELS[moduleName] ?? moduleName;
```

**新仕様への対応必要性**: **軽微な修正で OK**（Writing 追加時はラベル追加。「words」表記が Character に不適切な点は任意改善）

---

## 6. その他気付いた点

### DB とコードの乖離（重要）

新 DB 仕様（Stage 1 = ひら+カタ+名前漢字 96 字等）に対し、コードは以下の **旧仕様** のまま:

| 項目 | コード | 新 DB（指示書） |
|------|--------|----------------|
| Character Stage 1 | hiragana のみ | 清音ひら+カタ+名前漢字 |
| Character Stage 2 | +katakana | 濁/半濁/拗音+数字漢字 |
| kanji | 出題対象外 | Stage 1–2 に含む |
| Stage 進行 | character_type 切替 | cards.stage 想定？ |

→ **DB 更新済み・コード未更新** の状態では、Character モードの出題数・内容・Stage Up 条件が意図とずれる可能性が高い。

### `reading_type` 列

- リポジトリ内に **`reading_type` 参照 0 件**
- 将来追加時は `Card` 型、Supabase select、採点プロンプト、UI 表示の全層に波及

### Home Stage 表に Character 行がない

- `HOME_STAGE_ROWS` は Listening / Speaking / Reading(Word) / Sentence の 4 行のみ
- Character 進捗は Progress セクションの Hiragana/Katakana 行（Stage 非連動）

### `display_order`

- Character の gojuon 順は `display_order` 列依存（`reading/page.tsx`）
- 新規 697 字追加時、この列の整合が UI 順序に直結

### Writing Character 新設

- ルート・ページ・`word_progress.module` 値・Home 集計・Bottom Nav すべて **未存在**
- 手書き入力 UI / 認識 API も未実装

### Badge 判定の Stage 非フィルタ

- `checkAndAwardBadges` はカテゴリ内 **全 Stage の card_id** を母集団にする
- 未解放 Stage の語は学習できないため mastered にはならないが、**「カテゴリ全語数に対する割合」ではなく絶対数 threshold** 設計

---

## 補足: 質問・要確認事項

1. **Reading Character の Stage モデル**: 新 DB の `cards.stage`（1–5）に **`user_module_stages.reading_character` を直結**する設計で確定か？ それとも Character だけ 1–2 のサブセットか？
2. **Home の Hiragana/Katakana 行**: Stage ベースの Character 行に統合するか、文字種別表示を維持するか？
3. **漢字の 1 字 2 レコード**: `word` 列の表記（例: `日(ひ)` / `日(にち)`）と `reading_type` 列の役割分担
4. **複数読み**: 1 レコードに `もり / シン` のような `/` 区切りを入れる想定か、必ずレコード分割か
5. **Writing Character**: `word_progress.module` 名、`cards.type`（`character` 流用 vs 新 type）、Stage 表への掲載要否
6. **Index Card / Vocabulary**: Stage 4–5 フィルタ UI を追加するタイミング

---

## 調査ファイル一覧（主要）

| ファイル | 調査用途 |
|---------|---------|
| `app/reading/page.tsx` | Character 出題・採点・progress |
| `app/api/speaking/route.ts` | Whisper + Claude 採点 |
| `app/lib/stages.ts` | Stage Up（Character 特殊分岐） |
| `app/lib/stage-progress.ts` | Home Stage 表集計 |
| `app/page.tsx` | Home Progress（Stage 別・Character 行） |
| `app/lib/badges.ts` | Badge 対象・カウント・emojiMap |
| `app/listening/page.tsx` | 単語 Stage フィルタ参考 |
| `app/speaking/page.tsx` | 同上 |
| `app/sentence-listening/page.tsx` | 同上 |
| `app/index-card/page.tsx` | Stage UI 参考 |
| `app/vocabulary/page.tsx` | 同上 |
| `app/lib/stage-up-celebration.tsx` | Stage Up UI |
| `supabase/migrations/20260513120000_reading_feature.sql` | character_type 制約 |

---

*本報告はコード調査のみ。実装・DB 変更は行っていない。*

/**
 * Conversation MVP - シナリオとフレーズ定義
 *
 * 設計方針:
 * - フレーズ判定はセッション非依存。どのシナリオでの発話でも ALL_PHRASES 全体と照合する
 * - kind: 'card'     … 既存 cards テーブルに実在する語（cardWords が cards.word と一致）
 * - kind: 'template' … cards には存在しない構文パターン。slots に入る語は cards から供給される
 * - variants は判定で「同じフレーズを使った」とみなす言い方。意味が変わる表現は含めない
 */

export type PhraseKind = 'card' | 'template';

export interface ConversationPhrase {
  id: string;
  kind: PhraseKind;
  ja: string;
  en: string;
  /** kind==='card' のとき、対応する cards.word。いずれか1つでも使えば達成 */
  cardWords?: string[];
  /** kind==='template' のとき、枠に入る cards.category */
  slots?: string[];
  /** 判定で認める言い換え・表記ゆれ・カジュアル形 */
  variants: string[];
  /** Claude への判定補足 */
  note?: string;
}

export interface ConversationScenario {
  id: string;
  /** 子供向けタイトル（ひらがな） */
  title: string;
  titleEn: string;
  /** 開始前に表示する場面説明（ひらがな） */
  intro: string;
  /** 先生が演じる役 */
  tutorRole: string;
  /** クリア閾値（フレーズ数に対する割合）。累積判定 */
  clearThreshold: number;
  phrases: ConversationPhrase[];
  /**
   * Claude に渡す mastered 語彙（cards.word）を絞り込む cards.category。
   * null はカテゴリで絞り込まない（全カテゴリを渡す）。
   * プロンプトの input tokens 削減が目的（レイテンシへの効果は確認できなかったが、
   * コスト削減として本採用。Step B 補足検証タスク5参照）。
   */
  vocabCategories: string[] | null;
}

/* ------------------------------------------------------------------ */
/* シナリオ B: おみせで かいもの                                        */
/* ------------------------------------------------------------------ */

const SHOPPING_PHRASES: ConversationPhrase[] = [
  {
    id: 'shop-01',
    kind: 'card',
    ja: 'こんにちは',
    en: 'Hello',
    cardWords: ['こんにちは'],
    variants: ['こんにちわ'],
  },
  {
    id: 'shop-02',
    kind: 'card',
    ja: 'すみません',
    en: 'Excuse me',
    cardWords: ['すみません'],
    variants: ['すいません'],
    note: '店員を呼ぶ用法。謝罪の意味でも達成とみなす',
  },
  {
    id: 'shop-03',
    kind: 'template',
    ja: '〜は ありますか',
    en: 'Do you have ~?',
    slots: ['Food'],
    variants: ['〜 ありますか', '〜って ありますか', '〜 ある'],
  },
  {
    id: 'shop-04',
    kind: 'template',
    ja: '〜を ください',
    en: '~ please',
    slots: ['Food'],
    variants: ['〜 ください', '〜を おねがいします', '〜 おねがいします'],
  },
  {
    id: 'shop-05',
    kind: 'template',
    ja: 'ひとつ / ふたつ / みっつ / よっつ',
    en: 'one / two / three / four (counting)',
    slots: ['Number'],
    variants: ['いっこ', 'にこ', 'さんこ', 'よんこ'],
    note: 'cards の助数詞は よっつ まで。いつつ以降は未習なので要求しない',
  },
  {
    id: 'shop-06',
    kind: 'card',
    ja: 'これはなんですか',
    en: 'What is this?',
    cardWords: ['これはなんですか'],
    variants: ['これ なんですか', 'これ なに', 'それは なんですか'],
  },
  {
    id: 'shop-07',
    kind: 'card',
    ja: 'いくらですか',
    en: 'How much is it?',
    cardWords: ['いくらですか', 'いくら'],
    variants: ['これ いくら', 'いくらかな'],
  },
  {
    id: 'shop-08',
    kind: 'card',
    ja: 'たかい / やすい',
    en: 'expensive / cheap',
    cardWords: ['たかい', 'やすい'],
    variants: ['たかいです', 'やすいです', 'たかいね', 'やすいね'],
  },
  {
    id: 'shop-09',
    kind: 'template',
    ja: '〜が すきです',
    en: 'I like ~',
    slots: ['Food'],
    variants: ['〜 すき', '〜が すき', '〜 だいすき'],
  },
  {
    id: 'shop-10',
    kind: 'card',
    ja: 'おいしい',
    en: 'Delicious',
    cardWords: ['おいしい'],
    variants: ['おいしいです', 'おいしそう'],
  },
  {
    id: 'shop-11',
    kind: 'card',
    ja: 'ありがとう',
    en: 'Thank you',
    cardWords: ['ありがとう'],
    variants: ['ありがとうございます', 'ありがと'],
  },
  {
    id: 'shop-12',
    kind: 'card',
    ja: 'さようなら',
    en: 'Goodbye',
    cardWords: ['さようなら'],
    variants: ['さよなら', 'バイバイ', 'またね'],
  },
];

/* ------------------------------------------------------------------ */
/* シナリオ C: かぞくの しょうかい                                      */
/* ------------------------------------------------------------------ */

const FAMILY_PHRASES: ConversationPhrase[] = [
  {
    id: 'fam-01',
    kind: 'card',
    ja: 'はじめまして',
    en: 'Nice to meet you',
    cardWords: ['はじめまして'],
    variants: [],
  },
  {
    id: 'fam-02',
    kind: 'card',
    ja: 'かぞく',
    en: 'Family',
    cardWords: ['かぞく'],
    variants: ['かぞくです', 'うちの かぞく'],
  },
  {
    id: 'fam-03',
    kind: 'template',
    ja: '〜が います',
    en: 'I have ~',
    slots: ['Family'],
    variants: ['〜が いる', '〜も います', '〜が いるよ'],
  },
  {
    id: 'fam-04',
    kind: 'card',
    ja: 'おとうさん / おかあさん',
    en: 'Father / Mother',
    cardWords: ['おとうさん', 'おかあさん'],
    variants: ['パパ', 'ママ'],
  },
  {
    id: 'fam-05',
    kind: 'card',
    ja: 'おにいさん / おねえさん / おとうと / いもうと',
    en: 'Older brother / Older sister / Younger brother / Younger sister',
    cardWords: ['おにいさん', 'おねえさん', 'おとうと', 'いもうと'],
    variants: ['おにいちゃん', 'おねえちゃん'],
  },
  {
    id: 'fam-06',
    kind: 'card',
    ja: 'おじいさん / おばあさん',
    en: 'Grandfather / Grandmother',
    cardWords: ['おじいさん', 'おばあさん'],
    variants: ['おじいちゃん', 'おばあちゃん'],
  },
  {
    id: 'fam-07',
    kind: 'template',
    ja: '〜は やさしいです',
    en: '~ is kind',
    slots: ['Family', 'Adjectives'],
    variants: ['〜は やさしい', '〜 やさしいよ'],
    note: 'やさしい 以外の Adjectives でも「家族 + 形容詞」の形なら達成とみなす',
  },
  {
    id: 'fam-08',
    kind: 'template',
    ja: '〜は げんきです',
    en: '~ is energetic',
    slots: ['Family'],
    variants: ['〜は げんき', '〜 げんきだよ'],
  },
  {
    id: 'fam-09',
    kind: 'template',
    ja: '〜は 〜が すきです',
    en: '~ likes ~',
    slots: ['Family', 'Food'],
    variants: ['〜は 〜が すき'],
    note: '主語が自分以外であることが条件。「わたしが すき」は shop-09 側で拾う',
  },
  {
    id: 'fam-10',
    kind: 'template',
    ja: '〜と あそびます',
    en: 'I play with ~',
    slots: ['Family'],
    variants: ['〜と あそぶ', '〜と あそんだ', '〜と あそびたい'],
  },
  {
    id: 'fam-11',
    kind: 'card',
    ja: 'たのしい',
    en: 'Fun',
    cardWords: ['たのしい'],
    variants: ['たのしいです', 'たのしかった'],
  },
  {
    id: 'fam-12',
    kind: 'card',
    ja: 'ありがとう',
    en: 'Thank you',
    cardWords: ['ありがとう'],
    variants: ['ありがとうございます', 'ありがと'],
  },
];

/* ------------------------------------------------------------------ */
/* シナリオ定義                                                        */
/* ------------------------------------------------------------------ */

export const SCENARIOS: ConversationScenario[] = [
  {
    id: 'shopping',
    title: 'おみせで かいもの',
    titleEn: 'Shopping at a store',
    intro: 'おみせに きました。てんいんさんと はなしてみよう。',
    tutorRole: 'おみせの てんいんさん',
    clearThreshold: 0.7,
    phrases: SHOPPING_PHRASES,
    vocabCategories: ['Food', 'Number', 'Greetings', 'Adjectives', 'Useful Phrases', 'Colors'],
  },
  {
    id: 'family',
    title: 'かぞくの しょうかい',
    titleEn: 'Introducing your family',
    intro: 'あたらしい ともだちに かぞくの ことを おしえてあげよう。',
    tutorRole: 'あたらしい ともだち',
    clearThreshold: 0.7,
    phrases: FAMILY_PHRASES,
    vocabCategories: ['Family', 'Adjectives', 'Greetings', 'Useful Phrases', 'Common Verbs'],
  },
  {
    id: 'freetalk',
    title: 'なんでも おしゃべり',
    titleEn: 'Free talk',
    intro: 'すきなことを なんでも はなそう。',
    tutorRole: 'にほんごの せんせい',
    clearThreshold: 0,
    phrases: [],
    vocabCategories: null,
  },
];

/* ------------------------------------------------------------------ */
/* 判定用のフラット辞書                                                */
/* ------------------------------------------------------------------ */

/**
 * 全シナリオのフレーズを統合したマスタ。
 * 判定はセッション非依存なので、どのシナリオ中の発話もこの全体と照合する。
 * ありがとう が 2シナリオに登場するため id で重複排除している。
 */
export const ALL_PHRASES: ConversationPhrase[] = Array.from(
  new Map(
    SCENARIOS.flatMap((s) => s.phrases).map((p) => [p.ja, p] as const)
  ).values()
);

export function getScenario(id: string): ConversationScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * そのシナリオで mastered 語彙を絞り込む cards.category の一覧。
 * シナリオが見つからない、または絞り込み設定が null の場合は undefined
 * （呼び出し側で「絞り込まない」の意味として扱う）。
 */
export function getVocabCategories(scenarioId: string): string[] | undefined {
  return getScenario(scenarioId)?.vocabCategories ?? undefined;
}

/** そのフレーズがどのシナリオのクリア判定に効くか（1フレーズが複数に属し得る） */
export function scenariosForPhrase(phraseJa: string): string[] {
  return SCENARIOS.filter((s) => s.phrases.some((p) => p.ja === phraseJa)).map(
    (s) => s.id
  );
}

/**
 * Conversation can-do 定義・ミッション選定・達成判定（Step C3）
 *
 * 仕様の正: conversation_candos_stage1_2.md（Ryo から提供、リポジトリには無い）。
 * ここではその仕様をコードに落としたもの。判定ロジックは非対称:
 *   - 成功: ミッションかどうかに関わらず +1（偶然使えた分も加点）
 *   - 失敗（リセット）: その can-do がミッションとして提示された回のみ
 *   - 機会なし（そもそもフレーズが出てこなかった）: 何もしない。連続は途切れない
 *   - 達成済み（achieved=true）は不変。二度と変えない
 *   - support_given が null のターンは成功として数えない（フラグ導入前のデータ除外）
 *
 * 方略 can-do（S1-basic-02 / S1-basic-03, isStrategy: true）は上記と別扱い:
 *   - 支援の有無を問わない（support_given を見ない）
 *   - 2026-09-19: ミッション候補には含める（以前は除外していた。会話の流れで
 *     自然に出る機会がほとんどなく、構造的に達成されにくかったため）
 *   - ただしミッションだったのに使われなくても、リセットは絶対にしない
 *     （今日たまたま助けが要らなかっただけ、という可能性が高いため）
 */

export interface ConversationCando {
  id: string; // 'S1-basic-01'
  stage: number; // 1 | 2
  topic: string; // 'basic' | 'shop' | 'family' | 'food' | 'school' | 'play' | 'daily' | 'out'
  en: string; // 'Greet and say goodbye'
  ja: string; // 'あいさつをして、あいさつを返すことができる'
  example: string; // 表示用の例文（ひらがな）
  phraseIds: string[]; // 対応フレーズ。いずれか1つでカウント対象
  scenarioIds: string[]; // ミッションとして提示しうるシナリオ（freetalk は含めない）
  /**
   * 方略 can-do（S1-basic-02 / S1-basic-03）。支援の有無を問わず、失敗リセットもない。
   * 2026-09-19: ミッション候補からは除外しなくなった（selectMissionCandos 参照）。
   */
  isStrategy?: boolean;
}

/* ------------------------------------------------------------------ */
/* Stage 1（10個）                                                     */
/* ------------------------------------------------------------------ */

const STAGE_1_CANDOS: ConversationCando[] = [
  {
    id: 'S1-basic-01',
    stage: 1,
    topic: 'basic',
    en: 'Greet and say goodbye',
    ja: 'あいさつをして、あいさつを返すことができる',
    example: 'こんにちは。さようなら。',
    phraseIds: ['shop-01', 'shop-11', 'shop-12', 'fam-01'],
    // school added (2026-09-19, issue B): without it, 'school' had only one
    // mission-eligible Stage-1 cando (S1-basic-05), so selectMissionCandos
    // could never present 2 missions for that scenario. Greeting/goodbye is
    // generic enough to apply there too (e.g. greeting the teacher).
    scenarioIds: ['shopping', 'family', 'school'],
  },
  {
    id: 'S1-basic-02',
    stage: 1,
    topic: 'basic',
    en: "Say when you don't understand",
    ja: 'わからないときに、わからないと伝えることができる',
    example: 'わかりません。',
    phraseIds: ['P-01'],
    // 2026-09-19: 方略 can-do は場面に依存しないため、freetalk を除く全
    // シナリオに紐づける（以前は空でミッション候補になれなかった）。
    scenarioIds: ['shopping', 'family', 'school', 'food'],
    isStrategy: true,
  },
  {
    id: 'S1-basic-03',
    stage: 1,
    topic: 'basic',
    en: 'Ask someone to repeat or slow down',
    ja: 'もう一度言ってほしい、ゆっくり言ってほしいと頼むことができる',
    example: 'もういちど いってください。',
    phraseIds: ['P-02'],
    // 2026-09-19: 上の S1-basic-02 と同じ理由で全シナリオに紐づける。
    scenarioIds: ['shopping', 'family', 'school', 'food'],
    isStrategy: true,
  },
  {
    id: 'S1-basic-04',
    stage: 1,
    topic: 'basic',
    en: 'Say your name',
    ja: '自分の名前を言うことができる',
    example: 'わたしは みれい です。',
    phraseIds: ['P-03'],
    // school added (2026-09-19, issue B): same reasoning as S1-basic-01 —
    // saying your name naturally comes up when talking to a teacher too.
    scenarioIds: ['family', 'school'],
  },
  {
    id: 'S1-basic-05',
    stage: 1,
    topic: 'basic',
    en: 'Ask a simple question',
    ja: 'なに・どこ・いつ を使ってかんたんな質問をすることができる',
    example: 'これは なに？',
    phraseIds: ['P-04'],
    scenarioIds: ['shopping', 'family', 'school', 'food'],
  },
  {
    id: 'S1-shop-01',
    stage: 1,
    topic: 'shop',
    en: 'Ask for what you want',
    ja: 'ほしいものを言って買うことができる',
    example: 'りんごを ください。',
    phraseIds: ['shop-04'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S1-shop-02',
    stage: 1,
    topic: 'shop',
    en: 'Ask what something is',
    ja: 'これは何かとたずねることができる',
    example: 'これは なんですか。',
    phraseIds: ['shop-06'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S1-shop-03',
    stage: 1,
    topic: 'shop',
    en: 'Ask the price',
    ja: '値段をたずねることができる',
    example: 'いくらですか。',
    phraseIds: ['shop-07'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S1-shop-04',
    stage: 1,
    topic: 'shop',
    en: 'Say what you like',
    ja: '好きなものを言うことができる',
    example: 'りんごが すきです。',
    phraseIds: ['shop-09'],
    scenarioIds: ['shopping', 'food'],
  },
  {
    id: 'S1-fam-01',
    stage: 1,
    topic: 'family',
    en: 'Name your family members',
    ja: '家族のよびかたを使って、だれのことか答えることができる',
    example: 'おかあさん。おにいさん。',
    phraseIds: ['fam-04', 'fam-05', 'fam-06'],
    scenarioIds: ['family'],
  },
];

/* ------------------------------------------------------------------ */
/* Stage 2（16個）                                                     */
/* ------------------------------------------------------------------ */

const STAGE_2_CANDOS: ConversationCando[] = [
  {
    id: 'S2-basic-01',
    stage: 2,
    topic: 'basic',
    en: 'Say how you feel',
    ja: '気分や体調を言うことができる',
    example: 'つかれた。げんき。',
    phraseIds: ['P-05'],
    scenarioIds: ['shopping', 'family', 'school', 'food'],
  },
  {
    id: 'S2-shop-01',
    stage: 2,
    topic: 'shop',
    en: 'Say how many you want',
    ja: 'ほしい数を言うことができる',
    example: 'よっつ ください。',
    phraseIds: ['shop-05'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S2-shop-02',
    stage: 2,
    topic: 'shop',
    en: 'Ask if the shop has something',
    ja: '店に品物があるかたずねることができる',
    example: 'パンは ありますか。',
    phraseIds: ['shop-03'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S2-shop-03',
    stage: 2,
    topic: 'shop',
    en: 'Say what you think of something',
    ja: 'ものの感想を言うことができる',
    example: 'たかい。おいしい。',
    phraseIds: ['shop-08', 'shop-10'],
    scenarioIds: ['shopping'],
  },
  {
    id: 'S2-fam-01',
    stage: 2,
    topic: 'family',
    en: 'Say who is in your family',
    ja: '家族にだれがいるか言うことができる',
    example: 'おとうさんが います。',
    phraseIds: ['fam-03'],
    scenarioIds: ['family'],
  },
  {
    id: 'S2-fam-02',
    stage: 2,
    topic: 'family',
    en: 'Describe what your family is like',
    ja: '家族がどんな人か言うことができる',
    example: 'おかあさんは やさしいです。',
    phraseIds: ['fam-07', 'fam-08'],
    scenarioIds: ['family'],
  },
  {
    id: 'S2-fam-03',
    stage: 2,
    topic: 'family',
    en: 'Say what you do with your family',
    ja: '家族といっしょに何をするか言うことができる',
    example: 'おとうとと あそびます。',
    phraseIds: ['fam-10'],
    scenarioIds: ['family'],
  },
  {
    id: 'S2-food-01',
    stage: 2,
    topic: 'food',
    en: "Say which foods you like and don't like",
    ja: '好きな食べものと苦手な食べものを言うことができる',
    example: 'なっとうは すきじゃない。',
    phraseIds: ['P-06'],
    scenarioIds: ['food'],
  },
  {
    id: 'S2-food-02',
    stage: 2,
    topic: 'food',
    en: 'Say what you want to eat',
    ja: '食べたいものを言うことができる',
    example: 'ラーメンが たべたい。',
    phraseIds: ['P-07'],
    scenarioIds: ['food'],
  },
  {
    id: 'S2-school-01',
    stage: 2,
    topic: 'school',
    en: 'Name things you use at school',
    ja: '学校で使うものを言うことができる',
    example: 'えんぴつを つかいます。',
    phraseIds: ['P-08'],
    scenarioIds: ['school'],
  },
  {
    id: 'S2-school-02',
    stage: 2,
    topic: 'school',
    en: 'Say what you do at school',
    ja: '学校で何をするか言うことができる',
    example: 'がっこうで べんきょうします。',
    phraseIds: ['P-09'],
    scenarioIds: ['school'],
  },
  {
    id: 'S2-school-03',
    stage: 2,
    topic: 'school',
    en: 'Talk about your friends and teacher',
    ja: '友だちや先生について話すことができる',
    example: 'ともだちと あそびました。',
    phraseIds: ['P-10'],
    scenarioIds: ['school'],
  },
  {
    id: 'S2-play-01',
    stage: 2,
    topic: 'play',
    en: 'Say what you do for fun',
    ja: '何をして遊ぶか言うことができる',
    example: 'えを かいて あそびます。',
    phraseIds: ['P-11'],
    // 現時点で対応するシナリオがない（conversation_candos_stage1_2.md
    // 未解決の論点3）。ミッションには出さないが、他シナリオで偶然使えた
    // 場合は success として加点される。
    scenarioIds: [],
  },
  {
    id: 'S2-daily-01',
    stage: 2,
    topic: 'daily',
    en: 'Say what day it is',
    ja: 'きょうは何曜日か言うことができる',
    example: 'きょうは げつようびです。',
    phraseIds: ['P-12'],
    scenarioIds: [],
  },
  {
    id: 'S2-daily-02',
    stage: 2,
    topic: 'daily',
    en: 'Say what you do in the morning or at night',
    ja: '朝や夜に何をするか言うことができる',
    example: 'あさ ごはんを たべます。',
    phraseIds: ['P-13'],
    scenarioIds: [],
  },
  {
    id: 'S2-out-01',
    stage: 2,
    topic: 'out',
    en: 'Talk about the weather',
    ja: '天気について言うことができる',
    example: 'きょうは はれです。',
    phraseIds: ['P-14'],
    scenarioIds: [],
  },
];

export const ALL_CANDOS: ConversationCando[] = [...STAGE_1_CANDOS, ...STAGE_2_CANDOS];

export function getCando(id: string): ConversationCando | undefined {
  return ALL_CANDOS.find((c) => c.id === id);
}

export function candosForStage(stage: number): ConversationCando[] {
  return ALL_CANDOS.filter((c) => c.stage === stage);
}

/* ------------------------------------------------------------------ */
/* Step C5: Achievement「Talking」タブ用の Stage メタデータ              */
/* ------------------------------------------------------------------ */

/** Stage 1〜5 の表示名・説明。3〜5 は can-do 未定義だが、天井として枠だけ表示する。 */
export const STAGE_INFO: { stage: number; name: string; description: string }[] = [
  { stage: 1, name: 'First words', description: 'Answer with single words and set phrases' },
  { stage: 2, name: 'Simple sentences', description: 'Say a bit more than one word' },
  { stage: 3, name: 'Asking & explaining', description: 'Ask questions and give reasons' },
  { stage: 4, name: 'Past & plans', description: 'Talk about yesterday and tomorrow' },
  { stage: 5, name: 'Real conversations', description: 'Keep a conversation going' },
];

/** トピック id → 表示ラベル（Achievement タブの見出し）。 */
export const TOPIC_LABELS: Record<string, string> = {
  basic: 'Basics',
  shop: 'Shopping',
  family: 'Family',
  food: 'Food',
  school: 'School',
  play: 'Play',
  daily: 'Daily',
  out: 'Out and about',
};

/* ------------------------------------------------------------------ */
/* ミッション選定                                                      */
/* ------------------------------------------------------------------ */

export interface CandoProgressState {
  consecutiveSuccess: number;
  achieved: boolean;
}

/**
 * セッション開始時に提示するミッション（最大2件）を選ぶ。
 * freetalk は常に空配列（呼び出し側で scenarioId==='freetalk' を渡せばそうなる —
 * freetalk の can-do は無いため候補が自然に0件になる）。
 */
export function selectMissionCandos(params: {
  scenarioId: string;
  currentStage: number;
  progressByCandoId: Map<string, CandoProgressState>;
}): ConversationCando[] {
  // 2026-09-19: 方略 can-do（isStrategy）もミッション候補に含める（以前は
  // 除外していた）。失敗判定をしない扱いは judgeCandos 側のロジックが
  // 引き続き担っている（isStrategy 分岐は wasMission を見ない）ので、ここで
  // 除外する必要はない。
  const candidates = ALL_CANDOS.filter(
    (c) =>
      c.stage <= params.currentStage &&
      c.scenarioIds.includes(params.scenarioId) &&
      !(params.progressByCandoId.get(c.id)?.achieved ?? false)
  );

  const ranked = candidates
    .map((c) => ({
      cando: c,
      consecutive: params.progressByCandoId.get(c.id)?.consecutiveSuccess ?? 0,
      rand: Math.random(),
    }))
    .sort((a, b) => b.consecutive - a.consecutive || a.rand - b.rand);

  return ranked.slice(0, 2).map((r) => r.cando);
}

/* ------------------------------------------------------------------ */
/* 達成判定                                                            */
/* ------------------------------------------------------------------ */

/** 1回のセッション内で「生徒が発話し、先生がそれに応じた」1往復ぶんの記録。 */
export interface CandoJudgmentEvent {
  /** その往復での生徒の発話に含まれていたフレーズ（review 採点結果）。 */
  phrasesUsed: string[];
  /**
   * その生徒の発話に対して、直後の先生の返答が与えた支援。
   * null は support_given 導入前のデータ（このイベントは成功として数えない）。
   */
  supportGiven: string | null;
  /**
   * Step C4.2: 生徒がこの発話をする前に、先生のその発話に対して Show
   * English を押していたか。押していれば「助けを借りた」ため、非方略
   * can-do の成功判定からは除外する（方略 can-do は対象外）。
   */
  translationShown: boolean;
}

export interface CandoJudgmentResult {
  candoId: string;
  before: number;
  after: number;
  beforeAchieved: boolean;
  achieved: boolean;
  justAchieved: boolean;
}

/**
 * セッション終了時の can-do 判定。既に achieved な can-do は完全にスキップする
 * （consecutive_success も含めて一切変更しない）。
 *
 * 戻り値には「このセッションで値が動いた can-do のみ」を含める
 * （機会なしで変化しなかったものは含めない）。
 */
export function judgeCandos(params: {
  events: CandoJudgmentEvent[];
  missionCandoIds: string[];
  progressByCandoId: Map<string, CandoProgressState>;
  /**
   * 現在の会話 Stage。cando.stage がこれを超える can-do は、成功・失敗とも
   * 一切判定しない（偶然の成功であっても加点しない）。理由: 加点だけ許すと、
   * 現在の Stage を卒業する前に次の Stage が虫食いで埋まってしまい、
   * 「Stage を順番に卒業する」という設計の意味が失われるため。
   */
  currentStage: number;
}): CandoJudgmentResult[] {
  const results: CandoJudgmentResult[] = [];

  for (const cando of ALL_CANDOS) {
    if (cando.stage > params.currentStage) continue;

    const prev = params.progressByCandoId.get(cando.id) ?? {
      consecutiveSuccess: 0,
      achieved: false,
    };

    // 達成済みは不変。consecutive_success の更新も止める。
    if (prev.achieved) continue;

    let consecutive = prev.consecutiveSuccess;

    if (cando.isStrategy) {
      // 方略 can-do: 支援の有無を問わない。ミッション候補にはなり得るが
      // （2026-09-19〜）、意図的に wasMission を見ない — ミッションだった
      // のに使われなくても何もしない（リセットしない）。
      const used = params.events.some((e) => e.phrasesUsed.some((p) => cando.phraseIds.includes(p)));
      if (used) consecutive += 1;
    } else {
      const wasMission = params.missionCandoIds.includes(cando.id);
      const success = params.events.some(
        (e) =>
          e.supportGiven === 'none' &&
          !e.translationShown &&
          e.phrasesUsed.some((p) => cando.phraseIds.includes(p))
      );
      if (success) {
        consecutive += 1;
      } else if (wasMission) {
        consecutive = 0; // 機会があったのに使えなかった
      }
      // else: 機会なし。何もしない（連続は途切れない）
    }

    const achieved = consecutive >= 3;

    if (consecutive !== prev.consecutiveSuccess || achieved !== prev.achieved) {
      results.push({
        candoId: cando.id,
        before: prev.consecutiveSuccess,
        after: consecutive,
        beforeAchieved: prev.achieved,
        achieved,
        justAchieved: achieved && !prev.achieved,
      });
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* 「自分で答えた」統計（振り返り画面・累計指標・can-do 判定で共通利用）  */
/* ------------------------------------------------------------------ */

/** turnsAnsweredAlone の判定に必要な最小限の行の形（conversation_turns の一部）。 */
export interface TurnAnsweredAloneRow {
  transcript: string | null;
  support_given: string | null;
  translation_shown: boolean;
}

/**
 * セッション内の「自分で答えたターン数」を数える、唯一の判定ロジック。
 * turns[i] の transcript（生徒の発話）を、turns[i+1].support_given（それに
 * 対する先生の返答が与えた支援）と turns[i].translation_shown（その先生の
 * 発話を Show English してから答えたか）の両方で判定する。
 *
 * 呼び出し元: 振り返り画面（現在のセッション・前回セッション比較）、
 * judgeCandos に渡す events の元データ、Achievement タブの累計指標。
 * ここ以外で同じ判定を書かないこと。
 */
export function computeTurnsAnsweredAloneStats(turns: TurnAnsweredAloneRow[]): {
  turnsAnsweredAlone: number;
  turnsTotal: number;
} {
  let turnsTotal = 0;
  let turnsAnsweredAlone = 0;
  for (let i = 0; i < turns.length - 1; i++) {
    if (!turns[i].transcript) continue;
    turnsTotal++;
    if (turns[i + 1].support_given === 'none' && !turns[i].translation_shown) {
      turnsAnsweredAlone++;
    }
  }
  return { turnsAnsweredAlone, turnsTotal };
}

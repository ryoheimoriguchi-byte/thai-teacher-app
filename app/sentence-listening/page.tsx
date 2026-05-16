"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "../lib/users";
import { speak } from "@/app/lib/tts";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Card = {
  id: string;
  word: string;
  pronunciation: string;
  meaning: string;
  category: string;
  language: string;
  breakdown: string;
};

type SentenceQuestion = {
  sentence: string;
  pronunciation: string;
  correctMeaning: string;
  correctMeaningPronunciation: string;
  wrongOptions: string[];
  wrongOptionsPronunciation: string[];
  usedWords: string[];
  usedCardIds: string[];
  /** Category label used for distractor sentences (matches card.category) */
  primaryCategory?: string;
};

type Option = {
  text: string;
  pronunciation: string;
};

type HistoryItem = {
  question: SentenceQuestion;
  options: Option[];
};

type Direction = "word-to-en" | "en-to-word";
type WordMode = "all" | "new-only";

type WordProgress = {
  card_id: string;
  module: string;
  direction: string;
  consecutive_correct: number;
  mastered: boolean;
  mastered_at?: string | null;
};

const recordSession = async (userId: string, module: string) => {
  const today = new Date().toISOString().split("T")[0];
  const { data: existing } = await supabase
    .from("study_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("studied_date", today)
    .eq("module", module)
    .single();
  if (!existing) {
    const { error } = await supabase.from("study_sessions").insert({
      user_id: userId,
      studied_date: today,
      module,
    });
    if (error) console.error("recordSession error:", error);
  }
};

function shuffleArray<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

/** Few-shot + policy for 3 distractors (order: noun-only, verb/predicate, broader rewrite). */
const DISTRACTOR_POLICY_EN_CHOICES = `
Distractor design (wrongOptions is EXACTLY 3 strings; ORDER matters — index 0, 1, 2):

GOAL: Memory/comprehension difficulty. The learner must read or listen to the WHOLE sentence — not spot one changing slot like a cloze test.

FORBIDDEN pattern (do NOT produce this across the set of three):
- All three wrong answers share the SAME sentence skeleton and only ONE slot changes (e.g. only the noun after "The ___ is far", or only the number in "I buy ___ apples", or only the noun in "Where is the ___").

REQUIRED pattern (each wrong answer uses a DIFFERENT kind of error):
- wrongOptions[0] — NOUN-SWAP: Change exactly ONE noun phrase (subject or object) vs correctMeaning. Prefer a replacement noun from the same broad theme as primaryCategory when you can (see category word list). The rest of the sentence should stay similar, but this must NOT be a mere numeral change (e.g. do NOT do "five"→"six" only).
- wrongOptions[1] — VERB / PREDICATE CHANGE: Change the main verb or the core predicate meaning. The sentence must NOT be the same template as [0] with only a different noun — change how the situation is described (e.g. "is far" → "is near", or "buy" → "eat").
- wrongOptions[2] — BROADER REWRITE: Change at least TWO meaningful content elements (e.g. subject + verb, or quantity + object, or scene). The overall clause pattern may differ more from correctMeaning than [0] and [1]. Still a plausible full sentence, but clearly not the right translation.

BAD examples (cloze-like — only one slot varies across options — NEVER do this for all three):
- Correct: "Where is the bathroom?" → BAD set: "Where is the kitchen?", "Where is the station?", "Where is the library?"
- Correct: "I buy five apples" → BAD set: "I buy three apples", "I buy ten apples", "I buy six apples"
- Correct: "The market is far" → BAD set: "The school is far", "The library is far", "The park is far"

GOOD examples (mixed error types — OK):
- Correct: "I buy five apples" → GOOD set:
  [0] "I buy five oranges" (noun swap)
  [1] "I eat five apples" OR "I sell five apples" (verb change)
  [2] "She wants three apples" OR "We make a pie" (multiple changes)

Do NOT copy the exact words of these examples into your output — apply the same *ideas* to the actual correctMeaning you generate.
`.trim();

const DISTRACTOR_POLICY_L1_CHOICES = `
Distractor design (wrongOptions is EXACTLY 3 full sentences in the TARGET study language (Thai script or Japanese as appropriate); ORDER matters — index 0, 1, 2):

GOAL: The learner must understand the whole sentence, not match one differing word.

FORBIDDEN: All three wrong sentences share one rigid template and only one slot changes (like a cloze).

REQUIRED:
- wrongOptions[0] — NOUN-SWAP: Change exactly one nominal element vs correctMeaning. Prefer nouns from the same broad theme as primaryCategory when possible. Do NOT only change a numeral.
- wrongOptions[1] — VERB / PREDICATE CHANGE: Change the main verb or how the situation is described; must not be the same "template" as [0].
- wrongOptions[2] — BROADER REWRITE: At least two content elements change; wording may diverge more from correctMeaning while staying plausible and wrong.

BAD (cloze-like): Correct 「くまがさんびきいます」→ three options that only swap the animal noun with the same pattern.
GOOD: Correct 「りんごをいつつかいます」→ [0] 「みかんをいつつかいます」(one noun swap), [1] 「りんごをたべます」(verb/predicate), [2] 「かのじょはみっつのバナナがほしいです」(broader rewrite).
GOOD pattern: [0] noun swap in same theme, [1] change verb/predicate, [2] rephrase with several differences.

wrongOptionsPronunciation must align with wrongOptions (romanization).
`.trim();

function buildWordsGroupedByCategory(pool: Card[]): string {
  const by = new Map<string, Card[]>();
  for (const c of pool) {
    const key = c.category?.trim() || "(uncategorized)";
    if (!by.has(key)) by.set(key, []);
    by.get(key)!.push(c);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, arr]) => {
      const lines = arr.map(
        (c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`
      );
      return `Category "${cat}":\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Guidelines for the stimulus + correct answer only (not wrongOptions). */
function buildStimulusNaturalnessBlock(direction: Direction, langLabel: string): string {
  const shared = `
NATURALNESS — applies to the stimulus sentence and the correct answer (correctMeaning) only.
(Does not change the distractor rules below: wrongOptions[0]/[1]/[2] roles, soft category hint, and cloze-avoidance stay as specified.)

- Prefer wording that is natural and commonly used in real daily conversation over "maximally using rare combinations from the list".
- Avoid grammatically correct but unusual or awkward collocations; if a combination feels forced, pick different words from the sample.
- Target everyday situations a child or beginner would encounter (home, school, playground, shops, family, simple observations).
- For counting or describing animals/things, use idiomatic patterns natives would say (not odd verb–object pairings).

English few-shot (apply the same judgment to ${langLabel} where that language carries the stimulus or the correct answer):
- GOOD: "I see three birds in the sky." (natural)
- BAD: "I know three birds." (possible grammar but unnatural as an everyday sentence for this idea)
- GOOD: "There are three cats in the garden."
- BAD: "I have three cats knowledge." (unnatural / non-idiomatic)
`.trim();

  if (direction === "word-to-en") {
    return `${shared}

In this mode: "${langLabel}" text goes in "sentence"; natural English goes in "correctMeaning". Both must sound like something a native would say to a child, not a textbook-only line.`;
  }
  return `${shared}

In this mode: natural English goes in "sentence"; "${langLabel}" goes in "correctMeaning". Both must sound natural to native speakers at a child-friendly beginner level.`;
}

function majorityCategoryFromUsedIds(usedCardIds: string[] | undefined, allCards: Card[]): string {
  const counts = new Map<string, number>();
  for (const id of usedCardIds || []) {
    const cat = allCards.find((c) => c.id === id)?.category?.trim() || "(uncategorized)";
    counts.set(cat, (counts.get(cat) || 0) + 1);
  }
  if (counts.size === 0) return "(uncategorized)";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function wrongOptionLooksSentenceLike(text: string, direction: Direction): boolean {
  const t = text.trim();
  if (!t) return false;
  if (direction === "word-to-en") {
    // English distractors: reject bare single-word answers like "Frog"
    if (!/\s/.test(t) && t.length < 24) return false;
    return true;
  }
  // Target-language distractors (often no spaces): require a minimal clause length
  return t.length >= 8;
}

function normalizeWrongOptions(
  correctMeaning: string,
  wrongOptions: unknown,
  wrongProns: unknown,
  direction: Direction,
  strictSentenceShape: boolean
): { texts: string[]; prons: string[] } {
  const correct = String(correctMeaning || "").trim();
  const arr = Array.isArray(wrongOptions) ? wrongOptions : [];
  const prArr = Array.isArray(wrongProns) ? wrongProns : [];
  const outT: string[] = [];
  const outP: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i] ?? "").trim();
    if (!t || t === correct || seen.has(t)) continue;
    if (strictSentenceShape && !wrongOptionLooksSentenceLike(t, direction)) continue;
    seen.add(t);
    outP.push(direction === "en-to-word" ? String(prArr[i] ?? "").trim() : "");
    outT.push(t);
    if (outT.length >= 3) break;
  }
  return { texts: outT, prons: outP };
}

async function callSentenceChat(message: string): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.reply as string;
}

function parseJsonFromChat(reply: string): unknown {
  const cleaned = reply.replace(/```json\n?|\n?```/g, "").trim();
  return JSON.parse(cleaned);
}

async function repairWrongOptionsViaChat(params: {
  direction: Direction;
  langLabel: string;
  filterLanguage: string;
  categoryLabel: string;
  vocabularyLines: string;
  stimulusSentence: string;
  correctMeaning: string;
  correctPronunciation: string;
  strictShape: boolean;
}): Promise<{ wrongOptions: string[]; wrongOptionsPronunciation: string[] }> {
  const {
    direction,
    langLabel,
    filterLanguage,
    categoryLabel,
    vocabularyLines,
    stimulusSentence,
    correctMeaning,
    correctPronunciation,
    strictShape,
  } = params;

  const targetWrongLang =
    direction === "word-to-en"
      ? "English"
      : `${langLabel} (${filterLanguage === "TH" ? "Thai script" : "Japanese hiragana/katakana/kanji as appropriate"})`;

  const policyBlock =
    direction === "word-to-en" ? DISTRACTOR_POLICY_EN_CHOICES : DISTRACTOR_POLICY_L1_CHOICES;

  const shapeRule = strictShape
    ? "Each wrongOption MUST be a complete sentence in the target language for this quiz mode (not a single word or bare noun)."
    : "Each wrongOption should be a full sentence if possible; avoid single-word answers.";

  const pronRule =
    direction === "en-to-word"
      ? `wrongOptionsPronunciation must have 3 romanized strings aligned with wrongOptions.`
      : `wrongOptionsPronunciation must be ["","",""].`;

  const message = `You are fixing distractors for a ${langLabel} listening quiz.

Return ONLY a JSON object (no markdown) with this exact shape:
{
  "wrongOptions": ["distractor 0", "distractor 1", "distractor 2"],
  "wrongOptionsPronunciation": ${direction === "en-to-word" ? '["romaji0","romaji1","romaji2"]' : '["","",""]'}
}

${policyBlock}

Context:
- primaryCategory (soft hint for noun swaps in wrongOptions[0] only): "${categoryLabel}"
- Stimulus shown to the student: """${stimulusSentence}"""
- Correct choice text (exact string when correct): """${correctMeaning}"""
- Correct pronunciation (reference): """${correctPronunciation}"""

Vocabulary reference (wrongOptions[0] should prefer replacement nouns from the primaryCategory block when helpful; wrongOptions[1] and [2] may use any items from the broader list — do not restrict all three to one category):
${vocabularyLines}

Rules:
1. Output exactly 3 items in wrongOptions in the fixed roles: [0] noun-swap only, [1] verb/predicate change, [2] broader multi-part rewrite — see policy above. Do NOT output three cloze-style variants.
2. Each wrongOption must be in ${targetWrongLang}.
3. ${shapeRule}
4. Wrong answers must be plausible but NOT synonymous with the correct choice; use everyday, child-friendly phrasing (avoid odd textbook-only fragments).
5. ${pronRule}`;

  const reply = await callSentenceChat(message);
  const parsed = parseJsonFromChat(reply) as {
    wrongOptions?: unknown;
    wrongOptionsPronunciation?: unknown;
  };
  const norm = normalizeWrongOptions(
    correctMeaning,
    parsed.wrongOptions,
    parsed.wrongOptionsPronunciation,
    direction,
    strictShape
  );
  return { wrongOptions: norm.texts, wrongOptionsPronunciation: norm.prons };
}

const updateWordProgress = async (
  userId: string,
  cardId: string,
  module: string,
  direction: string,
  isCorrect: boolean,
  currentProgress: WordProgress | undefined
) => {
  const consecutive = isCorrect
    ? (currentProgress?.consecutive_correct ?? 0) + 1
    : 0;
  const wasAlreadyMastered = currentProgress?.mastered ?? false;
  const mastered = consecutive >= 3;
  const masteredAt = mastered && !wasAlreadyMastered
    ? new Date().toISOString()
    : currentProgress?.mastered_at ?? null;

  const { error } = await supabase.from("word_progress").upsert(
    {
      user_id: userId,
      card_id: cardId,
      module,
      direction,
      consecutive_correct: consecutive,
      mastered,
      mastered_at: masteredAt,
      last_practiced: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,card_id,module,direction" }
  );
  if (error) console.error("updateWordProgress error:", error);
  return { consecutive, mastered, masteredAt: masteredAt ?? undefined };
};

export default function SentenceListeningPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [filterLanguage, setFilterLanguage] = useState("TH");
  const [direction, setDirection] = useState<Direction>("word-to-en");
  const [wordMode, setWordMode] = useState<WordMode>("all");
  const [question, setQuestion] = useState<SentenceQuestion | null>(null);
  const [shuffledOptions, setShuffledOptions] = useState<Option[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [showMastered, setShowMastered] = useState<string[]>([]);

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (userId) {
      const fetchUser = async () => {
        const { data } = await supabase
          .from("users")
          .select("*")
          .eq("id", userId)
          .single();
        if (data) {
          const language = LANGUAGE_MAP[data.id] ?? "TH";
          setCurrentUser({
            id: data.id,
            name: data.name,
            language,
            flag: FLAG_MAP[language],
          });
        }
      };
      fetchUser();
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const fetchData = async () => {
      const { data: cardData } = await supabase
        .from("cards")
        .select("*")
        .eq("language", currentUser.language)
        .eq("type", "word");
      if (cardData) setCards(cardData);

      const { data: progressData } = await supabase
        .from("word_progress")
        .select("*")
        .eq("user_id", currentUser.id)
        .eq("module", "sentence");
      if (progressData) setWordProgress(progressData);
    };
    fetchData();
  }, [currentUser]);

  useEffect(() => {
    if (currentUser) setFilterLanguage(currentUser.language);
  }, [currentUser]);

  const speechLang = filterLanguage === "TH" ? "th-TH" : "ja-JP";
  const langLabel = filterLanguage === "TH" ? "Thai" : "Japanese";
  const langFlag = currentUser?.flag ?? "🇹🇭";

  const getProgress = (cardId: string, dir: string) =>
    wordProgress.find((p) => p.card_id === cardId && p.direction === dir);

  const generateQuestion = useCallback(async (addToHistory = true) => {
    if (!currentUser) return;

    const basePool = cards.filter((c) => c.language === filterLanguage);

    let workPool: Card[];
    if (wordMode === "new-only") {
      const targetPool = basePool.filter((c) => !getProgress(c.id, direction)?.mastered);
      if (targetPool.length === 0) {
        if (addToHistory && question) {
          setHistory((prev) => [...prev, { question, options: shuffledOptions }]);
        }
        setQuestion(null);
        setShuffledOptions([]);
        setSelectedAnswer(null);
        setShowMastered([]);
        setLoading(false);
        return;
      }
      workPool = targetPool;
    } else {
      workPool = basePool;
    }

    if (workPool.length < 5) return;

    // 履歴に追加
    if (addToHistory && question) {
      setHistory((prev) => [...prev, { question, options: shuffledOptions }]);
    }

    setLoading(true);
    setSelectedAnswer(null);
    setQuestion(null);
    setShowMastered([]);

    const sample = shuffleArray(workPool).slice(0, Math.min(15, workPool.length));
    const wordsByCategory = buildWordsGroupedByCategory(workPool);

    let prompt = "";

    if (direction === "word-to-en") {
      prompt = `Create a SHORT, simple ${langLabel} sentence using 2-3 vocabulary words from the mixed list below (you may pick words from different categories for a natural sentence).

Available words (mixed):
${sample.map((c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`).join("\n")}

All words grouped by category (for distractors — see rules below):
${wordsByCategory}

${buildStimulusNaturalnessBlock(direction, langLabel)}

Return ONLY a valid JSON object with this exact structure:
{
  "sentence": "the sentence in ${filterLanguage === "TH" ? "Thai script" : "Japanese (hiragana/katakana/kanji as appropriate)"}",
  "pronunciation": "romanized pronunciation",
  "correctMeaning": "the correct English translation as a full sentence (not a single word)",
  "correctMeaningPronunciation": "",
  "primaryCategory": "category label from the headings below — soft hint for choosing replacement nouns in wrongOptions[0] (same broad theme when possible)",
  "wrongOptions": ["English distractor 0 — noun swap only", "English distractor 1 — verb/predicate change", "English distractor 2 — broader rewrite"],
  "wrongOptionsPronunciation": ["", "", ""],
  "usedWords": ["pronunciation1 = meaning1", "pronunciation2 = meaning2"],
  "usedCardIds": ["card-id-1", "card-id-2"]
}

${DISTRACTOR_POLICY_EN_CHOICES}

Category vocabulary (soft preference for wrongOptions[0] noun swaps when a good fit exists; wrongOptions[1] and [2] may use any reasonable English):
Refer to the "All words grouped by category" section above.

Additional rules:
- primaryCategory should match the heading that best fits the main noun/theme of correctMeaning (for guiding [0] only).
- Do NOT make all three wrongOptions follow the same cloze template (see FORBIDDEN above).
- wrongOptions must each be a complete English sentence (not a single word).
Output ONLY the JSON, no markdown, no explanation`;
    } else {
      prompt = `Create a SHORT, simple English sentence that can be translated to ${langLabel}.

Use vocabulary from this mixed list (you may pick words from different categories for a natural sentence):
${sample.map((c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`).join("\n")}

All words grouped by category (for distractors — see rules below):
${wordsByCategory}

${buildStimulusNaturalnessBlock(direction, langLabel)}

Return ONLY a valid JSON object with this exact structure:
{
  "sentence": "the English sentence",
  "pronunciation": "",
  "correctMeaning": "the correct ${langLabel} translation as a full sentence in ${filterLanguage === "TH" ? "Thai script" : "Japanese (hiragana/katakana/kanji as appropriate)"}",
  "correctMeaningPronunciation": "romanized pronunciation of correctMeaning",
  "primaryCategory": "category label — soft hint for wrongOptions[0] nominal swaps (same broad theme when possible)",
  "wrongOptions": ["${langLabel} distractor 0 — noun swap only", "${langLabel} distractor 1 — verb/predicate change", "${langLabel} distractor 2 — broader rewrite"],
  "wrongOptionsPronunciation": ["romanized pronunciation of wrong 0", "romanized pronunciation of wrong 1", "romanized pronunciation of wrong 2"],
  "usedWords": ["pronunciation1 = meaning1", "pronunciation2 = meaning2"],
  "usedCardIds": ["card-id-1", "card-id-2"]
}

${DISTRACTOR_POLICY_L1_CHOICES}

Vocabulary: use the mixed list and grouped-by-category list above. wrongOptions[0] should prefer nouns from the same broad theme as primaryCategory when swapping one nominal; wrongOptions[1] and [2] may freely use other words from the deck lists for natural ${langLabel}.

Additional rules:
- Do NOT make all three wrongOptions share one rigid template with only one slot different (cloze-like).
- Each wrongOptions entry must be a full ${langLabel} sentence (not one word).
Output ONLY the JSON, no markdown, no explanation`;
    }

    try {
      const reply = await callSentenceChat(prompt);
      const parsed = parseJsonFromChat(reply) as SentenceQuestion;

      const correctMeaning = String(parsed.correctMeaning ?? "").trim();
      parsed.correctMeaning = correctMeaning;

      const resolveCategoryLabel = (): string => {
        const ai = parsed.primaryCategory?.trim();
        const keys = new Set(
          workPool.map((c) => c.category?.trim() || "(uncategorized)")
        );
        if (ai) {
          if (keys.has(ai)) return ai;
          const lower = ai.toLowerCase();
          for (const k of keys) {
            if (k.toLowerCase() === lower) return k;
          }
        }
        return majorityCategoryFromUsedIds(parsed.usedCardIds, cards);
      };

      const categoryLabel = resolveCategoryLabel();
      parsed.primaryCategory = categoryLabel;

      const linesForCategory = (pool: Card[], cat: string) => {
        const c = cat.trim();
        let rows = pool.filter(
          (x) => (x.category?.trim() || "(uncategorized)") === c
        );
        if (rows.length < 4) {
          rows = pool.filter(
            (x) =>
              (x.category?.trim() || "").toLowerCase() === c.toLowerCase()
          );
        }
        if (rows.length === 0) rows = pool;
        return rows
          .map(
            (x) => `- ${x.word} (${x.pronunciation}) = ${x.meaning} [id:${x.id}]`
          )
          .join("\n");
      };

      let norm = normalizeWrongOptions(
        correctMeaning,
        parsed.wrongOptions,
        parsed.wrongOptionsPronunciation,
        direction,
        true
      );

      const stimulus = parsed.sentence;

      if (norm.texts.length < 3) {
        const catLines = linesForCategory(workPool, categoryLabel);
        const broadSample = shuffleArray(workPool)
          .slice(0, 28)
          .map((x) => `- ${x.word} (${x.pronunciation}) = ${x.meaning} [id:${x.id}]`)
          .join("\n");
        const vocabStrict =
          `Primary category "${categoryLabel}" — prefer replacement nouns here for wrongOptions[0]:\n${catLines}\n\n` +
          `Broader deck sample (use freely for wrongOptions[1] and [2]):\n${broadSample}`;
        const repaired = await repairWrongOptionsViaChat({
          direction,
          langLabel,
          filterLanguage,
          categoryLabel,
          vocabularyLines: vocabStrict,
          stimulusSentence: stimulus,
          correctMeaning,
          correctPronunciation: parsed.correctMeaningPronunciation || "",
          strictShape: true,
        });
        if (repaired.wrongOptions.length >= 3) {
          norm = {
            texts: repaired.wrongOptions.slice(0, 3),
            prons: repaired.wrongOptionsPronunciation.slice(0, 3),
          };
        }
      }

      if (norm.texts.length < 3) {
        const vocabWide = workPool
          .map(
            (x) => `- ${x.word} (${x.pronunciation}) = ${x.meaning} [id:${x.id}]`
          )
          .join("\n");
        const repaired2 = await repairWrongOptionsViaChat({
          direction,
          langLabel,
          filterLanguage,
          categoryLabel: `${categoryLabel} (any topic from list)`,
          vocabularyLines: vocabWide,
          stimulusSentence: stimulus,
          correctMeaning,
          correctPronunciation: parsed.correctMeaningPronunciation || "",
          strictShape: false,
        });
        if (repaired2.wrongOptions.length >= 3) {
          norm = {
            texts: repaired2.wrongOptions.slice(0, 3),
            prons: repaired2.wrongOptionsPronunciation.slice(0, 3),
          };
        }
      }

      if (norm.texts.length < 3) {
        alert(
          "Could not build 3 sentence distractors. Please tap Skip or refresh and try again."
        );
        return;
      }

      parsed.wrongOptions = norm.texts.slice(0, 3);
      parsed.wrongOptionsPronunciation =
        direction === "en-to-word"
          ? ["", "", ""].map((_, i) => norm.prons[i] ?? "")
          : ["", "", ""];

      const allOptions: Option[] = [
        {
          text: parsed.correctMeaning,
          pronunciation: parsed.correctMeaningPronunciation || "",
        },
        ...parsed.wrongOptions.map((opt, i) => ({
          text: opt,
          pronunciation: parsed.wrongOptionsPronunciation?.[i] || "",
        })),
      ].sort(() => Math.random() - 0.5);
      setQuestion(parsed);
      setShuffledOptions(allOptions);
    } catch (error: unknown) {
      console.error(error);
      alert("Failed to generate sentence. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [cards, filterLanguage, speechLang, direction, wordMode, currentUser, langLabel, question, shuffledOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setQuestion(prev.question);
    setShuffledOptions(prev.options);
    setSelectedAnswer(null);
    setShowMastered([]);
  };

  useEffect(() => {
    if (cards.length > 0 && currentUser) generateQuestion(false);
  }, [cards, filterLanguage, direction, wordMode, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = async (answer: string) => {
    if (selectedAnswer || !question || !currentUser) return;
    setSelectedAnswer(answer);

    const isCorrect = answer === question.correctMeaning;
    setScore((prev) => ({
      correct: prev.correct + (isCorrect ? 1 : 0),
      total: prev.total + 1,
    }));

    const newlyMastered: string[] = [];
    for (const cardId of (question.usedCardIds || [])) {
      const currentProgress = getProgress(cardId, direction);
      const { mastered, masteredAt } = await updateWordProgress(
        currentUser.id, cardId, "sentence", direction, isCorrect, currentProgress
      );
      const consecutive = isCorrect ? (currentProgress?.consecutive_correct ?? 0) + 1 : 0;
      setWordProgress((prev) => {
        const existing = prev.find((p) => p.card_id === cardId && p.direction === direction);
        if (existing) {
          return prev.map((p) =>
            p.card_id === cardId && p.direction === direction
              ? { ...p, consecutive_correct: consecutive, mastered, mastered_at: masteredAt }
              : p
          );
        }
        return [...prev, { card_id: cardId, module: "sentence", direction, consecutive_correct: consecutive, mastered, mastered_at: masteredAt }];
      });
      if (mastered && !currentProgress?.mastered) {
        const card = cards.find((c) => c.id === cardId);
        if (card) newlyMastered.push(card.word);
      }
    }
    if (newlyMastered.length > 0) setShowMastered(newlyMastered);
    await recordSession(currentUser.id, "sentence");
  };

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <p style={{ color: "#666" }}>Please select a user from <a href="/">Home</a>.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>💬 Sentence Listening</h1>

      <div style={{ display: "flex", gap: "8px", marginBottom: "1rem", flexWrap: "wrap" }}>
        <a href="/" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
        <a href="/vocabulary" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
        <a href="/index-card" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
        <a href="/listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
        <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
        <a href="/speaking" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎤 Speaking</a>
        <a href="/reading" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📖 Reading</a>
      </div>

      <div style={{ marginBottom: "8px", display: "flex", gap: "8px" }}>
        {([
          { value: "word-to-en" as Direction, label: `${langFlag} → 🇬🇧` },
          { value: "en-to-word" as Direction, label: `🇬🇧 → ${langFlag}` },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setDirection(opt.value)}
            style={{ padding: "6px 14px", borderRadius: "20px", border: direction === opt.value ? "2px solid #4caf50" : "1px solid #ccc", background: direction === opt.value ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontWeight: direction === opt.value ? "bold" : "normal", fontSize: "13px" }}>
            {opt.label}
          </button>
        ))}
      </div>

      <div style={{ marginBottom: "1rem", display: "flex", gap: "8px" }}>
        {([
          { value: "all" as WordMode, label: "All words" },
          { value: "new-only" as WordMode, label: "Not yet mastered" },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setWordMode(opt.value)}
            style={{ padding: "6px 14px", borderRadius: "20px", border: wordMode === opt.value ? "2px solid #2196f3" : "1px solid #ccc", background: wordMode === opt.value ? "#e3f2fd" : "white", cursor: "pointer", color: "#111", fontWeight: wordMode === opt.value ? "bold" : "normal", fontSize: "13px" }}>
            {opt.label}
          </button>
        ))}
      </div>

      <p style={{ color: "#666", fontSize: "14px", marginBottom: "1.5rem" }}>
        Score: {score.correct} / {score.total}
        <span style={{ marginLeft: "12px", fontSize: "13px", color: "#4caf50" }}>
          {wordProgress.filter((p) => p.direction === direction && p.mastered).length} mastered ✓
        </span>
      </p>

      {wordMode === "new-only" &&
        cards.filter((c) => c.language === filterLanguage).length > 0 &&
        cards
          .filter((c) => c.language === filterLanguage)
          .every((c) => getProgress(c.id, direction)?.mastered === true) && (
        <div
          style={{
            background: "#e8f5e9",
            border: "1px solid #4caf50",
            borderRadius: "8px",
            padding: "24px",
            marginBottom: "1rem",
            textAlign: "center",
          }}
        >
          <p style={{ margin: 0, color: "#2e7d32", fontWeight: "bold", fontSize: "18px" }}>All Done!</p>
          <p style={{ margin: "8px 0 0", color: "#666", fontSize: "14px" }}>
            Every word is mastered for Sentence · this direction. Switch to &quot;All words&quot; or try another mode.
          </p>
        </div>
      )}

      {showMastered.length > 0 && (
        <div style={{ background: "#d4edda", border: "1px solid #28a745", borderRadius: "8px", padding: "12px", marginBottom: "1rem", textAlign: "center" }}>
          <p style={{ margin: 0, color: "#28a745", fontWeight: "bold" }}>⭐ Word Mastered! {showMastered.join(", ")}</p>
        </div>
      )}

      {loading && <p style={{ textAlign: "center", color: "#666" }}>AI is creating a sentence...</p>}

      {question && !loading && (
        <>
          {direction === "word-to-en" ? (
            <div style={{ textAlign: "center", marginBottom: "2rem" }}>
              <button
                onClick={() => speak(question.sentence, speechLang)}
                onTouchEnd={(e) => { e.preventDefault(); speak(question.sentence, speechLang); }}
                style={{ fontSize: "48px", background: "#4caf50", color: "white", border: "none", borderRadius: "50%", width: "100px", height: "100px", cursor: "pointer" }}>
                🔊
              </button>
              <p style={{ marginTop: "12px", fontSize: "20px", fontWeight: "bold", margin: "12px 0 4px" }}>{question.sentence}</p>
              <p style={{ color: "#666", fontSize: "14px", margin: 0 }}>{question.pronunciation}</p>
              {selectedAnswer && question.usedWords && question.usedWords.length > 0 && (
                <p style={{ color: "#aaa", fontSize: "11px", marginTop: "6px" }}>Uses: {question.usedWords.join(" / ")}</p>
              )}
            </div>
          ) : (
            <div style={{ textAlign: "center", margin: "12px 0 24px", padding: "24px", background: "#f9f9f9", borderRadius: "12px" }}>
              <p style={{ fontSize: "11px", color: "#aaa", margin: "0 0 6px" }}>English</p>
              <p style={{ fontSize: "20px", fontWeight: "500", margin: 0 }}>{question.sentence}</p>
              {selectedAnswer && question.usedWords && question.usedWords.length > 0 && (
                <p style={{ color: "#aaa", fontSize: "11px", marginTop: "8px" }}>Uses: {question.usedWords.join(" / ")}</p>
              )}
            </div>
          )}

          {/* Back / Skip */}
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
            <button
              onClick={goBack}
              disabled={history.length === 0}
              style={{ padding: "4px 12px", border: "1px solid #ccc", borderRadius: "12px", background: "white", color: history.length === 0 ? "#ccc" : "#666", fontSize: "12px", cursor: history.length === 0 ? "default" : "pointer" }}>
              ← Back
            </button>
            <button
              onClick={() => generateQuestion()}
              style={{ padding: "4px 12px", border: "1px solid #ccc", borderRadius: "12px", background: "white", color: "#999", fontSize: "12px", cursor: "pointer" }}>
              Skip →
            </button>
          </div>

          <p style={{ marginBottom: "1rem", fontWeight: "bold" }}>
            {direction === "word-to-en" ? "What does it mean?" : `Which ${langLabel} translation is correct?`}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "1.5rem" }}>
            {shuffledOptions.map((opt, idx) => {
              const isSelected = selectedAnswer === opt.text;
              const isCorrect = opt.text === question.correctMeaning;
              const showResult = selectedAnswer !== null;
              let bg = "white"; let border = "1px solid #ccc";
              if (showResult) {
                if (isCorrect) { bg = "#d4edda"; border = "2px solid #28a745"; }
                else if (isSelected) { bg = "#f8d7da"; border = "2px solid #dc3545"; }
              }
              return (
                <button key={idx} onClick={() => handleAnswer(opt.text)} disabled={selectedAnswer !== null}
                  style={{ padding: "12px 16px", borderRadius: "8px", background: bg, border, cursor: selectedAnswer ? "default" : "pointer", color: "#111", textAlign: "left", fontSize: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                  <span style={{ flex: 1 }}>
                    {String.fromCharCode(65 + idx)}. {opt.text}
                    {opt.pronunciation && (
                      <span style={{ color: "#999", fontSize: "12px", marginLeft: "8px" }}>({opt.pronunciation})</span>
                    )}
                    {showResult && isCorrect && " ✓"}
                    {showResult && isSelected && !isCorrect && " ✕"}
                  </span>
                  {direction === "en-to-word" && (
                    <span
                      onClick={(e) => { e.stopPropagation(); speak(opt.text, speechLang); }}
                      onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); speak(opt.text, speechLang); }}
                      style={{ fontSize: "18px", cursor: "pointer", padding: "4px 8px" }}>🔊</span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedAnswer && (
            <button onClick={() => generateQuestion()}
              style={{ width: "100%", padding: "12px", background: "#4caf50", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
              Next →
            </button>
          )}
        </>
      )}
    </main>
  );
}
"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { USERS, AppUser } from "../lib/users";

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
};

type Option = {
  text: string;
  pronunciation: string;
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

const speak = (text: string, speechLang: string) => {
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang;
    utterance.rate = 0.7;
    utterance.volume = 1.0;
    utterance.pitch = 1.0;
    const trySpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        const preferred = voices.find((v) => v.name === "Kyoko") ||
          voices.find((v) => v.name === "Kanya") ||
          voices.find((v) => v.lang === speechLang) ||
          voices.find((v) => v.lang.startsWith(speechLang.split("-")[0]));
        if (preferred) utterance.voice = preferred;
      }
      window.speechSynthesis.speak(utterance);
    };
    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = trySpeak;
    } else {
      trySpeak();
    }
  } catch (e) {
    console.error("Speech error:", e);
  }
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
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [showMastered, setShowMastered] = useState<string[]>([]);

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (userId) {
      const user = USERS.find((u) => u.id === userId);
      if (user) {
        setCurrentUser(user);
        setFilterLanguage(user.language);
      }
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const fetchData = async () => {
      const { data: cardData } = await supabase
        .from("cards")
        .select("*")
        .eq("language", currentUser.language);
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

  const speechLang = filterLanguage === "TH" ? "th-TH" : "ja-JP";
  const langLabel = filterLanguage === "TH" ? "Thai" : "Japanese";
  const langFlag = currentUser?.flag ?? "🇹🇭";

  const getProgress = (cardId: string, dir: string) =>
    wordProgress.find((p) => p.card_id === cardId && p.direction === dir);

  const generateQuestion = useCallback(async () => {
    if (!currentUser) return;

    let pool = cards.filter((c) => c.language === filterLanguage);
    if (wordMode === "new-only") {
      const filtered = pool.filter((c) => !getProgress(c.id, direction)?.mastered);
      if (filtered.length >= 5) pool = filtered;
    }
    if (pool.length < 5) return;

    setLoading(true);
    setSelectedAnswer(null);
    setQuestion(null);
    setShowMastered([]);

    const sample = pool.sort(() => Math.random() - 0.5).slice(0, 15);
    let prompt = "";

    if (direction === "word-to-en") {
      prompt = `Create a SHORT, simple ${langLabel} sentence using 2-3 of these vocabulary words.

Available words:
${sample.map((c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`).join("\n")}

Return ONLY a valid JSON object with this exact structure:
{
  "sentence": "the sentence in ${filterLanguage === "TH" ? "Thai script" : "Japanese (hiragana/katakana)"}",
  "pronunciation": "romanized pronunciation",
  "correctMeaning": "English translation",
  "correctMeaningPronunciation": "",
  "wrongOptions": ["plausible wrong English meaning 1", "plausible wrong English meaning 2", "plausible wrong English meaning 3"],
  "wrongOptionsPronunciation": ["", "", ""],
  "usedWords": ["pronunciation1 = meaning1", "pronunciation2 = meaning2"],
  "usedCardIds": ["card-id-1", "card-id-2"]
}
For "usedWords", use the romanized pronunciation. For "usedCardIds", use the exact id values.
Output ONLY the JSON, no markdown, no explanation`;
    } else {
      prompt = `Create a SHORT, simple English sentence that can be translated to ${langLabel}.

Use vocabulary from these words:
${sample.map((c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`).join("\n")}

Return ONLY a valid JSON object with this exact structure:
{
  "sentence": "the English sentence",
  "pronunciation": "",
  "correctMeaning": "the correct ${langLabel} translation in ${filterLanguage === "TH" ? "Thai script" : "Japanese (hiragana/katakana)"}",
  "correctMeaningPronunciation": "romanized pronunciation of correctMeaning",
  "wrongOptions": ["plausible wrong ${langLabel} translation 1", "plausible wrong ${langLabel} translation 2", "plausible wrong ${langLabel} translation 3"],
  "wrongOptionsPronunciation": ["romanized pronunciation of wrong 1", "romanized pronunciation of wrong 2", "romanized pronunciation of wrong 3"],
  "usedWords": ["pronunciation1 = meaning1", "pronunciation2 = meaning2"],
  "usedCardIds": ["card-id-1", "card-id-2"]
}
For "usedWords" and pronunciations, use romanized text. For "usedCardIds", use the exact id values.
Output ONLY the JSON, no markdown, no explanation`;
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const cleaned = data.reply.replace(/```json\n?|\n?```/g, "").trim();
      const parsed: SentenceQuestion = JSON.parse(cleaned);
      const allOptions: Option[] = [
        { text: parsed.correctMeaning, pronunciation: parsed.correctMeaningPronunciation || "" },
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
  }, [cards, filterLanguage, speechLang, direction, wordMode, currentUser, langLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (cards.length > 0 && currentUser) generateQuestion();
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
            <button onClick={generateQuestion}
              style={{ width: "100%", padding: "12px", background: "#4caf50", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
              Next →
            </button>
          )}
        </>
      )}
    </main>
  );
}
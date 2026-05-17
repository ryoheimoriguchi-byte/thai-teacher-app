"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "../lib/users";
import { speak } from "@/app/lib/tts";
import { WordBreakdown } from "@/app/lib/word-breakdown";

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

type Question = {
  card: Card;
  options: Card[];
  correctAnswer: Card;
};

type Direction = "word-to-en" | "en-to-word";
type WordMode = "all" | "new-only";

type WordProgress = {
  card_id: string;
  module: string;
  direction: string;
  consecutive_correct: number;
  mastered: boolean;
  mastered_at?: string;
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
  return { consecutive, mastered };
};

export default function ListeningPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [direction, setDirection] = useState<Direction>("word-to-en");
  const [wordMode, setWordMode] = useState<WordMode>("all");
  const [question, setQuestion] = useState<Question | null>(null);
  const [history, setHistory] = useState<Question[]>([]);
  const [selectedAnswer, setSelectedAnswer] = useState<Card | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [showMastered, setShowMastered] = useState(false);

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
        .eq("module", "listening");
      if (progressData) setWordProgress(progressData);
    };
    fetchData();
  }, [currentUser]);

  const speechLang = currentUser?.language === "TH" ? "th-TH" : "ja-JP";
  const langFlag = currentUser?.flag ?? "🇹🇭";

  const getProgress = (cardId: string, dir: string) =>
    wordProgress.find((p) => p.card_id === cardId && p.direction === dir);

  const generateQuestion = useCallback((addToHistory = true) => {
    if (!currentUser) return;

    // Total deck must supply 4 distinct cards (1 correct + 3 distractors).
    if (cards.length < 4) return;

    let targetPool = cards;
    if (wordMode === "new-only") {
      targetPool = cards.filter((c) => !getProgress(c.id, direction)?.mastered);
      if (targetPool.length === 0) {
        if (addToHistory && question) {
          setHistory((prev) => [...prev, question]);
        }
        setQuestion(null);
        setSelectedAnswer(null);
        setShowMastered(false);
        return;
      }
    }

    const correctCard = targetPool[Math.floor(Math.random() * targetPool.length)];
    // Distractors: prefer same category as correct answer; fill remainder from other categories if needed.
    const sameCategoryCards = cards
      .filter((c) => c.id !== correctCard.id && c.category === correctCard.category)
      .sort(() => Math.random() - 0.5);
    const otherCards = cards
      .filter((c) => c.id !== correctCard.id && c.category !== correctCard.category)
      .sort(() => Math.random() - 0.5);
    const wrongCards: Card[] = [...sameCategoryCards.slice(0, 3)];
    if (wrongCards.length < 3) {
      const need = 3 - wrongCards.length;
      wrongCards.push(...otherCards.slice(0, need));
    }

    const options = [correctCard, ...wrongCards].sort(() => Math.random() - 0.5);
    const newQuestion = { card: correctCard, options, correctAnswer: correctCard };

    if (addToHistory && question) {
      setHistory((prev) => [...prev, question]);
    }

    setQuestion(newQuestion);
    setSelectedAnswer(null);
    setShowMastered(false);
  }, [cards, direction, wordMode, currentUser, wordProgress, question]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setQuestion(prev);
    setSelectedAnswer(null);
    setShowMastered(false);
  };

  useEffect(() => {
    if (cards.length > 0 && currentUser) generateQuestion(false);
  }, [cards, direction, wordMode, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAnswer = async (answer: Card) => {
    if (selectedAnswer || !question || !currentUser) return;
    setSelectedAnswer(answer);

    const isCorrect = answer.id === question.correctAnswer.id;
    setScore((prev) => ({
      correct: prev.correct + (isCorrect ? 1 : 0),
      total: prev.total + 1,
    }));

    const currentProgress = getProgress(question.card.id, direction);
    const { mastered } = await updateWordProgress(
      currentUser.id, question.card.id, "listening", direction, isCorrect, currentProgress
    );
    await recordSession(currentUser.id, "listening");

    const consecutive = isCorrect ? (currentProgress?.consecutive_correct ?? 0) + 1 : 0;
    const masteredAt = mastered && !currentProgress?.mastered ? new Date().toISOString() : currentProgress?.mastered_at;

    setWordProgress((prev) => {
      const existing = prev.find((p) => p.card_id === question.card.id && p.direction === direction);
      if (existing) {
        return prev.map((p) =>
          p.card_id === question.card.id && p.direction === direction
            ? { ...p, consecutive_correct: consecutive, mastered, mastered_at: masteredAt }
            : p
        );
      }
      return [...prev, { card_id: question.card.id, module: "listening", direction, consecutive_correct: consecutive, mastered, mastered_at: masteredAt }];
    });

    if (mastered && !currentProgress?.mastered) setShowMastered(true);
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
      <h1 style={{ marginBottom: "0.5rem" }}>🎧 Word Listening</h1>

      <div style={{ display: "flex", gap: "8px", marginBottom: "1rem", flexWrap: "wrap" }}>
        <a href="/" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
        <a href="/vocabulary" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
        <a href="/index-card" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
        <a href="/listening" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
        <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
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
        cards.length > 0 &&
        cards.every((c) => getProgress(c.id, direction)?.mastered === true) && (
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
            Every word is mastered for this direction. Switch to &quot;All words&quot; or try another mode.
          </p>
        </div>
      )}

      {showMastered && (
        <div style={{ background: "#d4edda", border: "1px solid #28a745", borderRadius: "8px", padding: "12px", marginBottom: "1rem", textAlign: "center" }}>
          <p style={{ margin: 0, color: "#28a745", fontWeight: "bold" }}>⭐ Word Mastered! 3 correct in a row!</p>
        </div>
      )}

      {question && (
        <>
          {direction === "word-to-en" ? (
            <div style={{ textAlign: "center", marginBottom: "2rem" }}>
              <button
                onClick={() => speak(question.card.word, speechLang)}
                onTouchEnd={(e) => { e.preventDefault(); speak(question.card.word, speechLang); }}
                style={{ fontSize: "48px", background: "#4caf50", color: "white", border: "none", borderRadius: "50%", width: "100px", height: "100px", cursor: "pointer" }}>
                🔊
              </button>
              <p style={{ marginTop: "12px", fontSize: "20px", fontWeight: "bold", margin: "12px 0 4px" }}>{question.card.word}</p>
              <p style={{ color: "#666", fontSize: "14px", margin: 0 }}>{question.card.pronunciation}</p>
              <p style={{ color: "#aaa", fontSize: "11px", marginTop: "4px" }}>Category: {question.card.category}</p>
              <div style={{ display: "flex", justifyContent: "center", gap: "4px", marginTop: "8px" }}>
                {[0,1,2].map((i) => (
                  <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: i < (getProgress(question.card.id, direction)?.consecutive_correct ?? 0) ? "#4caf50" : "#ddd" }} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center", margin: "12px 0 24px", padding: "24px", background: "#f9f9f9", borderRadius: "12px" }}>
              <p style={{ fontSize: "11px", color: "#aaa", margin: "0 0 6px" }}>English</p>
              <p style={{ fontSize: "28px", fontWeight: "500", margin: 0 }}>{question.card.meaning}</p>
              <p style={{ color: "#aaa", fontSize: "11px", marginTop: "4px" }}>Category: {question.card.category}</p>
              <div style={{ display: "flex", justifyContent: "center", gap: "4px", marginTop: "8px" }}>
                {[0,1,2].map((i) => (
                  <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: i < (getProgress(question.card.id, direction)?.consecutive_correct ?? 0) ? "#4caf50" : "#ddd" }} />
                ))}
              </div>
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
            {direction === "word-to-en" ? "What does it mean?" : `Which ${currentUser.language === "TH" ? "Thai" : "Japanese"} word means "${question.card.meaning}"?`}
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "1.5rem" }}>
            {question.options.map((opt, idx) => {
              const isSelected = selectedAnswer?.id === opt.id;
              const isCorrect = opt.id === question.correctAnswer.id;
              const showResult = selectedAnswer !== null;
              let bg = "white"; let border = "1px solid #ccc";
              if (showResult) {
                if (isCorrect) { bg = "#d4edda"; border = "2px solid #28a745"; }
                else if (isSelected) { bg = "#f8d7da"; border = "2px solid #dc3545"; }
              }
              return (
                <button key={idx} onClick={() => handleAnswer(opt)} disabled={selectedAnswer !== null}
                  style={{ padding: "12px 16px", borderRadius: "8px", background: bg, border, cursor: selectedAnswer ? "default" : "pointer", color: "#111", textAlign: "left", fontSize: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>
                    {String.fromCharCode(65 + idx)}.{" "}
                    {direction === "word-to-en" ? (
                      <>{opt.meaning}{showResult && isCorrect && " ✓"}{showResult && isSelected && !isCorrect && " ✕"}</>
                    ) : (
                      <><strong>{opt.word}</strong><span style={{ color: "#999", fontSize: "12px", marginLeft: "8px" }}>{opt.pronunciation}</span>{showResult && isCorrect && " ✓"}{showResult && isSelected && !isCorrect && " ✕"}</>
                    )}
                  </span>
                  {direction === "en-to-word" && (
                    <span
                      onClick={(e) => { e.stopPropagation(); speak(opt.word, speechLang); }}
                      onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); speak(opt.word, speechLang); }}
                      style={{ fontSize: "18px", cursor: "pointer", padding: "4px 8px" }}>🔊</span>
                  )}
                </button>
              );
            })}
          </div>

          {selectedAnswer && (
            <>
              <WordBreakdown breakdown={question.card.breakdown} />
              <button onClick={() => generateQuestion()}
                style={{ width: "100%", padding: "12px", background: "#4caf50", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
                Next →
              </button>
            </>
          )}
        </>
      )}
    </main>
  );
}
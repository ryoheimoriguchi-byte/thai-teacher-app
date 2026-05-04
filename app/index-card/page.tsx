"use client";

import { useState, useEffect } from "react";
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

type WordProgress = {
  card_id: string;
  module: string;
  direction: string;
  mastered: boolean;
};

type StudyDirection = "word-to-en" | "en-to-word";
type ProgressFilter = "all" | "fully-mastered" | "not-fully-mastered";

const speak = (text: string, speechLang: string) => {
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang;
    utterance.rate = 0.7;
    utterance.volume = 1.0;
    utterance.pitch = 1.0;
    // voices が読み込まれるまで少し待つ
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      const voice = voices.find((v) => v.lang.startsWith(speechLang.split("-")[0]));
      if (voice) utterance.voice = voice;
    }
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.error("Speech error:", e);
  }
};

export default function IndexCardPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [studyMode, setStudyMode] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [shuffledCards, setShuffledCards] = useState<Card[]>([]);
  const [studyDirection, setStudyDirection] = useState<StudyDirection>("word-to-en");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>("all");

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (userId) {
      const user = USERS.find((u) => u.id === userId);
      if (user) setCurrentUser(user);
    }
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const fetchData = async () => {
      const { data: cardData } = await supabase
        .from("cards")
        .select("*")
        .eq("language", currentUser.language)
        .order("created_at");
      if (cardData) setCards(cardData);

      const { data: progressData } = await supabase
        .from("word_progress")
        .select("*")
        .eq("user_id", currentUser.id);
      if (progressData) setWordProgress(progressData);
    };
    fetchData();
  }, [currentUser]);

  const speechLang = currentUser?.language === "TH" ? "th-TH" : "ja-JP";
  const langFlag = currentUser?.flag ?? "🇹🇭";

  const isMastered = (cardId: string, module: string, direction: string) =>
    wordProgress.find((p: WordProgress) => p.card_id === cardId && p.module === module && p.direction === direction)?.mastered ?? false;

  const getMasteredCount = (cardId: string) =>
    [
      isMastered(cardId, "listening", "word-to-en"),
      isMastered(cardId, "listening", "en-to-word"),
      isMastered(cardId, "sentence", "word-to-en"),
      isMastered(cardId, "sentence", "en-to-word"),
    ].filter(Boolean).length;

  const categories = Array.from(new Set(cards.map((c: Card) => c.category).filter(Boolean)));

  const filteredCards = cards.filter((card: Card) => {
    const categoryOk = categoryFilter === "all" || card.category === categoryFilter;
    const count = getMasteredCount(card.id);
    let progressOk = true;
    if (progressFilter === "fully-mastered") progressOk = count === 4;
    else if (progressFilter === "not-fully-mastered") progressOk = count < 4;
    return categoryOk && progressOk;
  });

  const startStudy = () => {
    const shuffled = [...filteredCards].sort(() => Math.random() - 0.5);
    setShuffledCards(shuffled);
    setCurrentIndex(0);
    setShowBack(false);
    setStudyMode(true);
  };

  const studyCards = shuffle ? shuffledCards : filteredCards;

  const goNext = () => { setShowBack(false); setCurrentIndex((prev: number) => Math.min(prev + 1, studyCards.length - 1)); };
  const goPrev = () => { setShowBack(false); setCurrentIndex((prev: number) => Math.max(prev - 1, 0)); };

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <p style={{ color: "#666" }}>Please select a user from <a href="/">Home</a>.</p>
      </main>
    );
  }

  const nav = (
    <div style={{ display: "flex", gap: "8px", marginBottom: "1rem", flexWrap: "wrap" }}>
      <a href="/" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
      <a href="/vocabulary" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
      <a href="/index-card" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
      <a href="/listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
      <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
    </div>
  );

  // 学習モード
  if (studyMode && studyCards.length > 0) {
    const card = studyCards[currentIndex];
    const langLabel = currentUser.language === "TH" ? "Thai" : "Japanese";
    const front = studyDirection === "word-to-en"
      ? { label: langLabel, text: card.word, speakText: card.word }
      : { label: "English", text: card.meaning, speakText: null as string | null };
    const back = studyDirection === "word-to-en"
      ? { label: "English", text: card.meaning, speakText: null as string | null }
      : { label: langLabel, text: card.word, speakText: card.word };
    const masteredCount = getMasteredCount(card.id);

    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <button onClick={() => setStudyMode(false)} style={{ padding: "6px 14px", border: "1px solid #ccc", borderRadius: "20px", background: "white", cursor: "pointer", color: "#111", fontSize: "14px" }}>
            ← Back
          </button>
          <span style={{ fontSize: "13px", color: "#999" }}>
            {currentIndex + 1} / {studyCards.length}
            {shuffle && <span style={{ marginLeft: "6px" }}>🔀</span>}
          </span>
        </div>

        {/* カード */}
        <div style={{ border: "1px solid #ccc", borderRadius: "12px", padding: "2rem", textAlign: "center", marginBottom: "1rem", minHeight: "200px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {card.category && <p style={{ fontSize: "12px", color: "#999", margin: "0 0 8px" }}>{card.category}</p>}

          {/* 進捗バッジ */}
          <div style={{ display: "flex", justifyContent: "center", gap: "4px", marginBottom: "12px", flexWrap: "wrap" }}>
            {([
              { m: "listening", d: "word-to-en", label: `🎧 ${langFlag}→🇬🇧` },
              { m: "listening", d: "en-to-word", label: `🎧 🇬🇧→${langFlag}` },
              { m: "sentence", d: "word-to-en", label: `💬 ${langFlag}→🇬🇧` },
              { m: "sentence", d: "en-to-word", label: `💬 🇬🇧→${langFlag}` },
            ] as { m: string; d: string; label: string }[]).map(({ m, d, label }) => (
              <span key={`${m}-${d}`} style={{
                fontSize: "9px", padding: "1px 5px", borderRadius: "4px",
                background: isMastered(card.id, m, d) ? "#d4edda" : "#f0f0f0",
                color: isMastered(card.id, m, d) ? "#28a745" : "#999",
              }}>
                {label} {isMastered(card.id, m, d) ? "✓" : "—"}
              </span>
            ))}
          </div>

          <p style={{ fontSize: "11px", color: "#bbb", margin: "0 0 4px" }}>{front.label}</p>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
            <p style={{ fontSize: "28px", fontWeight: "bold", margin: 0 }}>{front.text}</p>
            {front.speakText && (
              <button onClick={() => speak(front.speakText as string, speechLang)} style={{ fontSize: "20px", background: "none", border: "none", cursor: "pointer" }}>🔊</button>
            )}
          </div>
          {studyDirection === "word-to-en" && card.pronunciation && (
            <p style={{ fontSize: "14px", color: "#aaa", margin: "4px 0 0" }}>{card.pronunciation}</p>
          )}

          {showBack && (
            <>
              <hr style={{ margin: "1rem 0", borderColor: "#eee" }} />
              <p style={{ fontSize: "11px", color: "#bbb", margin: "0 0 4px" }}>{back.label}</p>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                <p style={{ fontSize: "18px", margin: 0 }}>{back.text}</p>
                {back.speakText && (
                  <button onClick={() => speak(back.speakText as string, speechLang)} style={{ fontSize: "18px", background: "none", border: "none", cursor: "pointer" }}>🔊</button>
                )}
              </div>
              {studyDirection === "en-to-word" && card.pronunciation && (
                <p style={{ fontSize: "14px", color: "#aaa", margin: "4px 0 0" }}>{card.pronunciation}</p>
              )}
              {card.breakdown && (
                <p style={{ fontSize: "13px", color: "#aaa", margin: "8px 0 0", fontStyle: "italic" }}>💡 {card.breakdown}</p>
              )}
            </>
          )}
        </div>

        <button onClick={() => setShowBack(!showBack)} style={{ width: "100%", marginBottom: "1rem", padding: "10px", border: "1px solid #ccc", borderRadius: "8px", background: "white", cursor: "pointer", color: "#111", fontSize: "16px" }}>
          {showBack ? "Hide" : `Show ${back.label}`}
        </button>

        <div style={{ textAlign: "center", marginBottom: "1rem" }}>
          <span style={{ fontSize: "13px", color: masteredCount === 4 ? "#28a745" : "#999" }}>
            {masteredCount === 4 ? "⭐ Fully Mastered!" : `${masteredCount} / 4 mastered`}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button onClick={goPrev} disabled={currentIndex === 0}
            style={{ padding: "10px 24px", border: "1px solid #ccc", borderRadius: "8px", background: currentIndex === 0 ? "#f5f5f5" : "white", cursor: currentIndex === 0 ? "default" : "pointer", color: currentIndex === 0 ? "#ccc" : "#111" }}>
            ← Prev
          </button>
          <button onClick={goNext} disabled={currentIndex === studyCards.length - 1}
            style={{ padding: "10px 24px", border: "1px solid #ccc", borderRadius: "8px", background: currentIndex === studyCards.length - 1 ? "#f5f5f5" : "white", cursor: currentIndex === studyCards.length - 1 ? "default" : "pointer", color: currentIndex === studyCards.length - 1 ? "#ccc" : "#111" }}>
            Next →
          </button>
        </div>
      </main>
    );
  }

  // 一覧画面
  return (
    <main style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>🃏 Index Card</h1>
      {nav}

      {/* 方向 */}
      <div style={{ marginBottom: "8px", display: "flex", gap: "8px" }}>
        {([
          { value: "word-to-en" as StudyDirection, label: `${langFlag} → 🇬🇧` },
          { value: "en-to-word" as StudyDirection, label: `🇬🇧 → ${langFlag}` },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setStudyDirection(opt.value)}
            style={{ padding: "6px 14px", borderRadius: "20px", border: studyDirection === opt.value ? "2px solid #4caf50" : "1px solid #ccc", background: studyDirection === opt.value ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontWeight: studyDirection === opt.value ? "bold" : "normal", fontSize: "13px" }}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* カテゴリーフィルター */}
      <div style={{ marginBottom: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <button onClick={() => setCategoryFilter("all")}
          style={{ padding: "4px 10px", borderRadius: "12px", border: categoryFilter === "all" ? "2px solid #4caf50" : "1px solid #ccc", background: categoryFilter === "all" ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
          All categories
        </button>
        {categories.map((cat: unknown) => (
          <button key={cat as string} onClick={() => setCategoryFilter(cat as string)}
            style={{ padding: "4px 10px", borderRadius: "12px", border: categoryFilter === cat ? "2px solid #4caf50" : "1px solid #ccc", background: categoryFilter === cat ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
            {cat as string}
          </button>
        ))}
      </div>

      {/* 進捗フィルター */}
      <div style={{ marginBottom: "1rem", display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {([
          { value: "all" as ProgressFilter, label: "All" },
          { value: "fully-mastered" as ProgressFilter, label: "⭐ Fully mastered (4/4)" },
          { value: "not-fully-mastered" as ProgressFilter, label: "🔜 Not fully mastered" },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setProgressFilter(opt.value)}
            style={{ padding: "4px 10px", borderRadius: "12px", border: progressFilter === opt.value ? "2px solid #2196f3" : "1px solid #ccc", background: progressFilter === opt.value ? "#e3f2fd" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* シャッフル + スタートボタン */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "1.5rem", alignItems: "center" }}>
        <button onClick={() => setShuffle(!shuffle)}
          style={{ padding: "6px 14px", borderRadius: "20px", border: shuffle ? "2px solid #4caf50" : "1px solid #ccc", background: shuffle ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontSize: "13px" }}>
          🔀 {shuffle ? "Shuffle: On" : "Shuffle: Off"}
        </button>
        <button onClick={startStudy}
          style={{ flex: 1, padding: "10px 16px", background: "#4caf50", color: "white", border: "none", borderRadius: "8px", cursor: "pointer", fontSize: "16px" }}>
          Start ({filteredCards.length} cards)
        </button>
      </div>

      {/* カード一覧プレビュー */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {filteredCards.map((card: Card) => {
          const masteredCount = getMasteredCount(card.id);
          return (
            <div key={card.id} style={{ padding: "10px 12px", border: "1px solid #eee", borderRadius: "8px", background: masteredCount === 4 ? "#f0fff4" : "white", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong style={{ fontSize: "15px" }}>{card.word}</strong>
                <span style={{ fontSize: "12px", color: "#aaa", marginLeft: "8px" }}>{card.pronunciation}</span>
                <span style={{ fontSize: "13px", color: "#666", marginLeft: "8px" }}>{card.meaning}</span>
              </div>
              <span style={{ fontSize: "12px", color: masteredCount === 4 ? "#28a745" : "#999", whiteSpace: "nowrap" }}>
                {masteredCount === 4 ? "⭐" : `${masteredCount}/4`}
              </span>
            </div>
          );
        })}
      </div>
    </main>
  );
}
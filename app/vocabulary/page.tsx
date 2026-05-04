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
  consecutive_correct: number;
  mastered: boolean;
};

type ProgressFilter = "all" | "fully-mastered" | "not-fully-mastered";

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

export default function WordListPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

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
        .order("category");
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

  const getProgress = (cardId: string, module: string, direction: string) =>
    wordProgress.find((p) => p.card_id === cardId && p.module === module && p.direction === direction);

  const isMastered = (cardId: string, module: string, direction: string) =>
    getProgress(cardId, module, direction)?.mastered ?? false;

  const getConsecutive = (cardId: string, module: string, direction: string) =>
    getProgress(cardId, module, direction)?.consecutive_correct ?? 0;

  // 6軸のマスター数
  const getMasteredCount = (cardId: string) =>
    [
      isMastered(cardId, "listening", "word-to-en"),
      isMastered(cardId, "listening", "en-to-word"),
      isMastered(cardId, "sentence", "word-to-en"),
      isMastered(cardId, "sentence", "en-to-word"),
      isMastered(cardId, "speaking-word", "en-to-word"),
      isMastered(cardId, "speaking-sentence", "en-to-word"),
    ].filter(Boolean).length;

  const isFullyMastered = (cardId: string) => getMasteredCount(cardId) === 6;

  const categories = Array.from(new Set(cards.map((c) => c.category).filter(Boolean)));

  const filteredCards = cards.filter((card) => {
    const categoryOk = categoryFilter === "all" || card.category === categoryFilter;
    const count = getMasteredCount(card.id);
    let progressOk = true;
    if (progressFilter === "fully-mastered") progressOk = count === 6;
    else if (progressFilter === "not-fully-mastered") progressOk = count < 6;
    return categoryOk && progressOk;
  });

  const badges = [
    { module: "listening", direction: "word-to-en", label: `🎧 ${langFlag}→🇬🇧` },
    { module: "listening", direction: "en-to-word", label: `🎧 🇬🇧→${langFlag}` },
    { module: "sentence", direction: "word-to-en", label: `💬 ${langFlag}→🇬🇧` },
    { module: "sentence", direction: "en-to-word", label: `💬 🇬🇧→${langFlag}` },
    { module: "speaking-word", direction: "en-to-word", label: `🎤 Word` },
    { module: "speaking-sentence", direction: "en-to-word", label: `🎤 Sentence` },
  ];

  const ProgressBadge = ({ mastered, consecutive, label, isSpeaking }: { mastered: boolean; consecutive: number; label: string; isSpeaking?: boolean }) => (
    <span style={{
      fontSize: "10px", padding: "2px 6px", borderRadius: "4px",
      background: mastered ? "#d4edda" : "#f0f0f0",
      color: mastered ? "#28a745" : "#666",
    }}>
      {label} {mastered ? "✓" : consecutive > 0 ? `${consecutive}/${isSpeaking ? "3" : "3"}` : "—"}
    </span>
  );

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <p style={{ color: "#666" }}>Please select a user from <a href="/">Home</a>.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>📋 Word List</h1>

      <div style={{ display: "flex", gap: "8px", marginBottom: "1rem", flexWrap: "wrap" }}>
        <a href="/" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
        <a href="/vocabulary" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
        <a href="/index-card" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
        <a href="/listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
        <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
        <a href="/speaking" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎤 Speaking</a>
      </div>

      <p style={{ fontSize: "13px", color: "#666", marginBottom: "12px" }}>
        {filteredCards.length} words · {cards.filter((c) => isFullyMastered(c.id)).length} / {cards.length} fully mastered ⭐
      </p>

      {/* カテゴリーフィルター */}
      <div style={{ marginBottom: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <button onClick={() => setCategoryFilter("all")}
          style={{ padding: "4px 10px", borderRadius: "12px", border: categoryFilter === "all" ? "2px solid #4caf50" : "1px solid #ccc", background: categoryFilter === "all" ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
          All categories
        </button>
        {categories.map((cat) => (
          <button key={cat} onClick={() => setCategoryFilter(cat)}
            style={{ padding: "4px 10px", borderRadius: "12px", border: categoryFilter === cat ? "2px solid #4caf50" : "1px solid #ccc", background: categoryFilter === cat ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
            {cat}
          </button>
        ))}
      </div>

      {/* 進捗フィルター */}
      <div style={{ marginBottom: "1.5rem", display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {([
          { value: "all" as ProgressFilter, label: "All" },
          { value: "fully-mastered" as ProgressFilter, label: "⭐ Fully mastered (6/6)" },
          { value: "not-fully-mastered" as ProgressFilter, label: "🔜 Not fully mastered" },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setProgressFilter(opt.value)}
            style={{ padding: "4px 10px", borderRadius: "12px", border: progressFilter === opt.value ? "2px solid #2196f3" : "1px solid #ccc", background: progressFilter === opt.value ? "#e3f2fd" : "white", cursor: "pointer", color: "#111", fontSize: "12px" }}>
            {opt.label}
          </button>
        ))}
      </div>

      {/* 単語一覧 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {filteredCards.map((card) => {
          const masteredCount = getMasteredCount(card.id);
          const fully = masteredCount === 6;
          return (
            <div key={card.id} style={{
              padding: "12px", border: "1px solid #eee", borderRadius: "8px",
              background: fully ? "#f0fff4" : "white",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <strong style={{ fontSize: "16px" }}>{card.word}</strong>
                    <button
                      onClick={() => speak(card.word, speechLang)}
                      onTouchEnd={(e) => { e.preventDefault(); speak(card.word, speechLang); }}
                      style={{ fontSize: "14px", background: "none", border: "none", cursor: "pointer", padding: 0 }}>🔊</button>
                  </div>
                  <p style={{ margin: "2px 0", fontSize: "12px", color: "#aaa" }}>{card.pronunciation}</p>
                  <p style={{ margin: "2px 0", fontSize: "14px", color: "#444" }}>{card.meaning}</p>
                  {card.breakdown && <p style={{ margin: "2px 0", fontSize: "11px", color: "#aaa", fontStyle: "italic" }}>💡 {card.breakdown}</p>}
                  {card.category && <p style={{ margin: "2px 0", fontSize: "11px", color: "#aaa" }}>📁 {card.category}</p>}
                </div>
                <span style={{ fontSize: "12px", color: fully ? "#28a745" : "#999", fontWeight: "500", whiteSpace: "nowrap" }}>
                  {fully ? "⭐ 6/6" : `${masteredCount}/6`}
                </span>
              </div>

              {/* 6パターンの進捗バッジ */}
              <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "6px" }}>
                {badges.map(({ module, direction, label }) => (
                  <ProgressBadge
                    key={`${module}-${direction}`}
                    mastered={isMastered(card.id, module, direction)}
                    consecutive={getConsecutive(card.id, module, direction)}
                    label={label}
                    isSpeaking={module.startsWith("speaking")}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
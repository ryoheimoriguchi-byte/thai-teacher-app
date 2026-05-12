"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "../lib/users";

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
  mastered_at?: string | null;
};

type SpeakingResult = {
  score: number;
  label: string;
  heard: string;
  feedback: string;
  tip: string;
};

type SentenceData = {
  sentence: string;
  pronunciation: string;
  meaning: string;
  cardIds: string[];
};

type HistoryItem = {
  type: "word";
  card: Card;
} | {
  type: "sentence";
  data: SentenceData;
};

type Mode = "word" | "sentence";
type WordMode = "all" | "new-only";

const speak = (text: string, speechLang: string) => {
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = speechLang;
  utterance.rate = 0.7;
  const trySpeak = () => {
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => v.lang.startsWith(speechLang.split("-")[0]));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  };
  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.onvoiceschanged = trySpeak;
  } else {
    trySpeak();
  }
};

function shuffleArray<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

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
  isPassed: boolean,
  currentProgress: WordProgress | undefined
) => {
  const consecutive = isPassed
    ? (currentProgress?.consecutive_correct ?? 0) + 1
    : 0;
  const wasAlreadyMastered = currentProgress?.mastered ?? false;
  const mastered = consecutive >= 3;
  const masteredAt = mastered && !wasAlreadyMastered
    ? new Date().toISOString()
    : currentProgress?.mastered_at ?? null;

  await supabase.from("word_progress").upsert(
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

  return { consecutive, mastered, masteredAt: masteredAt ?? undefined };
};

export default function SpeakingPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [mode, setMode] = useState<Mode>("word");
  const [wordMode, setWordMode] = useState<WordMode>("all");
  const [currentCard, setCurrentCard] = useState<Card | null>(null);
  const [sentenceData, setSentenceData] = useState<SentenceData | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [result, setResult] = useState<SpeakingResult | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showMastered, setShowMastered] = useState(false);
  const [score, setScore] = useState({ passed: 0, total: 0 });
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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
        .eq("language", currentUser.language);
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
  const langLabel = currentUser?.language === "TH" ? "Thai" : "Japanese";
  const langFlag = currentUser?.flag ?? "🇹🇭";
  const moduleKey = mode === "word" ? "speaking-word" : "speaking-sentence";

  const getProgress = (cardId: string) =>
    wordProgress.find((p) => p.card_id === cardId && p.module === moduleKey && p.direction === "en-to-word");

  const pickNextCard = useCallback((addToHistory = true) => {
    if (cards.length === 0) return;
    let pool = cards;
    if (wordMode === "new-only") {
      const filtered = cards.filter((c) => !getProgress(c.id)?.mastered);
      if (filtered.length === 0) {
        if (addToHistory && currentCard) {
          setHistory((prev) => [...prev, { type: "word", card: currentCard }]);
        }
        setCurrentCard(null);
        setResult(null);
        setShowMastered(false);
        return;
      }
      pool = filtered;
    }

    if (addToHistory && currentCard) {
      setHistory((prev) => [...prev, { type: "word", card: currentCard }]);
    }

    const card = pool[Math.floor(Math.random() * pool.length)];
    setCurrentCard(card);
    setResult(null);
    setShowMastered(false);
  }, [cards, wordMode, wordProgress, currentCard]); // eslint-disable-line react-hooks/exhaustive-deps

  const generateSentence = useCallback(async (addToHistory = true) => {
    if (!currentUser) return;

    let workPool = cards;
    if (wordMode === "new-only") {
      const filtered = cards.filter((c) => !getProgress(c.id)?.mastered);
      if (filtered.length === 0) {
        if (addToHistory && sentenceData) {
          setHistory((prev) => [...prev, { type: "sentence", data: sentenceData }]);
        }
        setSentenceData(null);
        setResult(null);
        setShowMastered(false);
        setIsGenerating(false);
        return;
      }
      workPool = filtered;
    }

    if (workPool.length < 3) {
      alert("Need at least 3 words to generate a sentence.");
      return;
    }

    const byCategory = new Map<string, Card[]>();
    for (const c of workPool) {
      const key = c.category || "";
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key)!.push(c);
    }
    const ranked = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length);
    const eligible = ranked.filter(([, arr]) => arr.length >= 3);
    const chosen = eligible.length > 0
      ? eligible[Math.floor(Math.random() * eligible.length)]
      : ranked[0];
    if (!chosen || chosen[1].length < 3) {
      alert("Need at least 3 words in one category.");
      return;
    }
    const [, categoryPool] = chosen;
    const categoryLabel = chosen[0] || "(uncategorized)";

    if (addToHistory && sentenceData) {
      setHistory((prev) => [...prev, { type: "sentence", data: sentenceData }]);
    }

    setIsGenerating(true);
    setResult(null);
    setShowMastered(false);
    setSentenceData(null);

    const sample = shuffleArray(categoryPool).slice(0, Math.min(10, categoryPool.length));
    const prompt = `Create a SHORT, simple ${langLabel} sentence using 2-3 of these words.
All vocabulary is from the SAME category: "${categoryLabel}".

Available words:
${sample.map((c) => `- ${c.word} (${c.pronunciation}) = ${c.meaning} [id:${c.id}]`).join("\n")}

Return ONLY a valid JSON object:
{
  "sentence": "${langLabel} sentence",
  "pronunciation": "romanized pronunciation",
  "meaning": "English translation",
  "cardIds": ["id1", "id2"]
}

Output ONLY the JSON, no markdown.`;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt }),
      });
      const data = await res.json();
      const cleaned = data.reply.replace(/```json\n?|\n?```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setSentenceData(parsed);
    } catch (e) {
      console.error(e);
      alert("Failed to generate sentence. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }, [cards, wordMode, currentUser, langLabel, sentenceData]); // eslint-disable-line react-hooks/exhaustive-deps

  const goBack = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setResult(null);
    setShowMastered(false);
    if (prev.type === "word") {
      setCurrentCard(prev.card);
    } else {
      setSentenceData(prev.data);
    }
  };

  useEffect(() => {
    if (cards.length > 0 && currentUser) {
      if (mode === "word") pickNextCard(false);
      else generateSentence(false);
    }
  }, [cards, mode, wordMode, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await processAudio(blob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (e) {
      console.error(e);
      alert("Microphone access denied. Please allow microphone access.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsProcessing(true);
    }
  };

  const processAudio = async (blob: Blob) => {
    const targetWord = mode === "word" ? currentCard?.word : sentenceData?.sentence;
    const targetPron = mode === "word" ? currentCard?.pronunciation : sentenceData?.pronunciation;

    if (!targetWord || !currentUser) { setIsProcessing(false); return; }

    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");
    formData.append("targetWord", targetWord);
    formData.append("targetPronunciation", targetPron ?? "");
    formData.append("language", currentUser.language);
    formData.append("mode", mode);

    try {
      const res = await fetch("/api/speaking", { method: "POST", body: formData });
      const data: SpeakingResult = await res.json();
      setResult(data);

      const isPassed = data.score >= 4;
      setScore((prev) => ({ passed: prev.passed + (isPassed ? 1 : 0), total: prev.total + 1 }));

      const cardIds = mode === "word"
        ? (currentCard ? [currentCard.id] : [])
        : (sentenceData?.cardIds ?? []);

      for (const cardId of cardIds) {
        const currentProgress = getProgress(cardId);
        const { mastered, masteredAt } = await updateWordProgress(
          currentUser.id, cardId, moduleKey, "en-to-word", isPassed, currentProgress
        );
        const consecutive = isPassed ? (currentProgress?.consecutive_correct ?? 0) + 1 : 0;
        setWordProgress((prev) => {
          const existing = prev.find((p) => p.card_id === cardId && p.module === moduleKey && p.direction === "en-to-word");
          if (existing) {
            return prev.map((p) =>
              p.card_id === cardId && p.module === moduleKey && p.direction === "en-to-word"
                ? { ...p, consecutive_correct: consecutive, mastered, mastered_at: masteredAt }
                : p
            );
          }
          return [...prev, { card_id: cardId, module: moduleKey, direction: "en-to-word", consecutive_correct: consecutive, mastered, mastered_at: masteredAt }];
        });
        if (mastered && !currentProgress?.mastered) setShowMastered(true);
      }

      await recordSession(currentUser.id, moduleKey);
    } catch (e) {
      console.error(e);
      alert("Failed to process audio. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleNext = () => {
    if (mode === "word") pickNextCard();
    else generateSentence();
  };

  const getScoreColor = (s: number) => {
    if (s >= 4) return "#28a745";
    if (s === 3) return "#f39c12";
    return "#dc3545";
  };

  const getScoreBg = (s: number) => {
    if (s >= 4) return "#d4edda";
    if (s === 3) return "#fff3cd";
    return "#f8d7da";
  };

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <p style={{ color: "#666" }}>Please select a user from <a href="/">Home</a>.</p>
      </main>
    );
  }

  const allDoneWord =
    mode === "word" &&
    wordMode === "new-only" &&
    cards.length > 0 &&
    cards.every((c) => getProgress(c.id)?.mastered === true);

  const allDoneSentence =
    mode === "sentence" &&
    wordMode === "new-only" &&
    cards.length > 0 &&
    cards.every((c) => getProgress(c.id)?.mastered === true);

  const targetText = mode === "word" ? currentCard?.word : sentenceData?.sentence;
  const targetPron = mode === "word" ? currentCard?.pronunciation : sentenceData?.pronunciation;
  const targetMeaning = mode === "word" ? currentCard?.meaning : sentenceData?.meaning;
  const isLoading =
    isGenerating ||
    (mode === "word" && !allDoneWord && currentCard === null && cards.length > 0);

  return (
    <main style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
      <h1 style={{ marginBottom: "0.5rem" }}>🎤 Speaking</h1>

      <div style={{ display: "flex", gap: "8px", marginBottom: "1rem", flexWrap: "wrap" }}>
        <a href="/" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
        <a href="/vocabulary" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
        <a href="/index-card" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
        <a href="/listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
        <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
        <a href="/speaking" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎤 Speaking</a>
      </div>

      <div style={{ marginBottom: "8px", display: "flex", gap: "8px" }}>
        {([
          { value: "word" as Mode, label: `${langFlag} Word` },
          { value: "sentence" as Mode, label: `${langFlag} Sentence` },
        ]).map((opt) => (
          <button key={opt.value} onClick={() => setMode(opt.value)}
            style={{ padding: "6px 14px", borderRadius: "20px", border: mode === opt.value ? "2px solid #4caf50" : "1px solid #ccc", background: mode === opt.value ? "#e8f5e9" : "white", cursor: "pointer", color: "#111", fontWeight: mode === opt.value ? "bold" : "normal", fontSize: "13px" }}>
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
        Score: {score.passed} / {score.total}
        <span style={{ marginLeft: "12px", fontSize: "13px", color: "#4caf50" }}>
          {wordProgress.filter((p) => p.module === moduleKey && p.mastered).length} mastered ✓
        </span>
      </p>

      {showMastered && (
        <div style={{ background: "#d4edda", border: "1px solid #28a745", borderRadius: "8px", padding: "12px", marginBottom: "1rem", textAlign: "center" }}>
          <p style={{ margin: 0, color: "#28a745", fontWeight: "bold" }}>⭐ Word Mastered! 3 times 4/5 or above!</p>
        </div>
      )}

      {(allDoneWord || allDoneSentence) && (
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
            Every word is mastered for Speaking · this mode. Switch to &quot;All words&quot; or try another exercise.
          </p>
        </div>
      )}

      {isLoading && (
        <p style={{ textAlign: "center", color: "#666" }}>
          {isGenerating ? "AI is creating a sentence..." : "Loading..."}
        </p>
      )}

      {!isLoading && targetText && (
        <>
          {/* 問題カード */}
          <div style={{ background: "#f9f9f9", borderRadius: "12px", padding: "20px", textAlign: "center", marginBottom: "16px" }}>
            <p style={{ fontSize: "11px", color: "#aaa", margin: "0 0 6px" }}>
              Say this {mode === "word" ? "word" : "sentence"} in {langLabel}:
            </p>
            <p style={{ fontSize: "20px", fontWeight: "500", margin: "0 0 4px" }}>{targetMeaning}</p>
            {mode === "word" && currentCard?.category && (
              <p style={{ fontSize: "11px", color: "#aaa", margin: "0 0 12px" }}>Category: {currentCard.category}</p>
            )}
            {mode === "word" && currentCard && (
              <div style={{ display: "flex", justifyContent: "center", gap: "4px", marginBottom: "12px" }}>
                {[0,1,2].map((i) => (
                  <div key={i} style={{ width: "8px", height: "8px", borderRadius: "50%", background: i < (getProgress(currentCard.id)?.consecutive_correct ?? 0) ? "#4caf50" : "#ddd" }} />
                ))}
              </div>
            )}
            <button
              onClick={() => speak(targetText, speechLang)}
              onTouchEnd={(e) => { e.preventDefault(); speak(targetText, speechLang); }}
              style={{ padding: "6px 16px", border: "1px solid #4caf50", color: "#4caf50", background: "white", borderRadius: "16px", fontSize: "13px", cursor: "pointer" }}>
              🔊 Hear example
            </button>
          </div>

          {/* Back / Skip */}
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}>
            <button
              onClick={goBack}
              disabled={history.length === 0}
              style={{ padding: "4px 12px", border: "1px solid #ccc", borderRadius: "12px", background: "white", color: history.length === 0 ? "#ccc" : "#666", fontSize: "12px", cursor: history.length === 0 ? "default" : "pointer" }}>
              ← Back
            </button>
            <button
              onClick={handleNext}
              style={{ padding: "4px 12px", border: "1px solid #ccc", borderRadius: "12px", background: "white", color: "#999", fontSize: "12px", cursor: "pointer" }}>
              Skip →
            </button>
          </div>

          {/* 録音ボタン */}
          <div style={{ textAlign: "center", marginBottom: "16px" }}>
            <button
              onClick={isRecording ? stopRecording : startRecording}
              onTouchEnd={(e) => { e.preventDefault(); isRecording ? stopRecording() : startRecording(); }}
              disabled={isProcessing}
              style={{
                width: "90px", height: "90px", borderRadius: "50%",
                background: isRecording ? "#dc3545" : isProcessing ? "#ccc" : "#4caf50",
                border: "none", color: "white", fontSize: "36px", cursor: isProcessing ? "default" : "pointer",
                boxShadow: isRecording ? "0 0 0 8px rgba(220,53,69,0.2)" : "none",
                transition: "all 0.2s",
              }}>
              {isProcessing ? "⏳" : isRecording ? "⏹" : "🎤"}
            </button>
            <p style={{ fontSize: "12px", color: "#999", margin: "8px 0 0" }}>
              {isProcessing ? "Processing..." : isRecording ? "Tap to stop" : "Tap to record"}
            </p>
          </div>

          {/* 結果 */}
          {result && (
            <div style={{ background: getScoreBg(result.score), border: `1px solid ${getScoreColor(result.score)}`, borderRadius: "8px", padding: "16px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <p style={{ fontSize: "16px", fontWeight: "bold", color: getScoreColor(result.score), margin: 0 }}>
                  {result.score}/5 — {result.label}
                </p>
                <div style={{ display: "flex", gap: "2px" }}>
                  {[1,2,3,4,5].map((i) => (
                    <span key={i} style={{ fontSize: "14px", opacity: i <= result.score ? 1 : 0.2 }}>⭐</span>
                  ))}
                </div>
              </div>
              <p style={{ fontSize: "12px", color: "#555", margin: "0 0 4px" }}>
                🎤 Heard: <strong>{result.heard || "—"}</strong>
              </p>
              <p style={{ fontSize: "12px", color: "#555", margin: "0 0 4px" }}>
                ✅ Answer: <strong>{targetText}</strong> ({targetPron})
              </p>
              <p style={{ fontSize: "12px", color: "#555", margin: "0 0 4px" }}>💬 {result.feedback}</p>
              {result.tip && (
                <p style={{ fontSize: "12px", color: "#888", margin: 0, fontStyle: "italic" }}>💡 {result.tip}</p>
              )}
            </div>
          )}

          {result && (
            <button onClick={handleNext}
              style={{ width: "100%", padding: "12px", background: "#4caf50", color: "white", border: "none", borderRadius: "8px", fontSize: "16px", cursor: "pointer" }}>
              Next →
            </button>
          )}
        </>
      )}
    </main>
  );
}
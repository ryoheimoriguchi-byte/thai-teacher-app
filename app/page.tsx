"use client";

import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "./lib/users";
import {
  countMasteredInStage,
  countMasteredInStageByDirection,
  fetchHomeStageData,
  getStageCellDisplay,
  HOME_STAGE_ROWS,
  STAGE_COLUMN_NUMBERS,
} from "./lib/stage-progress";
import { fetchAllWordProgress } from "./lib/word-progress";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type WordProgress = {
  card_id: string;
  module: string;
  direction: string;
  mastered: boolean;
  mastered_at?: string;
};

type StudySession = {
  studied_date: string;
  module: string;
};

type Card = {
  id: string;
  language: string;
};

type JpReadingMeta = {
  hiraganaIds: string[];
  katakanaIds: string[];
  jpWordIds: string[];
};

const MIN_YEAR = 2026;
const MIN_MONTH = 4;

export default function Home() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [jpReadingMeta, setJpReadingMeta] = useState<JpReadingMeta>({
    hiraganaIds: [],
    katakanaIds: [],
    jpWordIds: [],
  });
  const [newUserName, setNewUserName] = useState("");
  const [newUserLanguage, setNewUserLanguage] = useState<"TH" | "JP">("TH");
  const [showAddUser, setShowAddUser] = useState(false);
  const [stageHome, setStageHome] = useState<{
    currentByModule: Record<string, number>;
    cardsByStage: Map<number, string[]>;
  } | null>(null);

  const today = new Date();
  const [calendarYear, setCalendarYear] = useState(today.getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(today.getMonth());

  useEffect(() => {
    const fetchUsers = async () => {
      const { data } = await supabase.from("users").select("*").order("created_at");
      if (data) {
        const appUsers: AppUser[] = data.map((u: { id: string; name: string }) => {
          const language = LANGUAGE_MAP[u.id] ?? "TH";
          return {
            id: u.id,
            name: u.name,
            language,
            flag: FLAG_MAP[language],
          };
        });
        setUsers(appUsers);
      }
    };
    fetchUsers();
  }, []);

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (userId && users.length > 0) {
      const user = users.find((u) => u.id === userId);
      if (user) setCurrentUser(user);
    }
  }, [users]);

  useEffect(() => {
    if (!currentUser) return;
    const fetchData = async () => {
      const [{ data: cardData }, progressData, { data: sessionData }, { data: jpCharCards }, { data: jpWordCards }] =
        await Promise.all([
          supabase
            .from("cards")
            .select("id, language")
            .eq("language", currentUser.language)
            .eq("type", "word"),
          fetchAllWordProgress(supabase, currentUser.id),
          supabase
            .from("study_sessions")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("studied_date", { ascending: false }),
          supabase
            .from("cards")
            .select("id, character_type")
            .eq("language", "JP")
            .eq("type", "character"),
          supabase.from("cards").select("id").eq("language", "JP").eq("type", "word"),
        ]);

      if (cardData) setCards(cardData);
      if (progressData) setWordProgress(progressData);
      if (sessionData) setStudySessions(sessionData);

      const hIds =
        jpCharCards?.filter((c) => c.character_type === "hiragana").map((c) => c.id) ?? [];
      const kIds =
        jpCharCards?.filter((c) => c.character_type === "katakana").map((c) => c.id) ?? [];
      setJpReadingMeta({
        hiraganaIds: hIds,
        katakanaIds: kIds,
        jpWordIds: jpWordCards?.map((c) => c.id) ?? [],
      });
    };
    fetchData();
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || currentUser.language !== "JP") {
      setStageHome(null);
      return;
    }
    fetchHomeStageData(supabase, currentUser.id)
      .then(setStageHome)
      .catch(() => setStageHome(null));
  }, [currentUser]);

  const totalWords = cards.length;

  const getMastered = (module: string, direction: string) =>
    wordProgress.filter((p) => p.module === module && p.direction === direction && p.mastered).length;

  const getWeeklyNew = (module: string, direction: string) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    return wordProgress.filter((p) =>
      p.module === module &&
      p.direction === direction &&
      p.mastered &&
      p.mastered_at &&
      new Date(p.mastered_at) >= sevenDaysAgo
    ).length;
  };

  const cardIdSet = (ids: string[]) => new Set(ids);

  const getReadingCharacterMastered = (ids: string[]) => {
    const s = cardIdSet(ids);
    return wordProgress.filter(
      (p) =>
        p.module === "reading_character" &&
        p.direction === "en-to-word" &&
        p.mastered &&
        s.has(p.card_id)
    ).length;
  };

  const getReadingCharacterWeekly = (ids: string[]) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const s = cardIdSet(ids);
    return wordProgress.filter(
      (p) =>
        p.module === "reading_character" &&
        p.direction === "en-to-word" &&
        p.mastered &&
        p.mastered_at &&
        s.has(p.card_id) &&
        new Date(p.mastered_at) >= sevenDaysAgo
    ).length;
  };

  const getReadingWordMastered = () => {
    const s = cardIdSet(jpReadingMeta.jpWordIds);
    return wordProgress.filter(
      (p) =>
        p.module === "reading_word" &&
        p.direction === "en-to-word" &&
        p.mastered &&
        s.has(p.card_id)
    ).length;
  };

  const getReadingWordWeekly = () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const s = cardIdSet(jpReadingMeta.jpWordIds);
    return wordProgress.filter(
      (p) =>
        p.module === "reading_word" &&
        p.direction === "en-to-word" &&
        p.mastered &&
        p.mastered_at &&
        s.has(p.card_id) &&
        new Date(p.mastered_at) >= sevenDaysAgo
    ).length;
  };

  const calcStreak = () => {
    const dates = Array.from(new Set(studySessions.map((s) => s.studied_date))).sort().reverse();
    if (dates.length === 0) return 0;
    let streak = 0;
    const todayStr = new Date().toISOString().split("T")[0];
    let current = new Date(todayStr);
    for (const date of dates) {
      const d = new Date(date);
      const diff = Math.round((current.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
      if (diff <= 1) { streak++; current = d; }
      else break;
    }
    return streak;
  };

  const getStudiedDates = () =>
    new Set(studySessions.map((s) => s.studied_date));

  const streak = currentUser ? calcStreak() : 0;
  const studiedDates = currentUser ? getStudiedDates() : new Set<string>();

  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const todayStr = today.toISOString().split("T")[0];

  const canGoPrev = calendarYear > MIN_YEAR || calendarMonth > MIN_MONTH;
  const canGoNext = calendarYear < today.getFullYear() || calendarMonth < today.getMonth();

  const goPrevMonth = () => {
    if (!canGoPrev) return;
    if (calendarMonth === 0) { setCalendarYear(calendarYear - 1); setCalendarMonth(11); }
    else setCalendarMonth(calendarMonth - 1);
  };

  const goNextMonth = () => {
    if (!canGoNext) return;
    if (calendarMonth === 11) { setCalendarYear(calendarYear + 1); setCalendarMonth(0); }
    else setCalendarMonth(calendarMonth + 1);
  };

  const monthLabel = new Date(calendarYear, calendarMonth).toLocaleString("en", { month: "long" });

  const modules = [
    { module: "listening", direction: "word-to-en", label: "🎧 Listening", dir: `${currentUser?.flag} → 🇬🇧`, stageModule: "listening" },
    { module: "listening", direction: "en-to-word", label: "🎧 Listening", dir: `🇬🇧 → ${currentUser?.flag}`, stageModule: "listening" },
    { module: "sentence", direction: "word-to-en", label: "💬 Sentence", dir: `${currentUser?.flag} → 🇬🇧`, stageModule: "sentence" },
    { module: "sentence", direction: "en-to-word", label: "💬 Sentence", dir: `🇬🇧 → ${currentUser?.flag}`, stageModule: "sentence" },
    { module: "speaking-word", direction: "en-to-word", label: "🎤 Speaking", dir: "Word", stageModule: "speaking-word" },
    { module: "speaking-sentence", direction: "en-to-word", label: "🎤 Speaking", dir: "Sentence", stageModule: "speaking-sentence" },
  ];

  type ProgressRow = {
    key: string;
    label: string;
    mastered: number;
    total: number;
    weekly: number;
  };

  const getWeeklyNewInStage = (module: string, direction: string, cardIds: string[]) => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const idSet = new Set(cardIds);
    return wordProgress.filter(
      (p) =>
        p.module === module &&
        p.direction === direction &&
        p.mastered &&
        p.mastered_at &&
        idSet.has(p.card_id) &&
        new Date(p.mastered_at) >= sevenDaysAgo
    ).length;
  };

  const buildStageModuleProgressRows = (): ProgressRow[] => {
    if (!stageHome) return [];
    const rows: ProgressRow[] = [];
    for (const { module, direction, label, dir, stageModule } of modules) {
      const currentStage = stageHome.currentByModule[stageModule] ?? 1;
      for (let stage = 1; stage <= currentStage; stage++) {
        const cardIds = stageHome.cardsByStage.get(stage) ?? [];
        rows.push({
          key: `${module}-${direction}-stage-${stage}`,
          label: `${label}: ${dir} (Stage ${stage})`,
          mastered: countMasteredInStageByDirection(module, direction, cardIds, wordProgress),
          total: cardIds.length,
          weekly: getWeeklyNewInStage(module, direction, cardIds),
        });
      }
    }
    return rows;
  };

  const buildFlatModuleProgressRows = (): ProgressRow[] =>
    modules.map(({ module, direction, label, dir }) => ({
      key: `${module}-${direction}`,
      label: `${label}: ${dir}`,
      mastered: getMastered(module, direction),
      total: totalWords,
      weekly: getWeeklyNew(module, direction),
    }));

  const moduleProgressRows =
    currentUser?.language === "JP" && stageHome
      ? buildStageModuleProgressRows()
      : buildFlatModuleProgressRows();

  const buildReadingWordProgressRows = (): ProgressRow[] => {
    if (currentUser?.language === "JP" && stageHome) {
      const rows: ProgressRow[] = [];
      const currentStage = stageHome.currentByModule.reading_word ?? 1;
      for (let stage = 1; stage <= currentStage; stage++) {
        const cardIds = stageHome.cardsByStage.get(stage) ?? [];
        rows.push({
          key: `reading-word-stage-${stage}`,
          label: `📖 Reading: Word (Stage ${stage})`,
          mastered: countMasteredInStageByDirection(
            "reading_word",
            "en-to-word",
            cardIds,
            wordProgress
          ),
          total: cardIds.length,
          weekly: getWeeklyNewInStage("reading_word", "en-to-word", cardIds),
        });
      }
      return rows;
    }
    return [
      {
        key: "reading-word",
        label: "📖 Reading: Word",
        mastered: getReadingWordMastered(),
        total: jpReadingMeta.jpWordIds.length,
        weekly: getReadingWordWeekly(),
      },
    ];
  };

  const readingWordProgressRows = buildReadingWordProgressRows();

  const progressSubtitleTotal =
    currentUser?.language === "JP" && stageHome
      ? (() => {
          const maxStage = Math.max(
            1,
            ...Object.values(stageHome.currentByModule).map((s) => s ?? 1)
          );
          return Array.from({ length: maxStage }, (_, i) => i + 1).reduce(
            (sum, stage) => sum + (stageHome.cardsByStage.get(stage)?.length ?? 0),
            0
          );
        })()
      : totalWords;

  const weeklyMotivation = (count: number) => {
    if (count === 0) return { text: "Not started this week — let's go! 💪", color: "#f39c12" };
    if (count < 3) return { text: `+${count} words this week 📈`, color: "#2196f3" };
    if (count < 7) return { text: `+${count} words this week 🚀`, color: "#2196f3" };
    return { text: `+${count} words this week ⭐ Amazing!`, color: "#4caf50" };
  };

  const getUserEmoji = (user: AppUser) => {
    if (user.name === "Dad") return "👨";
    if (user.name === "Mirei") return "👧";
    return "👤";
  };

  const addNewUser = async () => {
    if (!newUserName.trim()) return;
    const { data, error } = await supabase
      .from("users")
      .insert({ name: newUserName })
      .select()
      .single();
    if (error) {
      console.error("Error adding user:", error);
      alert("Failed to add user. Please try again.");
      return;
    }
    if (data) {
      const newUser: AppUser = {
        id: data.id,
        name: data.name,
        language: newUserLanguage,
        flag: FLAG_MAP[newUserLanguage],
      };
      LANGUAGE_MAP[data.id] = newUserLanguage;
      setUsers((prev) => [...prev, newUser]);
      setNewUserName("");
      setShowAddUser(false);
    }
  };

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: "480px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <h1 style={{ marginBottom: "0.5rem" }}>🌏 Language Teacher AI</h1>
        <p style={{ color: "#666", fontSize: "14px", marginBottom: "1.5rem" }}>Who are you?</p>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "1.5rem" }}>
          {users.map((user) => (
            <button
              key={user.id}
              onClick={() => { localStorage.setItem("currentUserId", user.id); setCurrentUser(user); }}
              onTouchEnd={(e) => { e.preventDefault(); localStorage.setItem("currentUserId", user.id); setCurrentUser(user); }}
              style={{
                flex: "1 1 120px", padding: "20px 12px", border: "1px solid #ccc", borderRadius: "12px",
                background: "white", cursor: "pointer", textAlign: "center",
                WebkitTapHighlightColor: "transparent",
              } as React.CSSProperties}
            >
              <div style={{ fontSize: "32px", marginBottom: "6px" }}>{getUserEmoji(user)}</div>
              <div style={{ fontWeight: "bold", fontSize: "15px", color: "#111" }}>{user.name}</div>
              <div style={{ fontSize: "12px", color: "#666", marginTop: "4px" }}>
                {user.flag} {user.language === "TH" ? "Thai" : "Japanese"}
              </div>
            </button>
          ))}

          <button
            onClick={() => setShowAddUser(!showAddUser)}
            style={{
              flex: "1 1 120px", padding: "20px 12px", border: "1px dashed #ccc", borderRadius: "12px",
              background: "white", cursor: "pointer", textAlign: "center", color: "#999",
              WebkitTapHighlightColor: "transparent",
            } as React.CSSProperties}
          >
            <div style={{ fontSize: "32px", marginBottom: "6px" }}>➕</div>
            <div style={{ fontSize: "14px" }}>Add User</div>
          </button>
        </div>

        {showAddUser && (
          <div style={{ border: "1px solid #eee", borderRadius: "12px", padding: "16px", background: "#f9f9f9" }}>
            <p style={{ fontSize: "14px", fontWeight: "500", margin: "0 0 12px", color: "#111" }}>New User</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <input
                placeholder="Name"
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addNewUser()}
                style={{ padding: "8px 12px", border: "1px solid #ccc", borderRadius: "8px", fontSize: "16px", color: "#111", background: "white" }}
              />
              <select
                value={newUserLanguage}
                onChange={(e) => setNewUserLanguage(e.target.value as "TH" | "JP")}
                style={{ padding: "8px 12px", border: "1px solid #ccc", borderRadius: "8px", fontSize: "16px", color: "#111", background: "white" }}
              >
                <option value="TH">🇹🇭 Thai</option>
                <option value="JP">🇯🇵 Japanese</option>
              </select>
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={() => setShowAddUser(false)}
                  style={{ flex: 1, padding: "10px", border: "1px solid #ccc", borderRadius: "8px", background: "white", color: "#666", cursor: "pointer", fontSize: "14px" }}>
                  Cancel
                </button>
                <button
                  onClick={addNewUser}
                  disabled={!newUserName.trim()}
                  style={{
                    flex: 1, padding: "10px",
                    background: newUserName.trim() ? "#4caf50" : "#ccc",
                    color: "white", border: "none", borderRadius: "8px",
                    cursor: newUserName.trim() ? "pointer" : "default", fontSize: "14px"
                  }}>
                  + Add
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", maxWidth: "600px", margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h1 style={{ fontSize: "20px", margin: 0 }}>
          {currentUser.flag} {currentUser.language === "TH" ? "Thai" : "Japanese"} Teacher
        </h1>
        <button
          onClick={() => { localStorage.removeItem("currentUserId"); setCurrentUser(null); }}
          style={{ fontSize: "13px", color: "#999", background: "none", border: "none", cursor: "pointer" }}
        >
          {getUserEmoji(currentUser)} {currentUser.name} ✕
        </button>
      </div>

      <div style={{ display: "flex", gap: "6px", marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <a href="/" style={{ padding: "6px 14px", background: "#4caf50", color: "white", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🏠 Home</a>
        <a href="/vocabulary" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📋 Word List</a>
        <a href="/index-card" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🃏 Index Card</a>
        <a href="/listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎧 Listening</a>
        <a href="/sentence-listening" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>💬 Sentence</a>
        <a href="/speaking" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>🎤 Speaking</a>
        <a href="/reading" style={{ padding: "6px 14px", background: "#eee", color: "#111", borderRadius: "20px", textDecoration: "none", fontSize: "14px" }}>📖 Reading</a>
      </div>

      <div style={{ background: "linear-gradient(135deg, #ff6b35, #f7931e)", color: "white", padding: "16px", borderRadius: "12px", marginBottom: "16px", textAlign: "center" }}>
        <p style={{ fontSize: "36px", margin: 0, fontWeight: "bold" }}>🔥 {streak}</p>
        <p style={{ fontSize: "14px", margin: "4px 0 0" }}>
          {streak === 0 ? "Start your streak today!" : streak === 1 ? "day streak! Keep going!" : "days in a row! Amazing!"}
        </p>
      </div>

      <div style={{ background: "#f9f9f9", padding: "12px", borderRadius: "8px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <button onClick={goPrevMonth} disabled={!canGoPrev}
            style={{ background: "none", border: "none", cursor: canGoPrev ? "pointer" : "default", color: canGoPrev ? "#333" : "#ccc", fontSize: "16px", padding: "4px 8px" }}>←</button>
          <p style={{ fontSize: "13px", fontWeight: "500", margin: 0 }}>{monthLabel} {calendarYear}</p>
          <button onClick={goNextMonth} disabled={!canGoNext}
            style={{ background: "none", border: "none", cursor: canGoNext ? "pointer" : "default", color: canGoNext ? "#333" : "#ccc", fontSize: "16px", padding: "4px 8px" }}>→</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px", textAlign: "center", fontSize: "10px", color: "#999", marginBottom: "4px" }}>
          {["S","M","T","W","T","F","S"].map((d, i) => <div key={i}>{d}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "4px" }}>
          {Array.from({ length: firstDay }).map((_, i) => <div key={`empty-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const isToday = dateStr === todayStr;
            const isStudied = studiedDates.has(dateStr);
            const isFuture = dateStr > todayStr;
            return (
              <div key={day} style={{
                aspectRatio: "1", borderRadius: "4px", display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: "10px",
                background: isToday ? "#4caf50" : isStudied ? "#d4edda" : "#f0f0f0",
                color: isToday ? "white" : isStudied ? "#28a745" : isFuture ? "#ddd" : "#999",
                fontWeight: isToday ? "bold" : "normal",
              }}>
                {isStudied && !isToday ? "✓" : day}
              </div>
            );
          })}
        </div>
      </div>

      <h3 style={{ fontSize: "14px", margin: "0 0 10px" }}>
        Progress{" "}
        <span style={{ fontSize: "11px", color: "#999", fontWeight: "normal" }}>
          (out of {progressSubtitleTotal} {currentUser.language === "TH" ? "Thai" : "Japanese"} words)
        </span>
      </h3>

      {moduleProgressRows.map(({ key, label, mastered, total, weekly }) => {
        const motivation = weeklyMotivation(weekly);
        const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;

        return (
          <div key={key} style={{ background: "#f9f9f9", padding: "12px", borderRadius: "8px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: "500" }}>{label}</span>
              <span style={{ fontSize: "12px", color: "#4caf50", fontWeight: "500" }}>{mastered} / {total}</span>
            </div>
            <div style={{ background: "#ddd", height: "6px", borderRadius: "3px", overflow: "hidden", marginBottom: "6px" }}>
              <div style={{ background: "#4caf50", width: `${percent}%`, height: "100%", borderRadius: "3px", transition: "width 0.5s" }} />
            </div>
            <span style={{ fontSize: "11px", color: motivation.color, fontWeight: "500" }}>
              {motivation.text}
            </span>
          </div>
        );
      })}

      {([
        {
          key: "reading-hiragana",
          label: "📖 Reading: Hiragana",
          mastered: getReadingCharacterMastered(jpReadingMeta.hiraganaIds),
          total: jpReadingMeta.hiraganaIds.length,
          weekly: getReadingCharacterWeekly(jpReadingMeta.hiraganaIds),
        },
        {
          key: "reading-katakana",
          label: "📖 Reading: Katakana",
          mastered: getReadingCharacterMastered(jpReadingMeta.katakanaIds),
          total: jpReadingMeta.katakanaIds.length,
          weekly: getReadingCharacterWeekly(jpReadingMeta.katakanaIds),
        },
      ]).map(({ key, label, mastered, total, weekly }) => {
        const motivation = weeklyMotivation(weekly);
        const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;
        return (
          <div key={key} style={{ background: "#f9f9f9", padding: "12px", borderRadius: "8px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: "500" }}>{label}</span>
              <span style={{ fontSize: "12px", color: "#4caf50", fontWeight: "500" }}>{mastered} / {total}</span>
            </div>
            <div style={{ background: "#ddd", height: "6px", borderRadius: "3px", overflow: "hidden", marginBottom: "6px" }}>
              <div style={{ background: "#4caf50", width: `${percent}%`, height: "100%", borderRadius: "3px", transition: "width 0.5s" }} />
            </div>
            <span style={{ fontSize: "11px", color: motivation.color, fontWeight: "500" }}>
              {motivation.text}
            </span>
          </div>
        );
      })}

      {readingWordProgressRows.map(({ key, label, mastered, total, weekly }) => {
        const motivation = weeklyMotivation(weekly);
        const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;
        return (
          <div key={key} style={{ background: "#f9f9f9", padding: "12px", borderRadius: "8px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: "500" }}>{label}</span>
              <span style={{ fontSize: "12px", color: "#4caf50", fontWeight: "500" }}>{mastered} / {total}</span>
            </div>
            <div style={{ background: "#ddd", height: "6px", borderRadius: "3px", overflow: "hidden", marginBottom: "6px" }}>
              <div style={{ background: "#4caf50", width: `${percent}%`, height: "100%", borderRadius: "3px", transition: "width 0.5s" }} />
            </div>
            <span style={{ fontSize: "11px", color: motivation.color, fontWeight: "500" }}>
              {motivation.text}
            </span>
          </div>
        );
      })}

      {currentUser.language === "JP" && stageHome && (
        <>
          <h3 style={{ fontSize: "14px", margin: "16px 0 10px" }}>Stage</h3>
          <div
            style={{
              overflowX: "auto",
              marginBottom: "8px",
              border: "1px solid #eee",
              borderRadius: "8px",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "11px",
                minWidth: "320px",
              }}
            >
              <thead>
                <tr style={{ background: "#f5f5f5" }}>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "8px 6px",
                      fontWeight: 600,
                      position: "sticky",
                      left: 0,
                      background: "#f5f5f5",
                    }}
                  >
                    Module
                  </th>
                  {STAGE_COLUMN_NUMBERS.map((n) => (
                    <th
                      key={n}
                      style={{
                        padding: "8px 4px",
                        fontWeight: 600,
                        textAlign: "center",
                        minWidth: "44px",
                      }}
                    >
                      S{n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {HOME_STAGE_ROWS.map(({ label, module }) => {
                  const currentStage = stageHome.currentByModule[module] ?? 1;
                  return (
                    <tr key={module} style={{ borderTop: "1px solid #eee" }}>
                      <td
                        style={{
                          padding: "8px 6px",
                          fontWeight: 500,
                          position: "sticky",
                          left: 0,
                          background: "white",
                        }}
                      >
                        {label}
                      </td>
                      {STAGE_COLUMN_NUMBERS.map((stageNum) => {
                        const cardIds =
                          stageHome.cardsByStage.get(stageNum) ?? [];
                        const mastered = countMasteredInStage(
                          module,
                          cardIds,
                          wordProgress
                        );
                        const cell = getStageCellDisplay(
                          stageNum,
                          currentStage,
                          mastered,
                          cardIds.length
                        );
                        let text = "🔒";
                        let color = "#bbb";
                        if (cell.kind === "progress") {
                          text = `${cell.percent}%`;
                          color = cell.percent >= 90 ? "#4caf50" : "#2196f3";
                        }
                        return (
                          <td
                            key={stageNum}
                            style={{
                              padding: "8px 4px",
                              textAlign: "center",
                              color,
                              fontWeight: cell.kind === "progress" ? 600 : 400,
                            }}
                          >
                            {cardIds.length === 0 && stageNum > 1 ? "—" : text}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
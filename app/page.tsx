"use client";

import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "./lib/users";

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

const MIN_YEAR = 2026;
const MIN_MONTH = 4;

export default function Home() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [wordProgress, setWordProgress] = useState<WordProgress[]>([]);
  const [studySessions, setStudySessions] = useState<StudySession[]>([]);
  const [newUserName, setNewUserName] = useState("");
  const [newUserLanguage, setNewUserLanguage] = useState<"TH" | "JP">("TH");
  const [showAddUser, setShowAddUser] = useState(false);

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
      const { data: cardData } = await supabase
        .from("cards")
        .select("id, language")
        .eq("language", currentUser.language);
      if (cardData) setCards(cardData);

      const { data: progressData } = await supabase
        .from("word_progress")
        .select("*")
        .eq("user_id", currentUser.id);
      if (progressData) setWordProgress(progressData);

      const { data: sessionData } = await supabase
        .from("study_sessions")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("studied_date", { ascending: false });
      if (sessionData) setStudySessions(sessionData);
    };
    fetchData();
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
    { module: "listening", direction: "word-to-en", label: "🎧 Listening", dir: `${currentUser?.flag} → 🇬🇧` },
    { module: "listening", direction: "en-to-word", label: "🎧 Listening", dir: `🇬🇧 → ${currentUser?.flag}` },
    { module: "sentence", direction: "word-to-en", label: "💬 Sentence", dir: `${currentUser?.flag} → 🇬🇧` },
    { module: "sentence", direction: "en-to-word", label: "💬 Sentence", dir: `🇬🇧 → ${currentUser?.flag}` },
    { module: "speaking-word", direction: "en-to-word", label: "🎤 Speaking", dir: "Word" },
    { module: "speaking-sentence", direction: "en-to-word", label: "🎤 Speaking", dir: "Sentence" },
  ];

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
          (out of {totalWords} {currentUser.language === "TH" ? "Thai" : "Japanese"} words)
        </span>
      </h3>

      {modules.map(({ module, direction, label, dir }) => {
        const mastered = getMastered(module, direction);
        const weekly = getWeeklyNew(module, direction);
        const motivation = weeklyMotivation(weekly);
        const percent = totalWords > 0 ? Math.round((mastered / totalWords) * 100) : 0;

        return (
          <div key={`${module}-${direction}`} style={{ background: "#f9f9f9", padding: "12px", borderRadius: "8px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
              <span style={{ fontSize: "13px", fontWeight: "500" }}>{label}: {dir}</span>
              <span style={{ fontSize: "12px", color: "#4caf50", fontWeight: "500" }}>{mastered} / {totalWords} ✓</span>
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
    </main>
  );
}
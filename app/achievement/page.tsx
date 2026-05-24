"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import Link from "next/link";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "@/app/lib/users";
import {
  BADGE_MODULES,
  type BadgeModule,
  getBadgeEmoji,
  getModuleDisplayLabel,
  getUnviewedBadgeCountByModule,
  markBadgeAsViewed,
  markModuleBadgesAsViewed,
} from "@/app/lib/badges";
import { BadgeDetailModal } from "@/app/lib/badge-earned-modal";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type UserBadge = {
  id: string;
  module: string;
  category: string;
  threshold: number;
  earned_at: string;
  viewed_at: string | null;
};

type AchievementModuleTab = {
  id: BadgeModule | "speaking";
  label: string;
  modules: BadgeModule[];
};

const MODULE_TABS: AchievementModuleTab[] = [
  { id: "listening", label: "Listening", modules: ["listening"] },
  { id: "speaking", label: "Speaking", modules: ["speaking-word", "speaking-sentence"] },
  { id: "reading_word", label: "Reading", modules: ["reading_word"] },
  { id: "sentence", label: "Sentence", modules: ["sentence"] },
];

type SubTab = "badges" | "timeline";
type TimelineView = "new" | "total";

const TIMELINE_CHART_HEIGHT = 280;
const MODULE_BAR_CHART_HEIGHT = 220;

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function weekKey(d: Date): string {
  return startOfWeek(d).toISOString().slice(0, 10);
}

function buildLast12Weeks(): { key: string; label: string }[] {
  const weeks: { key: string; label: string }[] = [];
  const now = startOfWeek(new Date());
  for (let i = 11; i >= 0; i--) {
    const w = new Date(now);
    w.setDate(w.getDate() - i * 7);
    const key = weekKey(w);
    weeks.push({
      key,
      label: `${w.getMonth() + 1}/${w.getDate()}`,
    });
  }
  return weeks;
}

function badgeEarnStreakDays(badges: UserBadge[]): number {
  const dates = Array.from(
    new Set(badges.map((b) => b.earned_at.split("T")[0]))
  ).sort()
    .reverse();
  if (dates.length === 0) return 0;
  let streak = 0;
  const todayStr = new Date().toISOString().split("T")[0];
  let current = new Date(todayStr);
  for (const date of dates) {
    const d = new Date(date);
    const diff = Math.round(
      (current.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diff <= 1) {
      streak++;
      current = d;
    } else break;
  }
  return streak;
}

export default function AchievementPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [badges, setBadges] = useState<UserBadge[]>([]);
  const [subTab, setSubTab] = useState<SubTab>("badges");
  const [activeModuleTab, setActiveModuleTab] = useState<AchievementModuleTab["id"]>("listening");
  const [timelineView, setTimelineView] = useState<TimelineView>("new");
  const [unviewedByModule, setUnviewedByModule] = useState<Record<string, number>>({});
  const [selectedBadge, setSelectedBadge] = useState<UserBadge | null>(null);
  const [detailShowNew, setDetailShowNew] = useState(false);

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (!userId) return;
    supabase
      .from("users")
      .select("*")
      .eq("id", userId)
      .single()
      .then(({ data }) => {
        if (!data) return;
        const language = LANGUAGE_MAP[data.id] ?? "TH";
        setCurrentUser({
          id: data.id,
          name: data.name,
          language,
          flag: FLAG_MAP[language],
        });
      });
  }, []);

  const loadBadges = useCallback(async (userId: string) => {
    const [{ data: badgeData }, unviewed] = await Promise.all([
      supabase
        .from("user_badges")
        .select("*")
        .eq("user_id", userId)
        .order("category")
        .order("threshold"),
      getUnviewedBadgeCountByModule(supabase, userId),
    ]);
    if (badgeData) setBadges(badgeData);
    setUnviewedByModule(unviewed);
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.language !== "JP") return;
    loadBadges(currentUser.id);
  }, [currentUser, loadBadges]);

  const activeTabDef = MODULE_TABS.find((t) => t.id === activeModuleTab) ?? MODULE_TABS[0];

  useEffect(() => {
    if (!currentUser || currentUser.language !== "JP") return;
    const markViewed = async () => {
      for (const mod of activeTabDef.modules) {
        await markModuleBadgesAsViewed(supabase, currentUser.id, mod);
      }
      const unviewed = await getUnviewedBadgeCountByModule(supabase, currentUser.id);
      setUnviewedByModule(unviewed);
      setBadges((prev) =>
        prev.map((b) =>
          activeTabDef.modules.includes(b.module as BadgeModule)
            ? { ...b, viewed_at: b.viewed_at ?? new Date().toISOString() }
            : b
        )
      );
    };
    markViewed();
  }, [activeModuleTab, currentUser, activeTabDef.modules]);

  const filteredBadges = useMemo(
    () =>
      badges.filter((b) =>
        activeTabDef.modules.includes(b.module as BadgeModule)
      ),
    [badges, activeTabDef.modules]
  );

  const badgesByCategory = useMemo(() => {
    const map = new Map<string, UserBadge[]>();
    for (const b of filteredBadges) {
      if (!map.has(b.category)) map.set(b.category, []);
      map.get(b.category)!.push(b);
    }
    for (const [, arr] of map) {
      arr.sort((a, b) => a.threshold - b.threshold);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredBadges]);

  const weekBuckets = useMemo(() => buildLast12Weeks(), []);

  const weeklyNewCounts = useMemo(() => {
    const counts = new Map(weekBuckets.map((w) => [w.key, 0]));
    for (const b of badges) {
      const key = weekKey(new Date(b.earned_at));
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return weekBuckets.map((w) => ({
      week: w.label,
      count: counts.get(w.key) ?? 0,
    }));
  }, [badges, weekBuckets]);

  const cumulativeCounts = useMemo(() => {
    let running = 0;
    return weekBuckets.map((w) => {
      const added = badges.filter(
        (b) => weekKey(new Date(b.earned_at)) === w.key
      ).length;
      running += added;
      return { week: w.label, total: running };
    });
  }, [badges, weekBuckets]);

  const moduleBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const mod of BADGE_MODULES) counts[mod] = 0;
    for (const b of badges) {
      counts[b.module] = (counts[b.module] ?? 0) + 1;
    }
    return MODULE_TABS.map((tab) => ({
      name: tab.label,
      count: tab.modules.reduce((sum, m) => sum + (counts[m] ?? 0), 0),
    }));
  }, [badges]);

  const thisWeekStart = startOfWeek(new Date());
  const newThisWeek = badges.filter(
    (b) => new Date(b.earned_at) >= thisWeekStart
  );
  const streak = badgeEarnStreakDays(badges);
  const totalBadges = badges.length;
  const avgPerWeek =
    weekBuckets.length > 0
      ? (totalBadges / weekBuckets.length).toFixed(1)
      : "0";

  const tabUnviewed = (tab: AchievementModuleTab) =>
    tab.modules.reduce((sum, m) => sum + (unviewedByModule[m] ?? 0), 0);

  const handleBadgeClick = useCallback(async (badge: UserBadge) => {
    const wasUnviewed = !badge.viewed_at;
    setDetailShowNew(wasUnviewed);
    setSelectedBadge(badge);

    if (wasUnviewed) {
      await markBadgeAsViewed(supabase, badge.id);
      const viewedAt = new Date().toISOString();
      setBadges((prev) =>
        prev.map((b) => (b.id === badge.id ? { ...b, viewed_at: viewedAt } : b))
      );
      setUnviewedByModule((prev) => ({
        ...prev,
        [badge.module]: Math.max(0, (prev[badge.module] ?? 0) - 1),
      }));
    }
  }, []);

  const closeBadgeDetail = useCallback(() => {
    setSelectedBadge(null);
    setDetailShowNew(false);
  }, []);

  if (!currentUser) {
    return (
      <main
        style={{
          padding: "2rem",
          maxWidth: "480px",
          margin: "0 auto",
          background: "white",
          minHeight: "100vh",
          color: "#111",
        }}
      >
        <p style={{ color: "#666" }}>
          Please select a user from <Link href="/">Home</Link>.
        </p>
      </main>
    );
  }

  if (currentUser.language !== "JP") {
    return (
      <main
        style={{
          padding: "2rem",
          maxWidth: "480px",
          margin: "0 auto",
          background: "white",
          minHeight: "100vh",
          color: "#111",
        }}
      >
        <p style={{ color: "#666" }}>Achievements are available for Japanese learners only.</p>
        <Link href="/" style={{ color: "#388E3C" }}>
          ← Home
        </Link>
      </main>
    );
  }

  return (
    <main
      style={{
        padding: subTab === "timeline" ? "0.75rem 0.5rem 5rem" : "1rem 0.75rem 5rem",
        maxWidth: subTab === "timeline" ? "100%" : "600px",
        margin: "0 auto",
        background: "white",
        minHeight: "100vh",
        color: "#111",
      }}
    >
      <h1 style={{ fontSize: "22px", margin: "0 0 4px" }}>Achievement</h1>
      <p style={{ fontSize: "14px", color: "#666", margin: "0 0 1rem" }}>
        {totalBadges} badges collected
      </p>

      <div style={{ display: "flex", gap: "8px", marginBottom: "1rem" }}>
        {(
          [
            { id: "badges" as SubTab, label: "🏆 Badges" },
            { id: "timeline" as SubTab, label: "📊 Timeline" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: "10px",
              border: subTab === t.id ? "2px solid #388E3C" : "1px solid #ccc",
              background: subTab === t.id ? "#e8f5e9" : "white",
              cursor: "pointer",
              fontWeight: subTab === t.id ? 700 : 400,
              fontSize: "13px",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "badges" && (
        <>
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              marginBottom: "1rem",
            }}
          >
            {MODULE_TABS.map((tab) => {
              const unviewed = tabUnviewed(tab);
              const active = activeModuleTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveModuleTab(tab.id)}
                  style={{
                    position: "relative",
                    padding: "6px 12px",
                    borderRadius: "16px",
                    border: active ? "2px solid #388E3C" : "1px solid #ccc",
                    background: active ? "#e8f5e9" : "white",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {tab.label}
                  {unviewed > 0 && (
                    <span
                      style={{
                        position: "absolute",
                        top: "-4px",
                        right: "-4px",
                        minWidth: "14px",
                        height: "14px",
                        borderRadius: "7px",
                        background: "#e53935",
                        color: "#fff",
                        fontSize: "8px",
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "0 3px",
                      }}
                    >
                      {unviewed}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {badgesByCategory.length === 0 ? (
            <p style={{ color: "#999", fontSize: "14px" }}>
              No badges in this module yet. Keep learning!
            </p>
          ) : (
            badgesByCategory.map(([category, items]) => (
              <section key={category} style={{ marginBottom: "1.25rem" }}>
                <h2 style={{ fontSize: "14px", margin: "0 0 8px" }}>{category}</h2>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "12px",
                  }}
                >
                  {items.map((b) => {
                    const isNew = !b.viewed_at;
                    const emoji = getBadgeEmoji(b.category, b.threshold);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => handleBadgeClick(b)}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          width: "48px",
                          padding: 0,
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                        }}
                      >
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: "50%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "20px",
                            background: isNew ? "#fff8e1" : "#f5f5f5",
                            border: isNew
                              ? "2px solid #ffb300"
                              : "1px solid #e0e0e0",
                            boxShadow: isNew
                              ? "0 0 12px rgba(255, 179, 0, 0.55)"
                              : "none",
                          }}
                        >
                          {emoji}
                        </div>
                        {isNew && (
                          <span
                            style={{
                              fontSize: "8px",
                              fontWeight: 700,
                              color: "#f57c00",
                              marginTop: "2px",
                            }}
                          >
                            NEW
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: "10px",
                            color: "#666",
                            marginTop: "4px",
                          }}
                        >
                          {b.threshold}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))
          )}
        </>
      )}

      {subTab === "timeline" && (
        <>
          <div style={{ display: "flex", gap: "8px", marginBottom: "0.5rem" }}>
            {(
              [
                { id: "new" as TimelineView, label: "New Badges" },
                { id: "total" as TimelineView, label: "Total Badges" },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setTimelineView(v.id)}
                style={{
                  flex: 1,
                  padding: "8px",
                  borderRadius: "8px",
                  border:
                    timelineView === v.id ? "2px solid #388E3C" : "1px solid #ccc",
                  background: timelineView === v.id ? "#e8f5e9" : "white",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: timelineView === v.id ? 700 : 400,
                }}
              >
                {v.label}
              </button>
            ))}
          </div>

          {timelineView === "new" && (
            <>
              <div
                style={{
                  background: "#f9f9f9",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  marginBottom: "8px",
                  fontSize: "12px",
                  display: "flex",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <span>
                  This week: <strong>{newThisWeek.length}</strong> new
                </span>
                <span>
                  Streak: <strong>{streak}</strong> days 🔥
                </span>
              </div>
              <div style={{ width: "100%", height: TIMELINE_CHART_HEIGHT, marginBottom: "0.75rem" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weeklyNewCounts} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#66BB6A" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <h3 style={{ fontSize: "12px", margin: "0 0 6px" }}>
                Earned this week
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {newThisWeek.length === 0 ? (
                  <p style={{ color: "#999", fontSize: "13px" }}>None yet this week.</p>
                ) : (
                  newThisWeek.map((b) => (
                    <div
                      key={b.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "8px",
                        borderRadius: "8px",
                        background: !b.viewed_at ? "#fff8e1" : "#f9f9f9",
                        border: !b.viewed_at
                          ? "1px solid #ffe082"
                          : "1px solid #eee",
                      }}
                    >
                      <span style={{ fontSize: "24px" }}>
                        {getBadgeEmoji(b.category, b.threshold)}
                      </span>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 600 }}>
                          {b.category} · {b.threshold} words
                        </div>
                        <div style={{ fontSize: "11px", color: "#999" }}>
                          {new Date(b.earned_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}

          {timelineView === "total" && (
            <>
              <div
                style={{
                  background: "#f9f9f9",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  marginBottom: "8px",
                  fontSize: "12px",
                }}
              >
                All time: <strong>{totalBadges}</strong> total
                <span style={{ margin: "0 8px", color: "#ccc" }}>·</span>
                Avg/week: <strong>{avgPerWeek}</strong>
              </div>
              <div style={{ width: "100%", height: TIMELINE_CHART_HEIGHT, marginBottom: "0.75rem" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cumulativeCounts} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                    <Tooltip />
                    <Line
                      type="monotone"
                      dataKey="total"
                      stroke="#388E3C"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <h3 style={{ fontSize: "12px", margin: "0 0 6px" }}>By module</h3>
              <div style={{ width: "100%", height: MODULE_BAR_CHART_HEIGHT }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={moduleBreakdown}
                    layout="vertical"
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={88}
                      tick={{ fontSize: 12 }}
                    />
                    <Tooltip />
                    <Bar dataKey="count" fill="#81C784" radius={[0, 4, 4, 0]} barSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </>
      )}

      <BadgeDetailModal
        open={selectedBadge !== null}
        badge={selectedBadge}
        moduleLabel={selectedBadge ? getModuleDisplayLabel(selectedBadge.module) : ""}
        showNew={detailShowNew}
        onClose={closeBadgeDetail}
      />
    </main>
  );
}

"use client";

/**
 * Step C5: Achievement "Talking" tab — 3rd tab alongside Badges/Timeline.
 * Shows conversation can-do progress by Stage (1-5; Stage 3-5 are shown as
 * empty/locked shells since their can-dos aren't defined yet — see
 * conversation-candos.ts's STAGE_INFO doc comment) plus cumulative stats.
 *
 * Data comes from GET /api/conversation/progress, which reuses
 * computeTurnsAnsweredAloneStats() for the "on your own" stat — no judgment
 * logic is duplicated here.
 *
 * No unread/"NEW" marking here (unlike Achievement Badges) — see the
 * instructions this was built from: the review screen already shows
 * "You can do this now" right after a can-do is achieved, so an unread
 * concept wouldn't add anything.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { TOPIC_LABELS } from "@/app/lib/conversation-candos";

type CandoProgress = {
  candoId: string;
  en: string;
  example: string;
  topic: string;
  consecutiveSuccess: number;
  achieved: boolean;
};

type TopicProgress = {
  topic: string;
  achieved: number;
  total: number;
};

type StageProgress = {
  stage: number;
  name: string;
  description: string;
  achieved: number;
  total: number;
  unlocked: boolean;
  topics: TopicProgress[];
  candos: CandoProgress[];
};

type ConversationProgress = {
  currentStage: number;
  totalAchieved: number;
  stages: StageProgress[];
  totals: {
    conversations: number;
    turnsAnsweredAlone: number;
    turnsTotal: number;
    speakingMs: number;
  };
};

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60000)} min`;
}

function progressDots(consecutiveSuccess: number): string {
  const filled = Math.min(3, consecutiveSuccess);
  return "●".repeat(filled) + "○".repeat(Math.max(0, 3 - filled));
}

function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic;
}

export function TalkingTab({ userId, language }: { userId: string; language: string }) {
  const [progress, setProgress] = useState<ConversationProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Deferred to a microtask (same pattern used elsewhere in this app,
    // e.g. app/conversation/page.tsx) — this effect reacts to userId/
    // language becoming available, not deriving render state, but the
    // set-state-in-effect lint rule can't tell the two apart from a plain
    // synchronous setState call at the top of the effect body.
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      fetch(`/api/conversation/progress?userId=${userId}&language=${language}`)
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to load progress");
          if (!cancelled) setProgress(data as ConversationProgress);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, language]);

  if (loading) {
    return <p style={{ color: "#999", fontSize: "14px" }}>Loading...</p>;
  }

  if (error || !progress) {
    return <p style={{ color: "#c00", fontSize: "14px" }}>⚠️ {error ?? "Failed to load"}</p>;
  }

  // Empty state: no conversations at all yet.
  if (progress.totals.conversations === 0) {
    return (
      <div>
        <h2 style={{ fontSize: "18px", margin: "0 0 4px" }}>Things I can say</h2>
        <p style={{ fontSize: "13px", color: "#666", margin: "0 0 16px" }}>0 unlocked so far</p>
        <StageRow stage={progress.stages[0]} isNextLocked={false} onOpen={() => {}} />
        <p style={{ fontSize: "14px", color: "#666", margin: "16px 0" }}>
          Start a conversation to begin.
        </p>
        <Link
          href="/conversation"
          style={{
            display: "inline-block",
            padding: "12px 20px",
            borderRadius: "10px",
            background: "#ff8c42",
            color: "white",
            textDecoration: "none",
            fontSize: "14px",
            fontWeight: 700,
          }}
        >
          Talk to your tutor
        </Link>
      </div>
    );
  }

  const detail = selectedStage != null ? progress.stages.find((s) => s.stage === selectedStage) : null;

  if (detail) {
    const byTopic = new Map<string, CandoProgress[]>();
    for (const c of detail.candos) {
      if (!byTopic.has(c.topic)) byTopic.set(c.topic, []);
      byTopic.get(c.topic)!.push(c);
    }

    return (
      <div>
        <button
          type="button"
          onClick={() => setSelectedStage(null)}
          style={{ background: "none", border: "none", color: "#888", fontSize: "13px", padding: 0, marginBottom: 12, cursor: "pointer" }}
        >
          ← Back
        </button>
        <h2 style={{ fontSize: "18px", margin: "0 0 2px" }}>
          Stage {detail.stage} · {detail.name}
        </h2>
        <p style={{ fontSize: "13px", color: "#888", margin: "0 0 16px" }}>{detail.description}</p>

        {byTopic.size === 0 && (
          <p style={{ color: "#999", fontSize: "14px" }}>No can-dos defined for this stage yet.</p>
        )}

        {Array.from(byTopic.entries()).map(([topic, candos]) => (
          <section key={topic} style={{ marginBottom: "1.25rem" }}>
            <h3 style={{ fontSize: "12px", letterSpacing: 1, color: "#999", margin: "0 0 8px", textTransform: "uppercase" }}>
              {topicLabel(topic)}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {candos.map((c) => (
                <div
                  key={c.candoId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: "10px",
                    background: c.achieved ? "#e8f5e9" : "#fafafa",
                    border: c.achieved ? "1px solid #a5d6a7" : "1px solid #eee",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "14px", color: "#333" }}>
                      {c.achieved && <span style={{ color: "#4caf50", marginRight: 4 }}>✓</span>}
                      {c.en}
                    </div>
                    <div style={{ fontSize: "12px", color: "#999", marginTop: 2 }}>{c.example}</div>
                  </div>
                  {!c.achieved && (
                    <span style={{ color: "#4caf50", letterSpacing: 2, fontSize: "13px", flexShrink: 0, marginLeft: 8 }}>
                      {progressDots(c.consecutiveSuccess)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }

  const nextLockedStage = progress.stages.find((s) => !s.unlocked && s.total > 0);
  const onYourOwnPct =
    progress.totals.turnsTotal > 0
      ? Math.round((progress.totals.turnsAnsweredAlone / progress.totals.turnsTotal) * 100)
      : 0;

  return (
    <div>
      <h2 style={{ fontSize: "18px", margin: "0 0 4px" }}>Things I can say</h2>
      <p style={{ fontSize: "13px", color: "#666", margin: "0 0 16px" }}>
        {progress.totalAchieved} unlocked so far
      </p>

      {progress.stages.map((stage) => (
        <StageRow
          key={stage.stage}
          stage={stage}
          isNextLocked={nextLockedStage?.stage === stage.stage}
          onOpen={() => stage.unlocked && setSelectedStage(stage.stage)}
        />
      ))}

      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "8px",
          flexWrap: "wrap",
          fontSize: "13px",
          color: "#666",
          marginTop: "20px",
          textAlign: "center",
        }}
      >
        <span>{progress.totals.conversations} conversations</span>
        <span style={{ color: "#ccc" }}>·</span>
        <span>{onYourOwnPct}% on your own</span>
        <span style={{ color: "#ccc" }}>·</span>
        <span>{formatMinutes(progress.totals.speakingMs)} spoken</span>
      </div>
    </div>
  );
}

function StageRow({
  stage,
  isNextLocked,
  onOpen,
}: {
  stage: StageProgress;
  isNextLocked: boolean;
  onOpen: () => void;
}) {
  const complete = stage.unlocked && stage.total > 0 && stage.achieved >= stage.total;

  if (!stage.unlocked) {
    return (
      <div
        style={{
          padding: "14px 16px",
          borderRadius: "12px",
          background: "#fafafa",
          border: "1px solid #eee",
          marginBottom: "10px",
          opacity: isNextLocked ? 1 : 0.6,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "#999" }}>
            Stage {stage.stage} · {stage.name}
          </span>
          <span style={{ fontSize: "14px" }}>🔒</span>
        </div>
        {isNextLocked && (
          <div style={{ fontSize: "12px", color: "#aaa", marginTop: 4 }}>
            Finish Stage {stage.stage - 1} to unlock · {stage.total} more
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "14px 16px",
        borderRadius: "12px",
        background: complete ? "#e8f5e9" : "white",
        border: complete ? "1px solid #a5d6a7" : "1px solid #eee",
        marginBottom: "10px",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "14px", fontWeight: 600, color: "#333" }}>
          Stage {stage.stage} · {stage.name}
        </span>
        <span style={{ fontSize: "13px", color: complete ? "#4caf50" : "#888" }}>
          {stage.achieved} / {stage.total}
        </span>
      </div>
      <div
        style={{
          height: "6px",
          borderRadius: "3px",
          background: "#eee",
          marginTop: "8px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: stage.total > 0 ? `${Math.min(100, (stage.achieved / stage.total) * 100)}%` : "0%",
            background: complete ? "#4caf50" : "#ff8c42",
          }}
        />
      </div>
      {complete ? (
        <div style={{ fontSize: "12px", color: "#4caf50", fontWeight: 700, marginTop: 6 }}>✓ Complete</div>
      ) : (
        stage.topics.length > 0 && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: 8 }}>
            {stage.topics.map((t) => (
              <span
                key={t.topic}
                style={{
                  fontSize: "11px",
                  color: "#888",
                  background: "#f5f5f5",
                  borderRadius: "10px",
                  padding: "2px 8px",
                }}
              >
                {topicLabel(t.topic)} {t.achieved}/{t.total}
              </span>
            ))}
          </div>
        )
      )}
    </button>
  );
}

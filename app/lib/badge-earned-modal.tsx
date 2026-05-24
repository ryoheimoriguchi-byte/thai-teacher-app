"use client";

import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { getBadgeEmoji } from "@/app/lib/badges";

export type BadgeEarnedModalProps = {
  open: boolean;
  badge: {
    module: string;
    category: string;
    threshold: number;
  } | null;
  onClose: () => void;
};

function fireBadgeConfetti() {
  const colors = ["#388E3C", "#66BB6A", "#A5D6A7", "#ffffff"];
  confetti({
    particleCount: 28,
    spread: 55,
    origin: { x: 0.5, y: 0.5 },
    colors,
  });
  confetti({
    particleCount: 2,
    angle: 60,
    spread: 40,
    origin: { x: 0, y: 0.65 },
    colors,
  });
  confetti({
    particleCount: 2,
    angle: 120,
    spread: 40,
    origin: { x: 1, y: 0.65 },
    colors,
  });
}

export function BadgeEarnedModal({ open, badge, onClose }: BadgeEarnedModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    fireBadgeConfetti();
    const t = window.setTimeout(() => setVisible(true), 16);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open || !badge) return null;

  const emoji = getBadgeEmoji(badge.category, badge.threshold);
  const tier = badge.threshold / 10;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="badge-earned-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
        }}
        aria-hidden
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "280px",
          padding: "1.5rem 1.25rem",
          borderRadius: "16px",
          background: "#fff",
          color: "#111",
          textAlign: "center",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.2)",
          border: "2px solid #A5D6A7",
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.94)",
          transition: "opacity 0.4s ease, transform 0.4s ease",
        }}
      >
        <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", letterSpacing: "0.2em", color: "#9e9e9e" }}>
          ✨ ⭐
        </p>
        <p
          style={{
            fontSize: "3.5rem",
            margin: "0 0 0.75rem",
            lineHeight: 1,
            filter: "drop-shadow(0 0 12px rgba(56, 142, 60, 0.45))",
          }}
          aria-hidden
        >
          {emoji}
        </p>
        <p
          id="badge-earned-title"
          style={{
            fontSize: "0.7rem",
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: "#9e9e9e",
            margin: "0 0 0.35rem",
            textTransform: "uppercase",
          }}
        >
          NEW BADGE
        </p>
        <p style={{ fontSize: "1.15rem", fontWeight: 700, color: "#388E3C", margin: "0 0 0.25rem" }}>
          {badge.category} Lv.{tier}
        </p>
        <p style={{ fontSize: "0.9rem", color: "#666", margin: "0 0 1.25rem" }}>
          {badge.threshold} words mastered!
        </p>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            padding: "12px 16px",
            fontSize: "1rem",
            fontWeight: 700,
            border: "none",
            borderRadius: "10px",
            background: "#388E3C",
            color: "#fff",
            cursor: "pointer",
            boxShadow: "0 3px 10px rgba(56, 142, 60, 0.35)",
          }}
        >
          Awesome! 🎉
        </button>
      </div>
    </div>
  );
}

export type BadgeDetailModalProps = {
  open: boolean;
  badge: {
    module: string;
    category: string;
    threshold: number;
    earned_at: string;
  } | null;
  moduleLabel: string;
  showNew: boolean;
  onClose: () => void;
};

function formatBadgeEarnedDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BadgeDetailModal({
  open,
  badge,
  moduleLabel,
  showNew,
  onClose,
}: BadgeDetailModalProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const t = window.setTimeout(() => setVisible(true), 16);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open || !badge) return null;

  const emoji = getBadgeEmoji(badge.category, badge.threshold);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="badge-detail-title"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
        }}
        aria-hidden
        onClick={onClose}
      />
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "300px",
          padding: "1.5rem 1.25rem",
          borderRadius: "16px",
          background: "#fff",
          color: "#111",
          textAlign: "center",
          boxShadow: "0 12px 40px rgba(0, 0, 0, 0.2)",
          border: "2px solid #A5D6A7",
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.94)",
          transition: "opacity 0.4s ease, transform 0.4s ease",
        }}
      >
        <p
          id="badge-detail-title"
          style={{
            fontSize: "0.7rem",
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: "#9e9e9e",
            margin: "0 0 0.75rem",
            textTransform: "uppercase",
          }}
        >
          Badge Detail
        </p>
        <p
          style={{
            fontSize: "4rem",
            margin: "0 0 0.75rem",
            lineHeight: 1,
            filter: "drop-shadow(0 0 16px rgba(56, 142, 60, 0.55))",
          }}
          aria-hidden
        >
          {emoji}
        </p>
        {showNew && (
          <span
            style={{
              display: "inline-block",
              fontSize: "0.65rem",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "#f57c00",
              background: "#fff8e1",
              border: "1px solid #ffb300",
              borderRadius: "999px",
              padding: "2px 10px",
              marginBottom: "0.75rem",
            }}
          >
            NEW
          </span>
        )}
        <p style={{ fontSize: "1.15rem", fontWeight: 700, color: "#388E3C", margin: "0 0 0.35rem" }}>
          {badge.category}
        </p>
        <p style={{ fontSize: "0.95rem", color: "#444", margin: "0 0 0.5rem" }}>
          {badge.threshold} words mastered!
        </p>
        <p style={{ fontSize: "0.85rem", color: "#666", margin: "0 0 0.35rem" }}>
          {moduleLabel}
        </p>
        <p style={{ fontSize: "0.8rem", color: "#999", margin: "0 0 1.25rem" }}>
          Earned {formatBadgeEarnedDate(badge.earned_at)}
        </p>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            padding: "12px 16px",
            fontSize: "1rem",
            fontWeight: 700,
            border: "none",
            borderRadius: "10px",
            background: "#388E3C",
            color: "#fff",
            cursor: "pointer",
            boxShadow: "0 3px 10px rgba(56, 142, 60, 0.35)",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import confetti from "canvas-confetti";

const MODULE_LABELS: Record<string, string> = {
  listening: "Listening",
  sentence: "Sentence",
  "speaking-word": "Speaking",
  "speaking-sentence": "Sentence Speaking",
  reading_word: "Reading",
  reading_character: "Reading",
};

type StageUpCelebrationProps = {
  open: boolean;
  newStage: number;
  moduleName: string;
  masteredCount: number;
  onClose: () => void;
};

function fireConfetti() {
  const colors = ["#FF6B9D", "#C44569", "#6C5CE7", "#ffffff"];
  const duration = 2800;
  const end = Date.now() + duration;

  const frame = () => {
    confetti({
      particleCount: 4,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.6 },
      colors,
    });
    confetti({
      particleCount: 4,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.6 },
      colors,
    });
    confetti({
      particleCount: 6,
      spread: 100,
      origin: { x: 0.5, y: 0.5 },
      colors,
      scalar: 1.1,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  };

  confetti({
    particleCount: 80,
    spread: 70,
    origin: { x: 0.5, y: 0.45 },
    colors,
  });
  frame();
}

export function StageUpCelebration({
  open,
  newStage,
  moduleName,
  masteredCount,
  onClose,
}: StageUpCelebrationProps) {
  const [visible, setVisible] = useState(false);
  const displayModule = MODULE_LABELS[moduleName] ?? moduleName;

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    fireConfetti();
    const t = window.setTimeout(() => setVisible(true), 16);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stage-up-title"
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
          maxWidth: "340px",
          padding: "2rem 1.75rem",
          borderRadius: "20px",
          background: "linear-gradient(135deg, #FF6B9D 0%, #C44569 50%, #6C5CE7 100%)",
          color: "#fff",
          textAlign: "center",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.35)",
          opacity: visible ? 1 : 0,
          transform: visible ? "scale(1)" : "scale(0.92)",
          transition: "opacity 0.45s ease, transform 0.45s ease",
        }}
      >
        <p style={{ fontSize: "3rem", margin: "0 0 0.5rem", lineHeight: 1 }}>🏆</p>
        <p
          id="stage-up-title"
          style={{
            fontSize: "1.75rem",
            fontWeight: 800,
            letterSpacing: "0.06em",
            margin: "0 0 0.25rem",
            textShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          LEVEL UP!
        </p>
        <p style={{ fontSize: "2rem", fontWeight: 700, margin: "0 0 0.75rem" }}>
          Stage {newStage}
        </p>
        <p style={{ fontSize: "1.05rem", margin: "0 0 0.35rem", opacity: 0.95 }}>
          {displayModule} unlocked!
        </p>
        <p style={{ fontSize: "0.95rem", margin: "0 0 1.5rem", opacity: 0.9 }}>
          You mastered {masteredCount} words
        </p>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            padding: "14px 20px",
            fontSize: "1.1rem",
            fontWeight: 700,
            border: "none",
            borderRadius: "12px",
            background: "#fff",
            color: "#6C5CE7",
            cursor: "pointer",
            boxShadow: "0 4px 14px rgba(0,0,0,0.15)",
          }}
        >
          Awesome!
        </button>
      </div>
    </div>
  );
}

"use client";

/**
 * Step C2: Conversation feature — scenario selection + conversation screen.
 *
 * Goal of this step: prove the conversation can run start-to-finish without
 * getting stuck. Visual design and the review/result screen are Step C3.
 *
 * NOT linked from navigation. Reachable only via direct URL (/conversation).
 * Navigation link is Step D.
 *
 * Deliberately NOT shown during the conversation: scores, feedback, praise,
 * remaining time, turn count, progress bars. This is intentional — see the
 * Step C2 instructions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP, FLAG_MAP, AppUser } from "../lib/users";
import { SCENARIOS, ConversationScenario } from "../lib/conversation-scenarios";
import { useRecorder } from "../lib/use-recorder";
import { useAudioPlayer } from "../lib/use-audio-player";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type Phase = "select" | "intro" | "conversation" | "result";

type CurrentTurn = {
  tutorText: string;
  tutorTextEn: string;
};

type HistoryTurn = CurrentTurn & {
  transcript: string;
};

const DURATION_OPTIONS_MIN = [3, 5, 10] as const;

export default function ConversationPage() {
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [debugEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("debug") === "1";
  });

  useEffect(() => {
    const userId = localStorage.getItem("currentUserId");
    if (userId) {
      const fetchUser = async () => {
        const { data } = await supabase.from("users").select("*").eq("id", userId).single();
        if (data) {
          const language = LANGUAGE_MAP[data.id] ?? "TH";
          setCurrentUser({ id: data.id, name: data.name, language, flag: FLAG_MAP[language] });
        }
      };
      fetchUser();
    }
  }, []);

  /* ---------------- [1] scenario + duration selection ---------------- */
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [selectedDurationMin, setSelectedDurationMin] = useState<number | null>(null);
  const selectedScenario: ConversationScenario | undefined = SCENARIOS.find(
    (s) => s.id === selectedScenarioId
  );

  const [phase, setPhase] = useState<Phase>("select");
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /* ---------------- session state ---------------- */
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [plannedDurationSec, setPlannedDurationSec] = useState(0);
  const sessionStartedAtRef = useRef<number>(0);

  const [currentTurn, setCurrentTurn] = useState<CurrentTurn | null>(null);
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [showTranslation, setShowTranslation] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const audioPlayer = useAudioPlayer();

  const startSession = useCallback(async () => {
    if (!currentUser || !selectedScenario || !selectedDurationMin) return;
    setBusy(true);
    setBusyMessage("じゅんびしているよ...");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/conversation/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          userId: currentUser.id,
          language: currentUser.language,
          scenarioId: selectedScenario.id,
          plannedDurationSec: selectedDurationMin * 60,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start session");

      setSessionId(data.sessionId);
      setCurrentTurn({ tutorText: data.tutorText, tutorTextEn: data.tutorTextEn });
      setHistory([]);
      setShowTranslation(false);
      setLastTranscript(null);
      setRetryNotice(null);
      setPlannedDurationSec(selectedDurationMin * 60);
      sessionStartedAtRef.current = Date.now();
      setPhase("conversation");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [currentUser, selectedScenario, selectedDurationMin]);

  const endSession = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setBusyMessage("けっかを まとめているよ...");
    try {
      const actualDurationSec = Math.round((Date.now() - sessionStartedAtRef.current) / 1000);
      const res = await fetch("/api/conversation/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", sessionId, actualDurationSec }),
      });
      const data = await res.json();
      setResult(data);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setPhase("result");
    }
  }, [sessionId]);

  const handleCancel = useCallback(() => {
    if (window.confirm("かいわを やめますか？")) {
      endSession();
    }
  }, [endSession]);

  // Broken via a ref to avoid a circular dependency with useRecorder (see
  // handleRecordingComplete below, which needs recorder.reset()).
  const handleRecordingCompleteRef = useRef<
    (blob: Blob, mimeType: string, totalMs: number) => void
  >(() => {});

  const recorder = useRecorder({
    silenceThreshold: 0.006,
    silenceDurationMs: 2500,
    minRecordingMs: 500,
    onRecordingComplete: useCallback((blob: Blob, mimeType: string, totalMs: number) => {
      handleRecordingCompleteRef.current(blob, mimeType, totalMs);
    }, []),
  });

  const handleRecordingComplete = useCallback(
    async (blob: Blob, mimeType: string, totalMs: number) => {
      if (!sessionId || !currentTurn) return;
      setBusy(true);
      setBusyMessage("せんせいが かんがえているよ...");
      setRetryNotice(null);

      try {
        const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
        const formData = new FormData();
        formData.append("audio", blob, `recording.${ext}`);
        formData.append("sessionId", sessionId);

        const transcribeRes = await fetch("/api/conversation/transcribe", {
          method: "POST",
          body: formData,
        });
        const transcribeData = await transcribeRes.json();
        if (!transcribeRes.ok) throw new Error(transcribeData.error || "Transcription failed");

        const transcript = ((transcribeData.transcript as string) ?? "").trim();

        if (!transcript) {
          // Whisper returned nothing (silence / unintelligible). Don't call
          // /turn, don't burn a Claude call. Go straight back to waiting for
          // a new recording; the tutor's line stays exactly as it was.
          setRetryNotice("もういちど はなしてね");
          setBusy(false);
          recorder.reset();
          return;
        }

        setLastTranscript(transcript);

        const elapsedSec = (Date.now() - sessionStartedAtRef.current) / 1000;
        const isClosing = plannedDurationSec - elapsedSec <= 45;

        const turnRes = await fetch("/api/conversation/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            transcript,
            recordingMs: totalMs,
            isClosing,
          }),
        });
        const turnData = await turnRes.json();
        if (!turnRes.ok) throw new Error(turnData.error || "Turn failed");

        setHistory((prev) => [
          ...prev,
          { tutorText: currentTurn.tutorText, tutorTextEn: currentTurn.tutorTextEn, transcript },
        ]);
        setCurrentTurn({ tutorText: turnData.tutorText, tutorTextEn: turnData.tutorTextEn });
        setLastTranscript(null);
        setShowTranslation(false);
        recorder.reset();
        setBusy(false);

        if (turnData.shouldEnd) {
          await endSession();
        }
      } catch (e) {
        setBusy(false);
        setErrorMessage(e instanceof Error ? e.message : String(e));
        recorder.reset();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, currentTurn, plannedDurationSec, endSession]
  );

  useEffect(() => {
    handleRecordingCompleteRef.current = handleRecordingComplete;
  }, [handleRecordingComplete]);

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  if (!currentUser) {
    return (
      <main style={{ padding: "2rem", maxWidth: 480, margin: "0 auto", background: "white", minHeight: "100vh", color: "#111" }}>
        <p style={{ color: "#666" }}>
          Please select a user from <Link href="/">Home</Link>.
        </p>
      </main>
    );
  }

  const containerStyle: React.CSSProperties = {
    maxWidth: 480,
    margin: "0 auto",
    minHeight: "100vh",
    background: "#fff8f0",
    color: "#111",
    display: "flex",
    flexDirection: "column",
  };

  /* ---------------- [1] scenario + duration selection ---------------- */
  if (phase === "select") {
    return (
      <main style={containerStyle}>
        <div style={{ padding: 20 }}>
          <h1 style={{ fontSize: 20, marginBottom: 16 }}>にほんごで はなそう</h1>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedScenarioId(s.id)}
                style={{
                  textAlign: "left",
                  padding: 16,
                  borderRadius: 12,
                  border: selectedScenarioId === s.id ? "3px solid #ff8c42" : "1px solid #ddd",
                  background: selectedScenarioId === s.id ? "#fff3e6" : "white",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 22, fontWeight: "bold" }}>{s.title}</div>
                <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>{s.titleEn}</div>
              </button>
            ))}
          </div>

          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 15, marginBottom: 8, color: "#555" }}>なんぷん はなす？</div>
            <div style={{ display: "flex", gap: 12 }}>
              {DURATION_OPTIONS_MIN.map((min) => (
                <button
                  key={min}
                  onClick={() => setSelectedDurationMin(min)}
                  style={{
                    flex: 1,
                    padding: "14px 0",
                    borderRadius: 12,
                    fontSize: 18,
                    border: selectedDurationMin === min ? "3px solid #ff8c42" : "1px solid #ddd",
                    background: selectedDurationMin === min ? "#fff3e6" : "white",
                    cursor: "pointer",
                  }}
                >
                  {min}ふん
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => selectedScenario && selectedDurationMin && setPhase("intro")}
            disabled={!selectedScenario || !selectedDurationMin}
            style={{
              width: "100%",
              padding: 16,
              fontSize: 18,
              borderRadius: 12,
              border: "none",
              background: selectedScenario && selectedDurationMin ? "#ff8c42" : "#eee",
              color: selectedScenario && selectedDurationMin ? "white" : "#aaa",
              cursor: selectedScenario && selectedDurationMin ? "pointer" : "not-allowed",
            }}
          >
            つぎへ
          </button>
        </div>
      </main>
    );
  }

  /* ---------------- [2] scene intro ---------------- */
  if (phase === "intro" && selectedScenario) {
    return (
      <main style={containerStyle}>
        <div style={{ padding: 20 }}>
          <button
            onClick={() => setPhase("select")}
            style={{ background: "none", border: "none", color: "#888", fontSize: 14, marginBottom: 16, cursor: "pointer", padding: 0 }}
          >
            ← ちがう おはなしにする
          </button>

          <div style={{ fontSize: 24, fontWeight: "bold", marginBottom: 16 }}>{selectedScenario.title}</div>
          <div
            style={{
              fontSize: 20,
              lineHeight: 1.8,
              background: "white",
              borderRadius: 16,
              padding: 24,
              marginBottom: 24,
            }}
          >
            {selectedScenario.intro}
          </div>

          {errorMessage && (
            <div style={{ color: "#c00", marginBottom: 16, fontSize: 14 }}>⚠️ {errorMessage}</div>
          )}

          <button
            onClick={startSession}
            disabled={busy}
            style={{
              width: "100%",
              padding: 16,
              fontSize: 18,
              borderRadius: 12,
              border: "none",
              background: "#ff8c42",
              color: "white",
              cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? busyMessage || "じゅんびしているよ..." : "はじめる"}
          </button>
        </div>
      </main>
    );
  }

  /* ---------------- [4] result ---------------- */
  if (phase === "result") {
    return (
      <main style={containerStyle}>
        <div style={{ padding: 20 }}>
          <div style={{ fontSize: 20, fontWeight: "bold", marginBottom: 16 }}>おつかれさま！</div>
          <pre
            style={{
              background: "#222",
              color: "#eee",
              padding: 16,
              borderRadius: 8,
              fontSize: 12,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              marginBottom: 24,
            }}
          >
            {JSON.stringify(result, null, 2)}
          </pre>
          <Link
            href="/"
            style={{
              display: "block",
              textAlign: "center",
              width: "100%",
              padding: 16,
              fontSize: 18,
              borderRadius: 12,
              background: "#ff8c42",
              color: "white",
              textDecoration: "none",
              boxSizing: "border-box",
            }}
          >
            ホームへもどる
          </Link>
        </div>
      </main>
    );
  }

  /* ---------------- [3] conversation ---------------- */
  const recState = recorder.recState;
  const micDisabled = busy || recState === "stopped";

  const handleMicTap = () => {
    if (recState === "idle") {
      recorder.startRecording();
    } else if (recState === "recording") {
      recorder.stopManually();
    }
  };

  return (
    <main style={containerStyle}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid #eee",
          background: "white",
        }}
      >
        <button
          onClick={handleCancel}
          style={{ background: "none", border: "none", fontSize: 15, color: "#888", cursor: "pointer", padding: 0 }}
        >
          ← やめる
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, padding: 20, display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ fontSize: 56, marginBottom: 8 }}>👩‍🏫</div>

        {currentTurn && (
          <div
            style={{
              width: "100%",
              background: "white",
              borderRadius: 16,
              padding: 20,
              marginBottom: 20,
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 24, lineHeight: 1.6, marginBottom: 12 }}>{currentTurn.tutorText}</div>

            <button
              onClick={() => audioPlayer.play(currentTurn.tutorText)}
              style={{
                background: "none",
                border: "1px solid #ddd",
                borderRadius: 20,
                padding: "6px 14px",
                fontSize: 15,
                cursor: "pointer",
                marginRight: 8,
              }}
            >
              🔊 {audioPlayer.state === "loading" ? "..." : audioPlayer.state === "playing" ? "さいせい中" : "きく"}
            </button>

            <button
              onClick={() => setShowTranslation((v) => !v)}
              style={{
                background: "none",
                border: "none",
                color: "#888",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              えいやくを {showTranslation ? "とじる" : "みる"}
            </button>

            {showTranslation && (
              <div style={{ marginTop: 8, fontSize: 14, color: "#666" }}>{currentTurn.tutorTextEn}</div>
            )}
          </div>
        )}

        {lastTranscript && (
          <div
            style={{
              width: "100%",
              background: "#eef7ee",
              borderRadius: 12,
              padding: 14,
              marginBottom: 16,
              fontSize: 16,
              boxSizing: "border-box",
            }}
          >
            こう きこえたよ: 「{lastTranscript}」
          </div>
        )}

        {retryNotice && (
          <div
            style={{
              width: "100%",
              background: "#fff3e6",
              borderRadius: 12,
              padding: 14,
              marginBottom: 16,
              fontSize: 18,
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            {retryNotice}
          </div>
        )}

        {errorMessage && (
          <div style={{ color: "#c00", marginBottom: 16, fontSize: 14, textAlign: "center" }}>
            ⚠️ {errorMessage}
          </div>
        )}

        {busy ? (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>💭</div>
            <div style={{ fontSize: 16, color: "#666" }}>{busyMessage}</div>
          </div>
        ) : (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button
              onClick={handleMicTap}
              disabled={micDisabled}
              style={{
                width: 100,
                height: 100,
                borderRadius: "50%",
                border: "none",
                background: recState === "recording" ? "#e53935" : "#4caf50",
                color: "white",
                fontSize: 36,
                cursor: micDisabled ? "default" : "pointer",
              }}
            >
              🎤
            </button>
            <div style={{ marginTop: 8, fontSize: 15, color: "#666" }}>
              {recState === "recording" ? "きいているよ..." : "はなしてね"}
            </div>

            {recState === "grace" && (
              <button
                onClick={recorder.continueSpeaking}
                style={{
                  marginTop: 12,
                  padding: "10px 20px",
                  borderRadius: 20,
                  border: "none",
                  background: "#ffb300",
                  color: "white",
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                まだ はなす （{Math.ceil(recorder.graceRemainingMs / 100) / 10}s）
              </button>
            )}

            {recorder.recordingError && (
              <div style={{ marginTop: 12, fontSize: 13, color: "#c00", maxWidth: 320 }}>
                {recorder.recordingError}
              </div>
            )}
          </div>
        )}
      </div>

      {/* History (collapsed) */}
      <div style={{ background: "white", borderTop: "1px solid #eee" }}>
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          style={{
            width: "100%",
            textAlign: "left",
            padding: "12px 16px",
            background: "none",
            border: "none",
            fontSize: 14,
            color: "#888",
            cursor: "pointer",
          }}
        >
          これまでの かいわ {historyOpen ? "▲" : "▼"}
        </button>
        {historyOpen && (
          <div style={{ padding: "0 16px 16px", maxHeight: 240, overflowY: "auto" }}>
            {history.length === 0 ? (
              <div style={{ fontSize: 13, color: "#aaa" }}>(まだ ないよ)</div>
            ) : (
              history.map((h, i) => (
                <div key={i} style={{ marginBottom: 12, fontSize: 14 }}>
                  <div style={{ color: "#555" }}>👩‍🏫 {h.tutorText}</div>
                  <div style={{ color: "#333", marginTop: 2 }}>🧒 {h.transcript}</div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Hidden dev panel: only rendered at all when ?debug=1 is present. */}
      {debugEnabled && (
        <DebugPanel
          silenceThreshold={recorder.silenceThreshold}
          setSilenceThreshold={recorder.setSilenceThreshold}
          silenceDurationMs={recorder.silenceDurationMs}
          setSilenceDurationMs={recorder.setSilenceDurationMs}
          minRecordingMs={recorder.minRecordingMs}
          setMinRecordingMs={recorder.setMinRecordingMs}
          liveRms={recorder.liveRms}
          debugLog={recorder.debugLog}
          actualSettings={recorder.actualSettings}
        />
      )}
    </main>
  );
}

function DebugPanel(props: {
  silenceThreshold: number;
  setSilenceThreshold: (v: number) => void;
  silenceDurationMs: number;
  setSilenceDurationMs: (v: number) => void;
  minRecordingMs: number;
  setMinRecordingMs: (v: number) => void;
  liveRms: number;
  debugLog: string[];
  actualSettings: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: "3px solid #999", background: "#f5f5f5", color: "#111" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "8px 16px",
          background: "none",
          border: "none",
          fontSize: 12,
          color: "#999",
          cursor: "pointer",
        }}
      >
        DEBUG {open ? "▲" : "▼"}
      </button>
      {open && (
        <div style={{ padding: 16, fontSize: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <label>
              Silence threshold (RMS): {props.silenceThreshold.toFixed(3)}
              <input
                type="range"
                min={0.002}
                max={0.15}
                step={0.002}
                value={props.silenceThreshold}
                onChange={(e) => props.setSilenceThreshold(Number(e.target.value))}
                style={{ marginLeft: 8, verticalAlign: "middle" }}
              />
            </label>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>
              Silence duration (ms):{" "}
              <input
                type="number"
                value={props.silenceDurationMs}
                onChange={(e) => props.setSilenceDurationMs(Number(e.target.value))}
                style={{ width: 70 }}
              />
            </label>
            <label style={{ marginLeft: 12 }}>
              Min recording (ms):{" "}
              <input
                type="number"
                value={props.minRecordingMs}
                onChange={(e) => props.setMinRecordingMs(Number(e.target.value))}
                style={{ width: 70 }}
              />
            </label>
          </div>
          <div style={{ marginBottom: 8 }}>liveRms: {props.liveRms.toFixed(4)}</div>
          <div style={{ marginBottom: 8, whiteSpace: "pre-wrap", fontFamily: "monospace", background: "#fff", padding: 8, borderRadius: 4 }}>
            {props.actualSettings}
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", background: "#fff", padding: 8, borderRadius: 4, maxHeight: 200, overflowY: "auto" }}>
            {props.debugLog.length === 0 ? "(no events yet)" : props.debugLog.join("\n")}
          </div>
        </div>
      )}
    </div>
  );
}

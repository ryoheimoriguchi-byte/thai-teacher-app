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
import { FALLBACK_CLOSING_LINE } from "../lib/conversation-prompts";
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
  transcriptKana: string;
  transcriptEn: string | null;
};

const DURATION_OPTIONS_MIN = [3, 5, 10] as const;

// Safety net: if elapsed time overruns the planned duration by this much and
// Claude still hasn't returned shouldEnd:true, force-end the session rather
// than letting the conversation run forever. 180s (rather than a tighter
// value) leaves room for the closing exchange itself (isClosing is sent at
// CLOSING_THRESHOLD_SEC remaining) to actually complete: one round trip
// (record + Whisper + Claude + TTS) can take ~30s, and Claude is told to
// wrap up over 1-2 turns, so ~2 round trips of headroom are needed.
const FORCE_END_OVERRUN_SEC = 180;
// isClosing is sent once remaining time drops below this. 90s (not 45s)
// gives Claude time to actually finish a natural 1-2 turn closing exchange
// before the FORCE_END_OVERRUN_SEC fallback would otherwise kick in.
const CLOSING_THRESHOLD_SEC = 90;
// How long to wait on the final tutor line (either a real should_end:true
// reply, or the fixed fallback closing line) before auto-advancing to the
// result screen, if the user hasn't tapped "Continue" by then.
const PENDING_END_AUTO_ADVANCE_MS = 10000;

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
  // Kana-only (display) version of the last transcript, shown in "You
  // said". The kanji version is only ever used internally (sent to /turn,
  // stored in the DB) — never shown, since Mirei can't read kanji yet.
  // Stays visible (not cleared) until the next recording starts, so the
  // child has time to read it alongside the tutor's next reply.
  const [lastTranscriptKana, setLastTranscriptKana] = useState<string | null>(null);
  const [lastTranscriptEn, setLastTranscriptEn] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Set only when a turn failed AFTER we already have a transcript (i.e. the
  // /turn call itself failed, not /transcribe). Distinct from errorMessage
  // so we can show explicit recovery actions instead of a bare error line.
  const [turnError, setTurnError] = useState<string | null>(null);

  // ?debug=1 panel: elapsed time / isClosing bookkeeping, so this can be
  // verified on a real device without guessing.
  const [timingLog, setTimingLog] = useState<string[]>([]);
  const addTimingLog = useCallback((msg: string) => {
    const t = new Date().toISOString().split("T")[1].replace("Z", "");
    setTimingLog((prev) => [...prev.slice(-29), `${t} ${msg}`]);
  }, []);
  const [elapsedDisplaySec, setElapsedDisplaySec] = useState(0); // updated every second for the debug panel; safe to read during render (state, not a ref/Date.now() call)

  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  // "Pending end": the tutor's final line (either a real should_end:true
  // reply, or the fixed FALLBACK_CLOSING_LINE when we force-end) is shown,
  // Listen is pressable, and the user can either tap Continue or wait — the
  // screen never jumps straight to the result screen in silence.
  const [pendingEnd, setPendingEnd] = useState(false);
  const pendingEndTimeoutRef = useRef<number | null>(null);

  const audioPlayer = useAudioPlayer();

  const startSession = useCallback(async () => {
    if (!currentUser || !selectedScenario || !selectedDurationMin) return;
    setBusy(true);
    setBusyMessage("Getting ready...");
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
      setLastTranscriptKana(null);
      setLastTranscriptEn(null);
      setRetryNotice(null);
      setPlannedDurationSec(selectedDurationMin * 60);
      sessionStartedAtRef.current = Date.now();
      setElapsedDisplaySec(0);
      setTimingLog([]);
      setPendingEnd(false);
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
    setBusyMessage("Wrapping up...");
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
    if (window.confirm("Quit this conversation?")) {
      endSession();
    }
  }, [endSession]);

  const enterPendingEnd = useCallback(
    (overrideTurn?: { tutorText: string; tutorTextEn: string }) => {
      if (overrideTurn) setCurrentTurn(overrideTurn);
      setPendingEnd(true);
      setBusy(false);
      if (pendingEndTimeoutRef.current) window.clearTimeout(pendingEndTimeoutRef.current);
      pendingEndTimeoutRef.current = window.setTimeout(() => {
        endSession();
      }, PENDING_END_AUTO_ADVANCE_MS);
    },
    [endSession]
  );

  const handleContinueToResult = useCallback(() => {
    if (pendingEndTimeoutRef.current) {
      window.clearTimeout(pendingEndTimeoutRef.current);
      pendingEndTimeoutRef.current = null;
    }
    endSession();
  }, [endSession]);

  useEffect(() => {
    return () => {
      if (pendingEndTimeoutRef.current) window.clearTimeout(pendingEndTimeoutRef.current);
    };
  }, []);

  // Live ticking clock for the debug panel + the force-end safety net below.
  // Reads sessionStartedAtRef inside the interval callback (an event handler,
  // not render), which is a safe place to access refs / call Date.now().
  useEffect(() => {
    if (phase !== "conversation") return;
    const interval = window.setInterval(() => {
      setElapsedDisplaySec((Date.now() - sessionStartedAtRef.current) / 1000);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [phase]);

  // Safety net: even if the user stops interacting (no more recordings) once
  // time is way overrun, force-end rather than leaving the session open
  // forever. Only fires when idle/not busy so it never interrupts an
  // in-flight turn.
  useEffect(() => {
    if (phase !== "conversation" || busy || pendingEnd || !sessionId || !plannedDurationSec) return;
    if (elapsedDisplaySec > plannedDurationSec + FORCE_END_OVERRUN_SEC) {
      // Deferred to a microtask: this effect is a watchdog reacting to time
      // passing (an external signal), not deriving render state, but the
      // lint rule can't tell the two apart — defer so it isn't a plain
      // synchronous setState-in-effect call.
      queueMicrotask(() => {
        addTimingLog(
          `force-end (idle watchdog): elapsed=${elapsedDisplaySec.toFixed(0)}s > planned(${plannedDurationSec}s)+${FORCE_END_OVERRUN_SEC}s`
        );
        enterPendingEnd({ tutorText: FALLBACK_CLOSING_LINE.ja, tutorTextEn: FALLBACK_CLOSING_LINE.en });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsedDisplaySec, phase, busy, pendingEnd, sessionId, plannedDurationSec]);

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

      // Safety net: if we're already way past the planned end time, don't
      // bother transcribing/sending this turn at all — show the fixed
      // closing line (not Claude — we're deliberately skipping that call)
      // and let the user listen to it before ending.
      const elapsedAtStartSec = (Date.now() - sessionStartedAtRef.current) / 1000;
      if (elapsedAtStartSec > plannedDurationSec + FORCE_END_OVERRUN_SEC) {
        addTimingLog(
          `force-end: elapsed=${elapsedAtStartSec.toFixed(0)}s > planned(${plannedDurationSec}s)+${FORCE_END_OVERRUN_SEC}s`
        );
        recorder.reset();
        enterPendingEnd({ tutorText: FALLBACK_CLOSING_LINE.ja, tutorTextEn: FALLBACK_CLOSING_LINE.en });
        return;
      }

      setBusy(true);
      setBusyMessage("Listening...");
      setRetryNotice(null);
      setTurnError(null);
      setErrorMessage(null);

      let transcript: string; // kanji-mixed, as returned by Whisper — internal use only (DB / scoring)
      let transcriptKana: string; // hiragana-only — display only
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

        transcript = ((transcribeData.transcript as string) ?? "").trim();
        transcriptKana = ((transcribeData.transcriptKana as string) ?? transcript).trim();
        if (typeof transcribeData.kanaConversionMs === "number") {
          addTimingLog(`kana conversion: ${transcribeData.kanaConversionMs}ms`);
        }
      } catch (e) {
        // Nothing was persisted server-side for this attempt (transcribe
        // doesn't write to the DB) — a plain retry via the mic button is safe.
        setBusy(false);
        setErrorMessage(e instanceof Error ? e.message : String(e));
        recorder.reset();
        return;
      }

      if (!transcript) {
        // Whisper returned nothing (silence / unintelligible). Don't call
        // /turn, don't burn a Claude call. Go straight back to waiting for
        // a new recording; the tutor's line stays exactly as it was.
        setRetryNotice("Didn't catch that — please try again");
        setBusy(false);
        recorder.reset();
        return;
      }

      setLastTranscriptKana(transcriptKana);
      setBusyMessage("The teacher is thinking...");

      const elapsedSec = (Date.now() - sessionStartedAtRef.current) / 1000;
      const isClosing = plannedDurationSec - elapsedSec <= CLOSING_THRESHOLD_SEC;
      addTimingLog(
        `turn: elapsed=${elapsedSec.toFixed(0)}s / planned=${plannedDurationSec}s / isClosing=${isClosing}`
      );

      try {
        const turnRes = await fetch("/api/conversation/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            transcript,
            // Math.round defensively, even though use-recorder.ts already
            // rounds — recording_ms/speaking_ms are `integer` DB columns and
            // a stray float here breaks the DB write.
            recordingMs: Math.round(totalMs),
            isClosing,
          }),
        });
        const turnData = await turnRes.json();
        if (!turnRes.ok) throw new Error(turnData.error || "Turn failed");

        setHistory((prev) => [
          ...prev,
          {
            tutorText: currentTurn.tutorText,
            tutorTextEn: currentTurn.tutorTextEn,
            transcript,
            transcriptKana,
            transcriptEn: (turnData.transcriptEn as string | null) ?? null,
          },
        ]);
        setCurrentTurn({ tutorText: turnData.tutorText, tutorTextEn: turnData.tutorTextEn });
        // Deliberately NOT clearing lastTranscriptKana/lastTranscriptEn here —
        // "You said" stays visible (with its English translation, now
        // available) until the next recording starts, so the child can read
        // it alongside the tutor's new reply rather than having it vanish
        // the instant a response arrives.
        setLastTranscriptEn((turnData.transcriptEn as string | null) ?? null);
        setShowTranslation(false);
        recorder.reset();
        setBusy(false);

        const elapsedAfterSec = (Date.now() - sessionStartedAtRef.current) / 1000;
        if (turnData.shouldEnd) {
          // Claude ended it naturally — its own reply (already set as
          // currentTurn above) IS the closing line. Let the user listen to
          // it / read it before moving on, rather than jumping straight to
          // the result screen.
          addTimingLog(`shouldEnd:true received at elapsed=${elapsedAfterSec.toFixed(0)}s -> pending end`);
          enterPendingEnd();
        } else if (elapsedAfterSec > plannedDurationSec + FORCE_END_OVERRUN_SEC) {
          // Overrun despite Claude not ending it — override the display with
          // the fixed closing line instead of Claude's (non-closing) reply.
          addTimingLog(
            `force-end: elapsed=${elapsedAfterSec.toFixed(0)}s > planned(${plannedDurationSec}s)+${FORCE_END_OVERRUN_SEC}s (shouldEnd never received)`
          );
          enterPendingEnd({ tutorText: FALLBACK_CLOSING_LINE.ja, tutorTextEn: FALLBACK_CLOSING_LINE.en });
        }
      } catch (e) {
        // The transcript IS already known to us here, but per the server fix
        // it was NOT yet written to the DB (the write is deferred until
        // Claude succeeds) — so the "open turn" for this session is still
        // valid, and a plain retry (record again) will work correctly.
        // We still show explicit recovery actions since it's not obvious
        // to a child what to do next when this happens.
        setBusy(false);
        setTurnError(e instanceof Error ? e.message : String(e));
        recorder.reset();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, currentTurn, plannedDurationSec, endSession, enterPendingEnd, addTimingLog]
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
          <h1 style={{ fontSize: 20, marginBottom: 16 }}>Let&apos;s talk in Japanese</h1>

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
            <div style={{ fontSize: 15, marginBottom: 8, color: "#555" }}>How many minutes?</div>
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
                  {min} min
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
            Next
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
            ← Choose a different topic
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
            {busy ? busyMessage || "Getting ready..." : "Start"}
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
          <div style={{ fontSize: 20, fontWeight: "bold", marginBottom: 16 }}>Nice work!</div>
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
            Return home
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
      setLastTranscriptKana(null);
      setLastTranscriptEn(null);
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
          ← Quit
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
              🔊 {audioPlayer.state === "loading" ? "..." : audioPlayer.state === "playing" ? "Playing" : "Listen"}
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
              {showTranslation ? "Hide English" : "Show English"}
            </button>

            {showTranslation && (
              <div style={{ marginTop: 8, fontSize: 14, color: "#666" }}>{currentTurn.tutorTextEn}</div>
            )}
          </div>
        )}

        {lastTranscriptKana && (
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
            <div>You said: 「{lastTranscriptKana}」</div>
            {lastTranscriptEn && (
              <div style={{ marginTop: 4, fontSize: 13, color: "#8a9a8a" }}>{lastTranscriptEn}</div>
            )}
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

        {errorMessage && !turnError && (
          <div style={{ color: "#c00", marginBottom: 16, fontSize: 14, textAlign: "center" }}>
            ⚠️ {errorMessage}
          </div>
        )}

        {turnError && (
          <div
            style={{
              width: "100%",
              background: "#fdecea",
              border: "1px solid #f5c6cb",
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              textAlign: "center",
              boxSizing: "border-box",
            }}
          >
            <div style={{ color: "#611a15", fontSize: 14, marginBottom: 12 }}>⚠️ {turnError}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button
                onClick={() => setTurnError(null)}
                style={{
                  padding: "10px 16px",
                  borderRadius: 20,
                  border: "none",
                  background: "#4caf50",
                  color: "white",
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                🎤 Try again
              </button>
              <button
                onClick={() => {
                  setTurnError(null);
                  endSession();
                }}
                style={{
                  padding: "10px 16px",
                  borderRadius: 20,
                  border: "1px solid #ccc",
                  background: "white",
                  color: "#555",
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                End conversation
              </button>
            </div>
          </div>
        )}

        {pendingEnd ? (
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 12 }}>
              Listen to the teacher, then continue when you&apos;re ready.
            </div>
            <button
              onClick={handleContinueToResult}
              style={{
                padding: "14px 28px",
                borderRadius: 24,
                border: "none",
                background: "#ff8c42",
                color: "white",
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              Continue
            </button>
          </div>
        ) : busy ? (
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
              {recState === "recording" ? "Listening..." : "Your turn"}
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
                Keep talking ({Math.ceil(recorder.graceRemainingMs / 100) / 10}s)
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
          Conversation history {historyOpen ? "▲" : "▼"}
        </button>
        {historyOpen && (
          <div style={{ padding: "0 16px 16px", maxHeight: 240, overflowY: "auto" }}>
            {history.length === 0 ? (
              <div style={{ fontSize: 13, color: "#aaa" }}>(none yet)</div>
            ) : (
              history.map((h, i) => (
                <div key={i} style={{ marginBottom: 12, fontSize: 14 }}>
                  <div style={{ color: "#555" }}>👩‍🏫 {h.tutorText}</div>
                  <div style={{ color: "#333", marginTop: 2 }}>🧒 {h.transcriptKana}</div>
                  {h.transcriptEn && (
                    <div style={{ color: "#999", marginTop: 2, fontSize: 12 }}>({h.transcriptEn})</div>
                  )}
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
          elapsedSec={elapsedDisplaySec}
          plannedDurationSec={plannedDurationSec}
          timingLog={timingLog}
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
  elapsedSec: number;
  plannedDurationSec: number;
  timingLog: string[];
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
          <div style={{ marginBottom: 8, fontWeight: "bold" }}>
            elapsed: {props.elapsedSec.toFixed(0)}s / planned: {props.plannedDurationSec}s / remaining:{" "}
            {(props.plannedDurationSec - props.elapsedSec).toFixed(0)}s / isClosing now:{" "}
            {String(props.plannedDurationSec - props.elapsedSec <= CLOSING_THRESHOLD_SEC)}
          </div>
          <div
            style={{
              marginBottom: 12,
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
              background: "#fff",
              padding: 8,
              borderRadius: 4,
              maxHeight: 150,
              overflowY: "auto",
            }}
          >
            {props.timingLog.length === 0 ? "(no timing events yet)" : props.timingLog.join("\n")}
          </div>
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

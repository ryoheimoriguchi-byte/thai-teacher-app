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
import { fetchWithTimeout } from "../lib/fetch-with-timeout";

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

// Step C4: shape of a successful `action: "end"` response. Matches the
// NextResponse.json(...) built in app/api/conversation/session/route.ts's
// handleEnd(). `error` is set instead when the fetch itself failed (see
// endSession()'s catch below) — in that case none of the other fields exist.
type EndSessionResult = {
  sessionId?: string;
  speakingMs?: number;
  turnCount?: number;
  vocabUsedCount?: number;
  feedbackPositive?: string | null;
  feedbackImprovement?: string | null;
  highlight?: string | null;
  turnsAnsweredAlone?: number;
  turnsTotal?: number;
  missions?: { candoId: string; en: string; achieved: boolean }[];
  candoProgress?: { candoId: string; en: string; before: number; after: number; justAchieved: boolean }[];
  stageUp?: boolean;
  conversationStage?: number;
  previousSession?: { turnsAnsweredAlone: number; turnsTotal: number } | null;
  turnScores?: { turnIndex: number; vocab: number; grammar: number; fluency: number }[];
  error?: string;
};

/** mm:ss-ish formatting for the "N spoken" stat, e.g. 24s / 2m 40s. */
function formatSpeakingTime(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

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

// Real-device bug: a plain fetch() with no timeout can hang forever if the
// network stalls, leaving the UI stuck on "Listening..." with no way out.
// Every conversation API call is bounded so a stuck call always eventually
// becomes a catchable error (which the UI recovers from via "Try again" /
// "End conversation"). session end gets a longer budget — it includes the
// end-of-session review call (max_tokens 4000, slower than a single turn).
const SESSION_START_TIMEOUT_MS = 20000;
const SESSION_END_TIMEOUT_MS = 35000;
const TRANSCRIBE_TIMEOUT_MS = 20000;
const TURN_TIMEOUT_MS = 20000;

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
  // Chat-format screen (#5): which tutor bubbles have "Show English"
  // expanded, keyed by the same `key` used in chatItems below. A Set (not a
  // single bool) because every tutor bubble gets its own toggle now, not
  // just the latest one.
  const [expandedTranslations, setExpandedTranslations] = useState<Set<string>>(new Set());
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  // Set only when a turn failed AFTER we already have a transcript (i.e. the
  // /turn call itself failed, not /transcribe). Distinct from errorMessage
  // so we can show explicit recovery actions instead of a bare error line.
  const [turnError, setTurnError] = useState<string | null>(null);
  // Fix 2 (2026-09-19): "Not what I said" is now a persistent, no-time-limit
  // control next to the most recent student bubble (see undoLastTurn below),
  // replacing an earlier timed pre-send cancel window that was too easy to
  // miss while scrolling. true while that undo request is in flight.
  const [undoInFlight, setUndoInFlight] = useState(false);

  // ?debug=1 panel: elapsed time / isClosing bookkeeping, so this can be
  // verified on a real device without guessing.
  const [timingLog, setTimingLog] = useState<string[]>([]);
  const addTimingLog = useCallback((msg: string) => {
    const t = new Date().toISOString().split("T")[1].replace("Z", "");
    setTimingLog((prev) => [...prev.slice(-29), `${t} ${msg}`]);
  }, []);
  const [elapsedDisplaySec, setElapsedDisplaySec] = useState(0); // updated every second for the debug panel; safe to read during render (state, not a ref/Date.now() call)

  const [result, setResult] = useState<EndSessionResult | null>(null);

  // Step C3: missions selected for this session (shown on the [2] intro
  // screen, English only). Populated by startSession(), which now runs when
  // moving from [1] to [2] (not when pressing "Start") so the missions are
  // known before the intro screen is shown.
  const [missions, setMissions] = useState<{ candoId: string; en: string; example: string }[]>([]);
  // Fix 1: provisional, display-only "used" state per mission, ticked from
  // each turn's missions_used (Claude's own judgment for that turn). NOT
  // authoritative — the real judgment happens at session end (judgeCandos),
  // and can differ (see conversation-candos.ts doc comment). Once a mission
  // is ticked here it stays ticked for the rest of the session, even if a
  // later turn's provisional judgment doesn't repeat it.
  const [missionsUsedIds, setMissionsUsedIds] = useState<Set<string>>(new Set());
  const [candoDebug, setCandoDebug] = useState<{
    stage: number;
    candos: { candoId: string; en: string; stage: number; isStrategy: boolean; consecutiveSuccess: number; achieved: boolean }[];
  } | null>(null);
  const fetchCandoDebug = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await fetch(
        `/api/conversation/candos?userId=${currentUser.id}&language=${currentUser.language}`
      );
      const data = await res.json();
      if (res.ok) setCandoDebug(data);
    } catch {
      // debug-only convenience fetch; ignore failures
    }
  }, [currentUser]);

  useEffect(() => {
    if (!debugEnabled || !currentUser) return;
    // Deferred to a microtask, same pattern as the other debug/watchdog
    // effects in this file — this reacts to currentUser becoming available,
    // it's not deriving render state.
    queueMicrotask(() => {
      fetchCandoDebug();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugEnabled, currentUser]);

  // "Pending end": the tutor's final line (either a real should_end:true
  // reply, or the fixed FALLBACK_CLOSING_LINE when we force-end) is shown,
  // Listen is pressable, and the user can either tap Continue or wait — the
  // screen never jumps straight to the result screen in silence.
  const [pendingEnd, setPendingEnd] = useState(false);
  const pendingEndTimeoutRef = useRef<number | null>(null);

  const audioPlayer = useAudioPlayer();

  // Mic/AudioContext pre-warming (done on the [2] intro screen's "Start" tap,
  // itself a user gesture, so it can request mic permission AND unlock
  // playback ahead of time) — see enterConversation() below. State here is
  // read by the ?debug=1 panel only; never shown in the normal UI.
  const [micPermission, setMicPermission] = useState<"unknown" | "granted" | "denied">("unknown");
  const [audioCtxState, setAudioCtxState] = useState<"unknown" | "running" | "suspended">("unknown");
  const [introError, setIntroError] = useState<string | null>(null);
  const [preparingStart, setPreparingStart] = useState(false);

  // Chat-style layout (#5): auto-scroll to the newest message whenever the
  // chat log grows (a new tutor reply, a new student line, or the pending
  // cancel-grace bubble appearing/disappearing).
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (phase !== "conversation") return;
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [phase, history.length, currentTurn]);

  // Step C3: session creation (and mission selection, which happens
  // server-side as part of "start") now runs when moving from [1] to [2],
  // not when pressing "Start" on [2] — the missions need to already be
  // known so the intro screen can display them. The conversation *timer*
  // (sessionStartedAtRef) is deliberately NOT started here; that happens in
  // enterConversation() below, only once the user actually presses "Start".
  const startSession = useCallback(async () => {
    if (!currentUser || !selectedScenario || !selectedDurationMin) return;
    setBusy(true);
    setBusyMessage("Getting ready...");
    setErrorMessage(null);
    try {
      const res = await fetchWithTimeout(
        "/api/conversation/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start",
            userId: currentUser.id,
            language: currentUser.language,
            scenarioId: selectedScenario.id,
            plannedDurationSec: selectedDurationMin * 60,
          }),
        },
        SESSION_START_TIMEOUT_MS
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start session");

      setSessionId(data.sessionId);
      setCurrentTurn({ tutorText: data.tutorText, tutorTextEn: data.tutorTextEn });
      setHistory([]);
      setExpandedTranslations(new Set());
      setRetryNotice(null);
      setPlannedDurationSec(selectedDurationMin * 60);
      setMissions((data.missions as { candoId: string; en: string; example: string }[]) ?? []);
      setMissionsUsedIds(new Set());
      setTimingLog([
        `turn 0: support_given=${data.supportGiven ?? "null"} response_quality=${data.responseQuality ?? "null"}`,
        `missions selected: ${
          (data.missions ?? []).length === 0
            ? "(none)"
            : (data.missions as { candoId: string; en: string }[])
                .map((m) => `${m.candoId} (${m.en})`)
                .join(", ")
        } / conversationStage=${data.conversationStage}`,
      ]);
      setPendingEnd(false);
      setPhase("intro");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [currentUser, selectedScenario, selectedDurationMin]);

  // The "Start" tap on [2]. No conversation network call here (session +
  // missions + opening line were already created by startSession() above) —
  // instead, this is where mic permission and TTS playback get unlocked,
  // since this tap is itself a user gesture.
  //
  // Previously, the FIRST recording tap on the conversation screen did
  // double duty as both "get mic permission" and "unlock AudioContext for
  // TTS", which was confusing for a first-time child user: the permission
  // dialog would pop up mid-recording, and the tutor's voice couldn't be
  // played until it was dismissed. Doing both here means both are already
  // resolved by the time the conversation screen appears.
  const enterConversation = useCallback(() => {
    setIntroError(null);
    setPreparingStart(true);

    // Must be called synchronously in this click handler, before any
    // `await` below — see the doc comment on useAudioPlayer's unlock() for
    // why the ctx.resume() call itself needs to happen inside the user
    // gesture on iOS Safari.
    const unlockPromise = audioPlayer.unlock();

    (async () => {
      // Mic permission: request-then-immediately-release. This call is only
      // to trigger/resolve the permission prompt ahead of time; it must NOT
      // hold the stream open (an iOS mic-in-use indicator lit for the whole
      // conversation would be alarming). The actual recording still calls
      // getUserMedia again for real, per recording, in use-recorder.ts.
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getTracks().forEach((t) => t.stop());
        setMicPermission("granted");
      } catch {
        setMicPermission("denied");
        setIntroError(
          "Microphone access is needed to talk. Please allow it in Safari settings."
        );
        setPreparingStart(false);
        return; // stay on the intro screen — don't enter a conversation the mic can't drive
      }

      const state = await unlockPromise;
      setAudioCtxState(state);

      sessionStartedAtRef.current = Date.now();
      setElapsedDisplaySec(0);
      setPreparingStart(false);
      setPhase("conversation");
    })();
  }, [audioPlayer]);

  // [2] "← Choose a different topic": since startSession() (above) already
  // created the session + selected missions by this point, going back
  // without marking it abandoned would leave an active, 0-turn session
  // around forever — which is exactly the "mission selected but no
  // opportunity happened" case that could wrongly reset can-do progress if
  // it were ever picked up by judgment. Fire-and-forget: this is a cleanup
  // best-effort, not something the user should have to wait on.
  const backToSelect = useCallback(() => {
    if (sessionId) {
      fetch("/api/conversation/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "abandon", sessionId }),
      }).catch(() => {
        // best-effort cleanup; nothing the user can do about a failure here
      });
    }
    setSessionId(null);
    setMissions([]);
    setIntroError(null);
    setPhase("select");
  }, [sessionId]);

  // Step C4: result screen's "Talk again" — the session is already
  // completed (unlike backToSelect above), so there's nothing to abandon;
  // just reset back to scenario selection.
  const talkAgain = useCallback(() => {
    setSessionId(null);
    setMissions([]);
    setResult(null);
    setSelectedScenarioId(null);
    setSelectedDurationMin(null);
    setIntroError(null);
    setPhase("select");
  }, []);

  const endSession = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    setBusyMessage("Wrapping up...");
    try {
      const actualDurationSec = Math.round((Date.now() - sessionStartedAtRef.current) / 1000);
      const res = await fetchWithTimeout(
        "/api/conversation/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "end", sessionId, actualDurationSec }),
        },
        SESSION_END_TIMEOUT_MS
      );
      const data = await res.json();
      setResult(data);
      if (debugEnabled) fetchCandoDebug();
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setPhase("result");
    }
  }, [sessionId, debugEnabled, fetchCandoDebug]);

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

  // The actual /turn call.
  const sendTurn = useCallback(
    async (transcript: string, transcriptKana: string, totalMs: number) => {
      if (!sessionId || !currentTurn) return;
      setBusy(true);
      setBusyMessage("The teacher is thinking...");

      const elapsedSec = (Date.now() - sessionStartedAtRef.current) / 1000;
      const isClosing = plannedDurationSec - elapsedSec <= CLOSING_THRESHOLD_SEC;
      addTimingLog(
        `turn: elapsed=${elapsedSec.toFixed(0)}s / planned=${plannedDurationSec}s / isClosing=${isClosing}`
      );

      try {
        const turnRes = await fetchWithTimeout(
          "/api/conversation/turn",
          {
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
          },
          TURN_TIMEOUT_MS
        );
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
        addTimingLog(
          `turn ${turnData.turnIndex}: support_given=${turnData.supportGiven ?? "null"} response_quality=${turnData.responseQuality ?? "null"}` +
            (Array.isArray(turnData.missionsUsed) && turnData.missionsUsed.length > 0
              ? ` missions_used=${turnData.missionsUsed.join(",")}`
              : "")
        );
        if (Array.isArray(turnData.missionsUsed) && turnData.missionsUsed.length > 0) {
          setMissionsUsedIds((prev) => {
            const next = new Set(prev);
            for (const id of turnData.missionsUsed as string[]) next.add(id);
            return next;
          });
        }
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
        addTimingLog(`turn failed: ${e instanceof Error ? e.message : String(e)}`);
        setBusy(false);
        setTurnError(e instanceof Error ? e.message : String(e));
        recorder.reset();
      }
    },
    [sessionId, currentTurn, plannedDurationSec, enterPendingEnd, addTimingLog, recorder]
  );

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

        const transcribeRes = await fetchWithTimeout(
          "/api/conversation/transcribe",
          { method: "POST", body: formData },
          TRANSCRIBE_TIMEOUT_MS
        );
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
        // Uses the same turnError recovery UI (Try again / End conversation)
        // as a /turn failure — a timeout/network error here needs the exact
        // same explicit escape hatch, not a bare error line.
        addTimingLog(`transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
        setBusy(false);
        setTurnError(e instanceof Error ? e.message : String(e));
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

      // Send immediately — mis-send recovery (#4/Fix 2) is now a persistent
      // "Not what I said" undo control shown after the fact (see
      // undoLastTurn below), not a pre-send delay.
      await sendTurn(transcript, transcriptKana, totalMs);
    },
    [sessionId, currentTurn, plannedDurationSec, recorder, enterPendingEnd, addTimingLog, sendTurn]
  );

  // Fix 2 (2026-09-19): undoes the single most recent exchange (the last
  // student utterance + the tutor's reply to it) — see handleUndoLastTurn
  // on the server for exactly what gets rolled back. Only ever available
  // for the latest turn, never deeper history.
  const undoLastTurn = useCallback(async () => {
    if (!sessionId || history.length === 0 || busy || pendingEnd || undoInFlight) return;
    setUndoInFlight(true);
    setErrorMessage(null);
    try {
      const res = await fetchWithTimeout(
        "/api/conversation/session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "undo_last_turn", sessionId }),
        },
        SESSION_START_TIMEOUT_MS
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Undo failed");

      setHistory((prev) => prev.slice(0, -1));
      setCurrentTurn({ tutorText: data.tutorText, tutorTextEn: data.tutorTextEn });
      setTurnError(null);
      setRetryNotice(null);
      addTimingLog("undo last turn");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setUndoInFlight(false);
    }
  }, [sessionId, history.length, busy, pendingEnd, undoInFlight, addTimingLog]);

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

          {errorMessage && (
            <div style={{ color: "#c00", marginBottom: 16, fontSize: 14 }}>⚠️ {errorMessage}</div>
          )}

          <button
            onClick={startSession}
            disabled={!selectedScenario || !selectedDurationMin || busy}
            style={{
              width: "100%",
              padding: 16,
              fontSize: 18,
              borderRadius: 12,
              border: "none",
              background: selectedScenario && selectedDurationMin ? "#ff8c42" : "#eee",
              color: selectedScenario && selectedDurationMin ? "white" : "#aaa",
              cursor: selectedScenario && selectedDurationMin && !busy ? "pointer" : "not-allowed",
            }}
          >
            {busy ? busyMessage || "Getting ready..." : "Next"}
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
            onClick={backToSelect}
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
              marginBottom: missions.length > 0 ? 16 : 24,
            }}
          >
            {selectedScenario.intro}
            <div style={{ fontSize: 13, color: "#999", marginTop: 8, lineHeight: 1.5 }}>
              {selectedScenario.introEn}
            </div>
          </div>

          {missions.length > 0 && (
            <div
              style={{
                background: "#fff3e6",
                borderRadius: 12,
                padding: 16,
                marginBottom: 24,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: "bold", color: "#a35a00", marginBottom: 8 }}>
                Today&apos;s missions
              </div>
              {missions.map((m) => (
                <div key={m.candoId} style={{ fontSize: 14, color: "#555", marginBottom: 4 }}>
                  · {m.en} <span style={{ color: "#aaa" }}>({m.example})</span>
                </div>
              ))}
            </div>
          )}

          {introError && (
            <div style={{ color: "#c00", marginBottom: 16, fontSize: 14 }}>⚠️ {introError}</div>
          )}

          <button
            onClick={enterConversation}
            disabled={preparingStart}
            style={{
              width: "100%",
              padding: 16,
              fontSize: 18,
              borderRadius: 12,
              border: "none",
              background: "#ff8c42",
              color: "white",
              cursor: preparingStart ? "default" : "pointer",
              opacity: preparingStart ? 0.7 : 1,
            }}
          >
            {preparingStart ? "Getting ready..." : "Start"}
          </button>
        </div>
      </main>
    );
  }

  /* ---------------- [4] result (Step C4 review screen) ---------------- */
  if (phase === "result") {
    const resultButtons = (
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <button
          onClick={talkAgain}
          style={{
            flex: 1,
            padding: 16,
            fontSize: 16,
            borderRadius: 12,
            border: "1px solid #ff8c42",
            background: "white",
            color: "#ff8c42",
            cursor: "pointer",
          }}
        >
          Talk again
        </button>
        <Link
          href="/"
          style={{
            flex: 1,
            textAlign: "center",
            padding: 16,
            fontSize: 16,
            borderRadius: 12,
            background: "#ff8c42",
            color: "white",
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          Done
        </Link>
      </div>
    );

    // Fetch itself failed (see endSession()'s catch) — nothing else in
    // `result` is populated, so just show the error and let them retry.
    if (!result || result.error) {
      return (
        <main style={containerStyle}>
          <div style={{ padding: 20 }}>
            <div style={{ fontSize: 20, fontWeight: "bold", marginBottom: 16 }}>Session ended</div>
            {result?.error && (
              <div style={{ color: "#c00", marginBottom: 24, fontSize: 14 }}>⚠️ {result.error}</div>
            )}
            {resultButtons}
          </div>
        </main>
      );
    }

    const turnsTotal = result.turnsTotal ?? 0;

    // Design decision (step_c4 instructions): 0-turn sessions skip every
    // scoring/mission/progress section entirely — there's nothing to show,
    // and showing empty sections would look broken.
    if (turnsTotal === 0) {
      return (
        <main style={containerStyle}>
          <div style={{ padding: 20 }}>
            <div style={{ fontSize: 20, fontWeight: "bold", marginBottom: 12 }}>Session ended</div>
            <div style={{ fontSize: 16, color: "#666", marginBottom: 32 }}>
              You didn&apos;t get to talk this time. Try again!
            </div>
            {resultButtons}
          </div>
        </main>
      );
    }

    const turnsAnsweredAlone = result.turnsAnsweredAlone ?? 0;
    const neededHelp = Math.max(0, turnsTotal - turnsAnsweredAlone);
    const resultMissions = result.missions ?? [];
    const resultCandoProgress = result.candoProgress ?? [];
    const previousSession = result.previousSession ?? null;
    const justAchievedCount = resultCandoProgress.filter((c) => c.justAchieved).length;
    const improved = previousSession ? turnsAnsweredAlone > previousSession.turnsAnsweredAlone : false;

    return (
      <main style={containerStyle}>
        <div style={{ padding: "20px 20px 40px" }}>
          {/* 10. Stage Up banner — design decision: a plain in-page banner,
              NOT app/lib/stage-up-celebration.tsx's confetti modal (that's
              the vocabulary side's celebration; a fuller version for
              Conversation is deferred to Step C5). */}
          {result.stageUp && (
            <div
              style={{
                background: "#4caf50",
                color: "white",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 20,
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 16, fontWeight: "bold" }}>Stage {result.conversationStage} unlocked!</div>
              <div style={{ fontSize: 13, marginTop: 2, opacity: 0.9 }}>
                You finished everything in Stage {(result.conversationStage ?? 1) - 1}.
              </div>
            </div>
          )}

          {/* 1. Header */}
          <div style={{ fontSize: 20, fontWeight: "bold" }}>Session done</div>
          <div style={{ fontSize: 14, color: "#888", marginBottom: 20 }}>
            Talking about {selectedScenario?.titleEn ?? "Japanese"} · {turnsTotal} {turnsTotal === 1 ? "turn" : "turns"}
          </div>

          {/* 2. Headline: absolute count, not a percentage — see the design
              rationale in step_c4_review_screen_instructions.md. A % headline
              punishes trying (one more attempted-but-helped turn lowers it),
              which fights the app's actual top priority: talk a lot. */}
          <div
            style={{
              textAlign: "center",
              background: "white",
              borderRadius: 16,
              padding: "20px 16px",
              marginBottom: 20,
            }}
          >
            <div style={{ fontSize: 14, color: "#666", marginBottom: 4 }}>You answered on your own</div>
            <div style={{ fontSize: 48, fontWeight: "bold", color: "#ff8c42", lineHeight: 1 }}>
              {turnsAnsweredAlone}
            </div>
            <div style={{ fontSize: 13, color: "#888", marginTop: 8 }}>
              {turnsTotal} turns · needed help {neededHelp} {neededHelp === 1 ? "time" : "times"}
            </div>
            {previousSession && (
              <div style={{ fontSize: 13, marginTop: 8, color: improved ? "#4caf50" : "#999" }}>
                {improved ? "↗" : "•"} Last time: {previousSession.turnsAnsweredAlone}
              </div>
            )}
          </div>

          {/* 3. Today's missions — same achieved/not-achieved data as the
              in-conversation checklist, but authoritative now (judgeCandos
              ran at session end). No ✗, no red — "next time" instead. */}
          {resultMissions.length > 0 && (
            <div style={{ background: "white", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: "bold", color: "#555", marginBottom: 10 }}>
                Today&apos;s missions
              </div>
              {resultMissions.map((m) => (
                <div
                  key={m.candoId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 14,
                    color: m.achieved ? "#4caf50" : "#666",
                    marginBottom: 6,
                  }}
                >
                  <span>
                    {m.achieved ? "✓" : "−"} {m.en}
                  </span>
                  {!m.achieved && <span style={{ fontSize: 12, color: "#aaa" }}>next time</span>}
                </div>
              ))}
            </div>
          )}

          {/* 4. Progress — only can-dos whose consecutive_success moved this
              session (candoProgress is already filtered that way server-side). */}
          {resultCandoProgress.length > 0 && (
            <div style={{ background: "white", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: "bold", color: "#555", marginBottom: 10 }}>Progress</div>
              {resultCandoProgress.map((c) => (
                <div
                  key={c.candoId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 14,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: c.justAchieved ? "#e8f5e9" : "transparent",
                    marginBottom: 4,
                    gap: 8,
                  }}
                >
                  <span style={{ color: "#333" }}>{c.en}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <span style={{ color: "#4caf50", letterSpacing: 2 }}>
                      {"●".repeat(Math.min(3, c.after))}
                      {"○".repeat(Math.max(0, 3 - c.after))}
                    </span>
                    {c.justAchieved && (
                      <span style={{ fontSize: 12, color: "#4caf50", fontWeight: "bold", whiteSpace: "nowrap" }}>
                        You can do this now
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 5. Best moment */}
          {result.highlight && (
            <div style={{ border: "2px solid #ff8c42", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: "bold", color: "#ff8c42", marginBottom: 6, letterSpacing: 1 }}>
                BEST MOMENT
              </div>
              <div style={{ fontSize: 14, color: "#333", lineHeight: 1.5 }}>{result.highlight}</div>
            </div>
          )}

          {/* 6. Try next time — exactly one, never more (feedbackPositive is
              deliberately not shown at all — it overlaps with Best moment). */}
          {result.feedbackImprovement && (
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: "bold", color: "#888", marginBottom: 6, letterSpacing: 1 }}>
                TRY NEXT TIME
              </div>
              <div style={{ fontSize: 14, color: "#555", lineHeight: 1.5 }}>{result.feedbackImprovement}</div>
            </div>
          )}

          {/* 7. Secondary stats */}
          <div style={{ textAlign: "center", fontSize: 13, color: "#999", marginBottom: 20 }}>
            {formatSpeakingTime(result.speakingMs ?? 0)} spoken · {result.vocabUsedCount ?? 0} words used ·{" "}
            {justAchievedCount} new can-do
          </div>

          {/* 8. Score details — Ryo-only, gated behind ?debug=1 (not just
              collapsed-by-default): vocab/grammar/fluency are the LLM's
              subjective 1-5 scores, which don't stay stable across
              sessions — that instability is exactly why this was kept out
              of the headline metric in the first place. Showing it to a
              child by default would surface the metric this screen's
              whole design was built to avoid. */}
          {debugEnabled && (result.turnScores?.length ?? 0) > 0 && (
            <ScoreDetails turnScores={result.turnScores!} />
          )}

          {debugEnabled && (
            <div
              style={{
                background: "#f5f5f5",
                borderRadius: 8,
                padding: 16,
                marginTop: 20,
                marginBottom: 20,
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontWeight: "bold" }}>DEBUG: user_candos (stage {candoDebug?.stage ?? "?"})</div>
                <button
                  onClick={fetchCandoDebug}
                  style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #ccc", background: "white", cursor: "pointer" }}
                >
                  Refresh
                </button>
              </div>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", margin: 0 }}>
                {candoDebug
                  ? candoDebug.candos
                      .map(
                        (c) =>
                          `${c.candoId}${c.isStrategy ? " (strategy)" : ""}: consecutive=${c.consecutiveSuccess} achieved=${c.achieved}`
                      )
                      .join("\n")
                  : "(not loaded — press Refresh)"}
              </pre>
              <pre style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", margin: "8px 0 0", maxHeight: 200, overflowY: "auto" }}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}

          {/* 9. Buttons */}
          {resultButtons}
        </div>
      </main>
    );
  }

  /* ---------------- [3] conversation (chat-style, #5) ---------------- */
  const recState = recorder.recState;
  const micDisabled = busy || recState === "stopped" || undoInFlight;

  const handleMicTap = () => {
    if (recState === "idle") {
      recorder.startRecording();
    } else if (recState === "recording") {
      recorder.stopManually();
    }
  };

  const toggleTranslation = (key: string) => {
    setExpandedTranslations((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Chronological chat log: each completed history turn contributes a
  // tutor bubble + the student's bubble, then the (not-yet-answered)
  // currentTurn's tutor bubble.
  type ChatItem = {
    key: string;
    role: "tutor" | "student";
    text: string;
    textEn: string | null;
    /** Fix 2: only the single most recent student bubble can be undone. */
    undoable?: boolean;
  };
  const chatItems: ChatItem[] = [];
  history.forEach((h, i) => {
    chatItems.push({ key: `t${i}`, role: "tutor", text: h.tutorText, textEn: h.tutorTextEn });
    chatItems.push({
      key: `s${i}`,
      role: "student",
      text: h.transcriptKana,
      textEn: h.transcriptEn,
      undoable: i === history.length - 1,
    });
  });
  if (currentTurn) {
    chatItems.push({ key: "t-current", role: "tutor", text: currentTurn.tutorText, textEn: currentTurn.tutorTextEn });
  }

  return (
    // height (not just minHeight) + overflow: hidden so the chat log
    // (flex: 1, overflowY: auto below) is the thing that scrolls, not the
    // whole page — that's what keeps the mic button fixed at the bottom.
    <main style={{ ...containerStyle, height: "100dvh", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid #eee",
          background: "white",
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleCancel}
          style={{ background: "none", border: "none", fontSize: 15, color: "#888", cursor: "pointer", padding: 0 }}
        >
          ← Quit
        </button>
      </div>

      {/* Mission checklist (#6): display-only, no real-time checking — the
          judgment that decides achievement only runs at session end (see
          conversation-candos.ts), so a check ticked mid-conversation could
          be wrong by the time the session actually ends. */}
      {missions.length > 0 && (
        <div
          style={{
            background: "#fff3e6",
            borderBottom: "1px solid #ffe0b3",
            padding: "10px 16px",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: "bold", color: "#a35a00", marginBottom: 4 }}>
            Today&apos;s missions
          </div>
          {missions.map((m) => {
            const used = missionsUsedIds.has(m.candoId);
            return (
              <div key={m.candoId} style={{ fontSize: 13, color: used ? "#4caf50" : "#7a5a30" }}>
                {used ? "☑" : "☐"} {m.en}
              </div>
            );
          })}
        </div>
      )}

      {/* Chat log — new messages appended at the bottom, auto-scrolls down. */}
      <div
        ref={chatScrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {chatItems.map((item) =>
          item.role === "tutor" ? (
            <div key={item.key} style={{ alignSelf: "flex-start", maxWidth: "88%" }}>
              <div
                style={{
                  background: "white",
                  borderRadius: "16px 16px 16px 4px",
                  padding: "12px 16px",
                  fontSize: 19,
                  lineHeight: 1.5,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                  boxSizing: "border-box",
                }}
              >
                {item.text}
              </div>
              <div style={{ display: "flex", gap: 12, marginTop: 4, marginLeft: 4 }}>
                <button
                  onClick={() => audioPlayer.play(item.text)}
                  style={{ background: "none", border: "none", color: "#888", fontSize: 12, cursor: "pointer", padding: 0 }}
                >
                  🔊 {audioPlayer.state === "loading" ? "..." : "Listen"}
                </button>
                <button
                  onClick={() => toggleTranslation(item.key)}
                  style={{ background: "none", border: "none", color: "#888", fontSize: 12, cursor: "pointer", padding: 0 }}
                >
                  {expandedTranslations.has(item.key) ? "Hide English" : "Show English"}
                </button>
              </div>
              {expandedTranslations.has(item.key) && (
                <div style={{ fontSize: 12, color: "#999", marginTop: 4, marginLeft: 4 }}>{item.textEn}</div>
              )}
            </div>
          ) : (
            <div key={item.key} style={{ alignSelf: "flex-end", maxWidth: "88%" }}>
              <div
                style={{
                  background: "#c8e9c8",
                  borderRadius: "16px 16px 4px 16px",
                  padding: "12px 16px",
                  fontSize: 17,
                  lineHeight: 1.5,
                  boxSizing: "border-box",
                }}
              >
                {item.text}
              </div>
              {item.textEn && (
                <div style={{ fontSize: 12, color: "#8a9a8a", marginTop: 4, marginRight: 4, textAlign: "right" }}>
                  {item.textEn}
                </div>
              )}
              {/* Fix 2: persistent (no time limit) undo control, only on the
                  single most recent student bubble. */}
              {item.undoable && (
                <div style={{ textAlign: "right", marginTop: 4, marginRight: 4 }}>
                  <button
                    onClick={undoLastTurn}
                    disabled={busy || pendingEnd || undoInFlight}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#aaa",
                      fontSize: 11,
                      cursor: busy || pendingEnd || undoInFlight ? "default" : "pointer",
                      padding: 0,
                    }}
                  >
                    {undoInFlight ? "Undoing..." : "↺ Not what I said"}
                  </button>
                </div>
              )}
            </div>
          )
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Fixed footer: mic button / status / recovery actions. */}
      <div style={{ borderTop: "1px solid #eee", background: "white", padding: "16px 20px", flexShrink: 0 }}>
        {pendingEnd ? (
          <div style={{ textAlign: "center" }}>
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
        ) : turnError ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ color: "#c00", fontSize: 14, marginBottom: 12 }}>⚠️ {turnError}</div>
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
        ) : busy ? (
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>💭</div>
            <div style={{ fontSize: 15, color: "#666" }}>{busyMessage}</div>
          </div>
        ) : (
          <div style={{ textAlign: "center" }}>
            {errorMessage && (
              <div style={{ color: "#c00", marginBottom: 10, fontSize: 14 }}>⚠️ {errorMessage}</div>
            )}
            {retryNotice && (
              <div style={{ color: "#a35a00", marginBottom: 10, fontSize: 15 }}>{retryNotice}</div>
            )}
            <button
              onClick={handleMicTap}
              disabled={micDisabled}
              style={{
                width: 84,
                height: 84,
                borderRadius: "50%",
                border: "none",
                background: recState === "recording" ? "#e53935" : "#4caf50",
                color: "white",
                fontSize: 32,
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
              <div style={{ marginTop: 12, fontSize: 13, color: "#c00", maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>
                {recorder.recordingError}
              </div>
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
          micPermission={micPermission}
          audioCtxState={audioCtxState}
        />
      )}
    </main>
  );
}

/**
 * Step C4 review screen, section 8: collapsed by default. Ryo-facing (to
 * sanity-check the review scoring), not meant for Mirei to open.
 */
function ScoreDetails(props: {
  turnScores: { turnIndex: number; vocab: number; grammar: number; fluency: number }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 20 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          textAlign: "left",
          padding: "10px 12px",
          background: "#f5f5f5",
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          color: "#888",
          cursor: "pointer",
        }}
      >
        Score details {open ? "▲" : "▼"}
      </button>
      {open && (
        <div style={{ padding: "10px 12px", fontSize: 13, color: "#555" }}>
          {props.turnScores.map((t) => (
            <div key={t.turnIndex} style={{ marginBottom: 4 }}>
              Turn {t.turnIndex} &nbsp; vocab {t.vocab} &nbsp; grammar {t.grammar} &nbsp; fluency {t.fluency}
            </div>
          ))}
        </div>
      )}
    </div>
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
  micPermission: "unknown" | "granted" | "denied";
  audioCtxState: "unknown" | "running" | "suspended";
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
          <div style={{ marginBottom: 8, fontWeight: "bold" }}>
            mic: {props.micPermission} / audio: {props.audioCtxState}
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

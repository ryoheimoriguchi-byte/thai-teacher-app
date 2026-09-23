/**
 * Recording hook with silence-detection auto-stop.
 *
 * This is the exact logic verified on real iPhone hardware in
 * app/conversation-lab/page.tsx (Step C1), extracted here so the
 * Conversation feature (Step C2) doesn't reimplement it. If you change
 * this file, re-verify on a real iOS device — this is the part of the
 * app most exposed to iOS Safari quirks (see conversation-lab's debug
 * log / history for the pitfalls that were already hit and fixed).
 *
 * Client-only. Must be called from a component with "use client".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getAudioContext, unlockAudio } from "./audio-context";

export type RecorderState = "idle" | "recording" | "grace" | "stopped";

export interface UseRecorderOptions {
  /** RMS threshold above which audio counts as "speech". Verified default: 0.006 */
  silenceThreshold?: number;
  /** How long silence must continue before auto-stopping. Verified default: 2500ms */
  silenceDurationMs?: number;
  /** Minimum recording length before auto-stop is allowed to trigger. Verified default: 500ms */
  minRecordingMs?: number;
  /** How long the "keep talking" grace window stays open after an auto-stop. */
  graceWindowMs?: number;
  /**
   * Safety net: force-stop the recording after this much time regardless of
   * silence detection. Added after a real-device bug where background noise
   * stayed above `silenceThreshold` indefinitely, so the speak→silence
   * auto-stop never fired and the mic stayed in "recording" forever with no
   * way out except a manual tap the child didn't know to make.
   * Default: 30000 (30s) — generous for a single child's utterance, but
   * bounded so "recording" can never mean "stuck forever".
   */
  maxRecordingMs?: number;
  /**
   * Called once a recording is truly finalized (either an immediate manual
   * stop, or the grace window elapsing without a "continue" tap).
   * `totalMs` is the sum of active-recording time across all segments
   * (i.e. includes time from any "keep talking" continuations).
   */
  onRecordingComplete: (blob: Blob, mimeType: string, totalMs: number) => void;
}

function computeRms(dataArray: Uint8Array): number {
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / dataArray.length);
}

function pickMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) {
      return c;
    }
  }
  return ""; // let the browser pick its default
}

export function useRecorder(options: UseRecorderOptions) {
  const { onRecordingComplete, graceWindowMs = 3000, maxRecordingMs = 30000 } = options;

  const [silenceThreshold, setSilenceThreshold] = useState(options.silenceThreshold ?? 0.006);
  const [silenceDurationMs, setSilenceDurationMs] = useState(options.silenceDurationMs ?? 2500);
  const [minRecordingMs, setMinRecordingMs] = useState(options.minRecordingMs ?? 500);

  const [recState, setRecState] = useState<RecorderState>("idle");
  const [liveRms, setLiveRms] = useState(0);
  const [hasSpokenOnce, setHasSpokenOnce] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [silenceMs, setSilenceMs] = useState(0);
  const [graceRemainingMs, setGraceRemainingMs] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [actualSettings, setActualSettings] = useState<string>("(not captured yet)");

  // On-screen debug log: iPhone Safari has no visible console.
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const addDebugLog = useCallback((msg: string) => {
    const t = new Date().toISOString().split("T")[1].replace("Z", "");
    setDebugLog((prev) => [...prev.slice(-29), `${t} ${msg}`]);
  }, []);

  const streamRef = useRef<MediaStream | null>(null);
  // Step C4.1: no longer this hook's own AudioContext — shared with
  // playback via audio-context.ts (see that file's doc comment for why:
  // a real-device bug traced partly to recording and playback each having
  // their own separate AudioContext instance). This hook must never call
  // .close() on the shared context; only disconnect() its own nodes below.
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const segmentStartAtRef = useRef<number>(0);
  const lastSpeechAtRef = useRef<number>(0);
  const hasSpokenOnceRef = useRef(false);
  const graceTimerRef = useRef<number | null>(null);
  // Sum of active-recording time across all segments of the CURRENT logical
  // recording (i.e. across any "keep talking" continuations). Reset to 0
  // once onRecordingComplete has been called for that recording.
  const accumulatedMsRef = useRef(0);

  // Disconnects (but does NOT close — see audio-context.ts) this hook's own
  // nodes on the shared AudioContext. Called before setting up a fresh
  // analyser for a new recording, and on unmount, so nodes from a finished
  // recording don't linger forever on the long-lived shared context.
  const disconnectAnalyser = () => {
    try {
      sourceNodeRef.current?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      analyserRef.current?.disconnect();
    } catch {
      // already disconnected
    }
    sourceNodeRef.current = null;
    analyserRef.current = null;
  };

  const stopMonitorLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const finalizeRecorder = useCallback(
    (thenGoToGrace: boolean) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") return;

      accumulatedMsRef.current += performance.now() - segmentStartAtRef.current;

      recorder.onstop = () => {
        if (thenGoToGrace) {
          setRecState("grace");
          let remaining = graceWindowMs;
          setGraceRemainingMs(remaining);
          graceTimerRef.current = window.setInterval(() => {
            remaining -= 100;
            setGraceRemainingMs(Math.max(0, remaining));
            if (remaining <= 0) {
              if (graceTimerRef.current) window.clearInterval(graceTimerRef.current);
              const blob = new Blob(segmentsRef.current, { type: mimeTypeRef.current || "audio/webm" });
              // Math.round: performance.now() differences are floats (and
              // summing multiple "keep talking" segments compounds the
              // float error), but this value ultimately gets written to an
              // `integer` DB column (recording_ms / speaking_ms). Round here
              // at the source so every consumer downstream gets an integer.
              const totalMs = Math.round(accumulatedMsRef.current);
              accumulatedMsRef.current = 0;
              setRecState("stopped");
              onRecordingComplete(blob, mimeTypeRef.current || "audio/webm", totalMs);
            }
          }, 100);
        } else {
          const blob = new Blob(segmentsRef.current, { type: mimeTypeRef.current || "audio/webm" });
          const totalMs = Math.round(accumulatedMsRef.current);
          accumulatedMsRef.current = 0;
          setRecState("stopped");
          onRecordingComplete(blob, mimeTypeRef.current || "audio/webm", totalMs);
        }
      };
      recorder.stop();
    },
    [graceWindowMs, onRecordingComplete]
  );

  const monitorLoopRef = useRef<() => void>(() => {});

  const monitorLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const rms = computeRms(data);
    setLiveRms(rms);

    const now = performance.now();
    setElapsedMs(now - segmentStartAtRef.current);

    if (rms > silenceThreshold) {
      lastSpeechAtRef.current = now;
      if (!hasSpokenOnceRef.current) {
        hasSpokenOnceRef.current = true;
        setHasSpokenOnce(true);
      }
      setSilenceMs(0);
    } else if (hasSpokenOnceRef.current) {
      setSilenceMs(now - lastSpeechAtRef.current);
    }

    const recordingElapsed = now - segmentStartAtRef.current;
    const silenceElapsed = now - lastSpeechAtRef.current;

    // Safety net (see maxRecordingMs doc comment above): fires regardless of
    // hasSpokenOnce/silenceThreshold, so this can never be defeated by
    // background noise that never dips below threshold. No grace window —
    // just stop and hand off whatever was captured (if it's silence/noise,
    // the existing empty-transcript path already recovers gracefully).
    if (recordingElapsed >= maxRecordingMs) {
      addDebugLog(`force-stop: recordingElapsed=${recordingElapsed.toFixed(0)}ms >= maxRecordingMs=${maxRecordingMs}ms`);
      stopMonitorLoop();
      finalizeRecorder(false);
      return;
    }

    if (
      hasSpokenOnceRef.current &&
      recordingElapsed >= minRecordingMs &&
      silenceElapsed >= silenceDurationMs
    ) {
      stopMonitorLoop();
      finalizeRecorder(true);
      return;
    }

    rafRef.current = requestAnimationFrame(() => monitorLoopRef.current());
  }, [silenceThreshold, silenceDurationMs, minRecordingMs, maxRecordingMs, finalizeRecorder, addDebugLog]);

  useEffect(() => {
    monitorLoopRef.current = monitorLoop;
  }, [monitorLoop]);

  const startRecording = useCallback(async () => {
    addDebugLog("tap detected");
    setRecordingError(null);
    setHasSpokenOnce(false);
    hasSpokenOnceRef.current = false;
    setSilenceMs(0);
    setElapsedMs(0);

    // Step C4.1: must happen synchronously here, before the
    // `await getUserMedia()` below (which pops a native permission dialog
    // the first time) — see audio-context.ts's unlockAudio() doc comment.
    // This also doubles as the "does a recording somehow re-enable Listen"
    // recovery path found during the real-device investigation, now made
    // deliberate: every recording tap re-forces the SAME shared context's
    // output path back up, which is what playback also uses.
    addDebugLog(`unlockAudio (before getUserMedia): ctx.state=${getAudioContext().state}`);
    unlockAudio();
    addDebugLog(`unlockAudio done: ctx.state=${getAudioContext().state}`);

    let stream: MediaStream;
    try {
      addDebugLog("calling getUserMedia");
      stream = await navigator.mediaDevices.getUserMedia({
        // "ideal" (not exact/hard) constraints — verified on iPhone Safari to
        // actually apply 16kHz; on some Chromium builds sampleRate is ignored
        // and falls back to 48kHz, which is an accepted tradeoff (see C1 report).
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      addDebugLog("getUserMedia resolved");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      addDebugLog(`getUserMedia rejected: ${err.name}: ${err.message}`);
      setRecordingError(
        `❌ Could not access the microphone (${err.name}: ${err.message}). ` +
          `Allow microphone access in your browser settings, then tap again.`
      );
      setRecState("idle");
      return;
    }
    streamRef.current = stream;

    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();

    const mimeType = pickMimeType();
    mimeTypeRef.current = mimeType;
    segmentsRef.current = [];

    let recorder: MediaRecorder;
    try {
      addDebugLog(`creating MediaRecorder (mimeType=${mimeType || "browser default"})`);
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      addDebugLog(`MediaRecorder init failed: ${err.name}: ${err.message}`);
      setRecordingError(`❌ Failed to initialize MediaRecorder (${err.name}: ${err.message})`);
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecState("idle");
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) segmentsRef.current.push(e.data);
    };
    recorder.onerror = (e) => {
      addDebugLog(`MediaRecorder onerror: ${String((e as ErrorEvent).error ?? e)}`);
      setRecordingError(`❌ Recording error: ${String((e as ErrorEvent).error ?? e)}`);
    };
    recorderRef.current = recorder;
    recorder.start();
    addDebugLog("MediaRecorder started");

    setActualSettings(
      `MediaRecorder.mimeType (applied): ${recorder.mimeType || "(unknown)"}\n` +
        `Requested (ideal): channelCount=1, sampleRate=16000\n` +
        `track.getSettings(): ${JSON.stringify(settings, null, 2)}`
    );

    try {
      // Disconnect any leftover analyser/source from a previous recording
      // before creating fresh ones — the shared context itself (see
      // audio-context.ts) is long-lived and must never be closed, but its
      // nodes from a finished recording shouldn't linger forever.
      disconnectAnalyser();
      const audioCtx = getAudioContext(); // shared with playback — already unlocked by unlockAudio() above
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      sourceNodeRef.current = source;
      analyserRef.current = analyser;
      addDebugLog("silence-detection AudioContext ready");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      addDebugLog(`silence-detection AudioContext failed: ${err.name}: ${err.message}`);
      setRecordingError(
        `⚠️ Failed to initialize the AudioContext used for silence detection (${err.name}: ${err.message}). ` +
          `Recording will continue, but auto-stop won't work. Please stop manually.`
      );
    }

    segmentStartAtRef.current = performance.now();
    lastSpeechAtRef.current = performance.now();
    setRecState("recording");
    rafRef.current = requestAnimationFrame(() => monitorLoopRef.current());
  }, [addDebugLog]);

  const stopManually = useCallback(() => {
    stopMonitorLoop();
    finalizeRecorder(false);
  }, [finalizeRecorder]);

  const continueSpeaking = useCallback(() => {
    if (graceTimerRef.current) window.clearInterval(graceTimerRef.current);
    if (!streamRef.current) return;
    const mimeType = mimeTypeRef.current;
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) segmentsRef.current.push(e.data);
    };
    recorderRef.current = recorder;
    recorder.start();

    hasSpokenOnceRef.current = false; // start the speak->silence detection over for the continuation
    setHasSpokenOnce(false);
    segmentStartAtRef.current = performance.now();
    lastSpeechAtRef.current = performance.now();
    setRecState("recording");
    rafRef.current = requestAnimationFrame(() => monitorLoopRef.current());
  }, []);

  /** Call after handling a "stopped" recording, to allow starting a new one. */
  const reset = useCallback(() => {
    setRecState("idle");
  }, []);

  useEffect(() => {
    return () => {
      stopMonitorLoop();
      if (graceTimerRef.current) window.clearInterval(graceTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      // Disconnect this hook's own nodes, but NEVER close the shared
      // AudioContext here (or anywhere) — see audio-context.ts. Playback
      // uses the same context and must keep working after this hook
      // unmounts (e.g. leaving the conversation page).
      disconnectAnalyser();
    };
  }, []);

  return {
    // config
    silenceThreshold,
    setSilenceThreshold,
    silenceDurationMs,
    setSilenceDurationMs,
    minRecordingMs,
    setMinRecordingMs,
    // state
    recState,
    liveRms,
    hasSpokenOnce,
    elapsedMs,
    silenceMs,
    graceRemainingMs,
    recordingError,
    actualSettings,
    debugLog,
    // actions
    startRecording,
    stopManually,
    continueSpeaking,
    reset,
  };
}

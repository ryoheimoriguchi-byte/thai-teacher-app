"use client";

/**
 * Step C1: verification-only page for recording + audio playback.
 *
 * NOT wired into any production feature. Not linked from navigation
 * (reachable only via direct URL). No DB writes.
 *
 * What this page verifies:
 *   1. Auto-stop recording via silence detection
 *   2. iOS audio unlock
 *   3. TTS comparison across 3 methods (Web Speech / OpenAI bulk / OpenAI streaming)
 *   4. speechSynthesis.getVoices() list (whether a Japanese voice exists)
 *   5. Actual MediaRecorder settings applied
 *
 * NOTE: This page intentionally forces light mode (color-scheme: light +
 * explicit background/text colors) regardless of the device's dark mode
 * setting. This is a verification-only page, so theming is out of scope;
 * this does NOT affect any other page's theme.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { speak } from "@/app/lib/tts";

/* ------------------------------------------------------------------ */
/* Shared styles (no design polish intended)                          */
/* ------------------------------------------------------------------ */

const section: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: 16,
  marginBottom: 20,
  background: "#ffffff",
  color: "#111111",
};
const h2: React.CSSProperties = { fontSize: 16, fontWeight: "bold", marginBottom: 8 };
const mono: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  background: "#f5f5f5",
  color: "#111111",
  padding: 8,
  borderRadius: 4,
};
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 };

/* ------------------------------------------------------------------ */
/* 1. Recording (auto-stop via silence detection)                     */
/* ------------------------------------------------------------------ */

// TTS test phrases stay in Japanese on purpose (we're verifying Japanese audio).
const SHORT_TEXT = "こんにちは！げんき？";
const LONG_TEXT = "はい、りんご ふたつね。ほかには なにか いる？";

function computeRms(dataArray: Uint8Array): number {
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / dataArray.length);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function measureWebSpeech(text: string): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    speak(text, "ja-JP");
    const poll = () => {
      if (window.speechSynthesis.speaking) {
        resolve(performance.now() - t0);
      } else {
        requestAnimationFrame(poll);
      }
    };
    requestAnimationFrame(poll);
    // Safety timeout
    window.setTimeout(() => resolve(-1), 8000);
  });
}

async function measureBulk(text: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch("/api/conversation/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, provider: "openai" }),
  });
  const buf = await res.arrayBuffer();
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
  return await new Promise((resolve) => {
    const audio = new Audio(blobUrl);
    audio.onplaying = () => resolve(performance.now() - t0);
    audio.onerror = () => resolve(-1);
    audio.play().catch(() => resolve(-1));
  });
}

// PCM/WAV: schedule raw samples via the Web Audio API as they arrive (true chunked playback)
async function measureStreamingPcmLike(text: string, format: "pcm" | "wav"): Promise<number> {
  const t0 = performance.now();
  const res = await fetch("/api/conversation/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, stream: true, format }),
  });
  if (!res.body) return -1;

  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let sampleRate = 24000;
  let numChannels = 1;
  let headerSkipped = format === "pcm"; // pcm has no header
  let leftover: Uint8Array = new Uint8Array(0);
  let nextStartTime = 0;
  let firstSoundMs: number | null = null;

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk: Uint8Array = value;

    if (!headerSkipped) {
      // WAV: parse and skip the standard 44-byte PCM header
      leftover = concatBytes(leftover, chunk);
      if (leftover.length < 44) continue;
      const view = new DataView(leftover.buffer, leftover.byteOffset, leftover.byteLength);
      numChannels = view.getUint16(22, true) || 1;
      sampleRate = view.getUint32(24, true) || 24000;
      chunk = leftover.slice(44);
      leftover = new Uint8Array(0);
      headerSkipped = true;
    } else if (leftover.length > 0) {
      chunk = concatBytes(leftover, chunk);
      leftover = new Uint8Array(0);
    }

    // 16-bit PCM comes in 2-byte units; carry over an odd trailing byte to the next chunk
    const usableLength = chunk.length - (chunk.length % 2);
    if (usableLength <= 0) {
      leftover = chunk;
      continue;
    }
    const remainder = chunk.slice(usableLength);
    const samplesBytes = chunk.slice(0, usableLength);
    if (remainder.length > 0) leftover = remainder;

    const sampleCount = samplesBytes.length / 2;
    if (sampleCount === 0) continue;

    const dataView = new DataView(samplesBytes.buffer, samplesBytes.byteOffset, samplesBytes.byteLength);
    const audioBuffer = ctx.createBuffer(numChannels, sampleCount / numChannels, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const int16 = dataView.getInt16(i * 2, true);
      channelData[i] = int16 / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    if (nextStartTime === 0) {
      nextStartTime = ctx.currentTime + 0.03; // small lookahead margin
      firstSoundMs = performance.now() - t0;
    }
    source.start(nextStartTime);
    nextStartTime += audioBuffer.duration;
  }

  return firstSoundMs ?? -1;
}

// MP3 streaming: true incremental playback via MediaSource if supported, otherwise
// fall back to buffering the full response before playback (and label it as such).
async function measureStreamingMp3(text: string): Promise<{ ms: number; note: string }> {
  const t0 = performance.now();
  const mseSupported =
    typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");

  const res = await fetch("/api/conversation/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, stream: true, format: "mp3" }),
  });
  if (!res.body) return { ms: -1, note: "no body" };

  if (!mseSupported) {
    // Fallback: read everything, then play (not true streaming)
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as BlobPart);
    }
    const blob = new Blob(chunks, { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const ms = await new Promise<number>((resolve) => {
      const audio = new Audio(url);
      audio.onplaying = () => resolve(performance.now() - t0);
      audio.onerror = () => resolve(-1);
      audio.play().catch(() => resolve(-1));
    });
    return { ms, note: "MSE unsupported, played after full download (not true streaming)" };
  }

  return await new Promise((resolve) => {
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);
    let resolved = false;
    audio.onplaying = () => {
      if (!resolved) {
        resolved = true;
        resolve({ ms: performance.now() - t0, note: "played via MediaSource, appending chunks incrementally" });
      }
    };
    audio.onerror = () => {
      if (!resolved) {
        resolved = true;
        resolve({ ms: -1, note: "MediaSource playback error" });
      }
    };
    mediaSource.addEventListener("sourceopen", async () => {
      const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
      const reader = res.body!.getReader();
      let started = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise<void>((r) => {
          sourceBuffer.addEventListener("updateend", () => r(), { once: true });
          sourceBuffer.appendBuffer(value);
        });
        if (!started) {
          started = true;
          audio.play().catch(() => {});
        }
      }
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore
      }
    });
  });
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

export default function ConversationLabPage() {
  /* ---------------- Recording ---------------- */
  const [silenceThreshold, setSilenceThreshold] = useState(0.02);
  const [silenceDurationMs, setSilenceDurationMs] = useState(2500);
  const [minRecordingMs, setMinRecordingMs] = useState(500);

  const [recState, setRecState] = useState<"idle" | "recording" | "grace" | "stopped">("idle");
  const [liveRms, setLiveRms] = useState(0);
  const [hasSpokenOnce, setHasSpokenOnce] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [silenceMs, setSilenceMs] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [actualSettings, setActualSettings] = useState<string>("(not captured yet)");
  const [graceRemainingMs, setGraceRemainingMs] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const recordingStartAtRef = useRef<number>(0);
  const lastSpeechAtRef = useRef<number>(0);
  const hasSpokenOnceRef = useRef(false);
  const stoppedManuallyRef = useRef(false);
  const graceTimerRef = useRef<number | null>(null);

  const stopMonitorLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const finalizeRecorder = useCallback((thenGoToGrace: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.onstop = () => {
      if (thenGoToGrace) {
        setRecState("grace");
        let remaining = 3000;
        setGraceRemainingMs(remaining);
        graceTimerRef.current = window.setInterval(() => {
          remaining -= 100;
          setGraceRemainingMs(Math.max(0, remaining));
          if (remaining <= 0) {
            if (graceTimerRef.current) window.clearInterval(graceTimerRef.current);
            // grace period elapsed -> actually finalize now
            const blob = new Blob(segmentsRef.current, { type: mimeTypeRef.current || "audio/webm" });
            setRecordedUrl(URL.createObjectURL(blob));
            setRecState("stopped");
          }
        }, 100);
      } else {
        const blob = new Blob(segmentsRef.current, { type: mimeTypeRef.current || "audio/webm" });
        setRecordedUrl(URL.createObjectURL(blob));
        setRecState("stopped");
      }
    };
    recorder.stop();
  }, []);

  const monitorLoopRef = useRef<() => void>(() => {});

  const monitorLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    const rms = computeRms(data);
    setLiveRms(rms);

    const now = performance.now();
    setElapsedMs(now - recordingStartAtRef.current);

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

    const recordingElapsed = now - recordingStartAtRef.current;
    const silenceElapsed = now - lastSpeechAtRef.current;

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
  }, [silenceThreshold, silenceDurationMs, minRecordingMs, finalizeRecorder]);

  useEffect(() => {
    monitorLoopRef.current = monitorLoop;
  }, [monitorLoop]);

  const unlockedRef = useRef(false);
  const [unlockStatus, setUnlockStatus] = useState<"unknown" | "success" | "failed">("unknown");
  const hiddenAudioRef = useRef<HTMLAudioElement | null>(null);

  const tryUnlockAudio = useCallback(async () => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new Ctx();
      }
      await audioCtxRef.current.resume();

      // Classic "play a silent buffer" unlock hack
      const buffer = audioCtxRef.current.createBuffer(1, 1, 22050);
      const source = audioCtxRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtxRef.current.destination);
      source.start(0);

      // Also get autoplay permission for the <audio> element, within the same gesture
      if (hiddenAudioRef.current) {
        try {
          await hiddenAudioRef.current.play();
          hiddenAudioRef.current.pause();
          hiddenAudioRef.current.currentTime = 0;
        } catch {
          // ignore; the AudioContext unlock result is what we report
        }
      }

      const ok = audioCtxRef.current.state === "running";
      unlockedRef.current = ok;
      setUnlockStatus(ok ? "success" : "failed");
    } catch (e) {
      console.error("unlock failed:", e);
      unlockedRef.current = false;
      setUnlockStatus("failed");
    }
  }, []);

  const startRecording = useCallback(async () => {
    setRecordingError(null);

    // Always try iOS unlock on the first tap of the record button
    await tryUnlockAudio();

    stoppedManuallyRef.current = false;
    setRecordedUrl(null);
    setHasSpokenOnce(false);
    hasSpokenOnceRef.current = false;
    setSilenceMs(0);
    setElapsedMs(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
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
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
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
      setRecordingError(`❌ Recording error: ${String((e as ErrorEvent).error ?? e)}`);
    };
    recorderRef.current = recorder;
    recorder.start();

    setActualSettings(
      `MediaRecorder.mimeType (applied): ${recorder.mimeType || "(unknown)"}\n` +
        `Requested: channelCount=1, sampleRate=16000\n` +
        `track.getSettings(): ${JSON.stringify(settings, null, 2)}`
    );

    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = audioCtxRef.current ?? new Ctx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setRecordingError(
        `⚠️ Failed to initialize the AudioContext used for silence detection (${err.name}: ${err.message}). ` +
          `Recording will continue, but auto-stop won't work. Please stop manually.`
      );
    }

    recordingStartAtRef.current = performance.now();
    lastSpeechAtRef.current = performance.now();
    setRecState("recording");
    rafRef.current = requestAnimationFrame(() => monitorLoopRef.current());
  }, [tryUnlockAudio]);

  const stopManually = useCallback(() => {
    stoppedManuallyRef.current = true;
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
    recordingStartAtRef.current = performance.now();
    lastSpeechAtRef.current = performance.now();
    setRecState("recording");
    rafRef.current = requestAnimationFrame(() => monitorLoopRef.current());
  }, []);

  useEffect(() => {
    return () => {
      stopMonitorLoop();
      if (graceTimerRef.current) window.clearInterval(graceTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* ---------------- iOS unlock: delayed playback test ---------------- */
  const [delayedPlayResult, setDelayedPlayResult] = useState<string>("(not run yet)");
  const testDelayedAutoplay = useCallback(() => {
    setDelayedPlayResult("Trying to play in 3 seconds… (don't tap anything during this time)");
    window.setTimeout(async () => {
      try {
        // This play() call is NOT triggered by a user gesture (it's from setTimeout)
        const audio = new Audio(
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        );
        await audio.play();
        setDelayedPlayResult("✅ Success: played without a user gesture (unlock is working)");
      } catch (e) {
        setDelayedPlayResult(
          `❌ Failed: ${e instanceof Error ? e.message : String(e)} (unlock isn't working / browser blocked it)`
        );
      }
    }, 3000);
  }, []);

  /* ---------------- 3. TTS comparison across 3 methods ---------------- */
  type TtsResult = { method: string; format: string; text: string; ms: number };
  const [ttsResults, setTtsResults] = useState<TtsResult[]>([]);
  const [ttsRunning, setTtsRunning] = useState(false);
  const [streamFormat, setStreamFormat] = useState<"pcm" | "wav" | "mp3">("pcm");

  const runTtsComparison = async () => {
    setTtsRunning(true);
    const results: TtsResult[] = [];
    const texts: { label: string; text: string }[] = [
      { label: "short", text: SHORT_TEXT },
      { label: "long", text: LONG_TEXT },
    ];

    for (const { label, text } of texts) {
      for (let i = 0; i < 5; i++) {
        const ms = await measureWebSpeech(text);
        results.push({ method: "A. Web Speech", format: "-", text: label, ms });
        window.speechSynthesis.cancel();
        await new Promise((r) => setTimeout(r, 300));
      }
      for (let i = 0; i < 5; i++) {
        const ms = await measureBulk(text);
        results.push({ method: "B. OpenAI bulk", format: "mp3", text: label, ms });
      }
      for (let i = 0; i < 5; i++) {
        if (streamFormat === "mp3") {
          const { ms, note } = await measureStreamingMp3(text);
          results.push({ method: `C. Streaming (${note})`, format: "mp3", text: label, ms });
        } else {
          const ms = await measureStreamingPcmLike(text, streamFormat);
          results.push({ method: "C. Streaming", format: streamFormat, text: label, ms });
        }
      }
      setTtsResults([...results]);
    }
    setTtsRunning(false);
  };

  /* ---------------- 4. Voice list ---------------- */
  type VoiceInfo = { name: string; lang: string; localService: boolean };
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    const load = () => {
      const list = window.speechSynthesis
        .getVoices()
        .map((v) => ({ name: v.name, lang: v.lang, localService: v.localService }));
      setVoices(list);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    // Some browsers never fire onvoiceschanged, so also poll for a while
    const interval = window.setInterval(load, 1000);
    window.setTimeout(() => window.clearInterval(interval), 5000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);
  const jaVoices = voices.filter((v) => v.lang.toLowerCase().startsWith("ja"));

  /* ------------------------------------------------------------------ */
  return (
    <div
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: 16,
        color: "#111111",
        background: "#ffffff",
        minHeight: "100vh",
        colorScheme: "light",
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Conversation Lab (verification only, not public)</h1>
      <p style={{ fontSize: 12, color: "#888", marginBottom: 20 }}>
        Not connected to any production feature. No DB writes.
      </p>

      {/* ---------------- 1. Recording ---------------- */}
      <div style={section}>
        <div style={h2}>1. Recording (auto-stop on silence)</div>

        <div style={row}>
          <label>
            Silence threshold (RMS): {silenceThreshold.toFixed(3)}
            <input
              type="range"
              min={0.002}
              max={0.15}
              step={0.002}
              value={silenceThreshold}
              onChange={(e) => setSilenceThreshold(Number(e.target.value))}
              style={{ marginLeft: 8 }}
            />
          </label>
        </div>
        <div style={row}>
          <label>
            Silence duration to stop (ms):
            <input
              type="number"
              value={silenceDurationMs}
              onChange={(e) => setSilenceDurationMs(Number(e.target.value))}
              style={{ width: 80, marginLeft: 8 }}
            />
          </label>
          <label>
            Minimum recording (ms):
            <input
              type="number"
              value={minRecordingMs}
              onChange={(e) => setMinRecordingMs(Number(e.target.value))}
              style={{ width: 80, marginLeft: 8 }}
            />
          </label>
        </div>

        <div style={row}>
          <button
            onClick={startRecording}
            disabled={recState === "recording" || recState === "grace"}
            style={{
              width: 100,
              height: 100,
              borderRadius: "50%",
              background: recState === "recording" ? "#e53935" : "#4caf50",
              color: "white",
              fontSize: 15,
              border: "none",
            }}
          >
            {recState === "recording" ? "Recording" : "Tap to record"}
          </button>
          {(recState === "recording" || recState === "grace") && (
            <button onClick={stopManually} style={{ padding: "8px 16px" }}>
              Stop manually
            </button>
          )}
          {recState === "grace" && (
            <button onClick={continueSpeaking} style={{ padding: "8px 16px", background: "#ffb300" }}>
              Keep talking ({Math.ceil(graceRemainingMs / 100) / 10}s left)
            </button>
          )}
        </div>

        {recordingError && (
          <div
            style={{
              background: "#fdecea",
              color: "#611a15",
              border: "1px solid #f5c6cb",
              borderRadius: 4,
              padding: 8,
              marginBottom: 8,
              fontSize: 13,
            }}
          >
            {recordingError}
          </div>
        )}

        <div style={mono}>
          state: {recState} / hasSpokenOnce: {String(hasSpokenOnce)} / elapsed: {elapsedMs.toFixed(0)}ms /
          silence: {silenceMs.toFixed(0)}ms{"\n"}
          liveRms: {liveRms.toFixed(4)}{" "}
          {"[" + "#".repeat(Math.min(40, Math.round(liveRms * 200))) + "]"}
        </div>

        {recordedUrl && (
          <div style={{ marginTop: 8 }}>
            <div>Recorded audio playback:</div>
            <audio controls src={recordedUrl} />
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <div>Actual MediaRecorder / track settings:</div>
          <div style={mono}>{actualSettings}</div>
        </div>
      </div>

      {/* ---------------- 2. iOS unlock ---------------- */}
      <div style={section}>
        <div style={h2}>2. iOS audio unlock</div>
        <p style={{ fontSize: 12 }}>
          The first tap on the record button (section above) automatically attempts an unlock.
          Result: <b>{unlockStatus}</b>
        </p>
        <audio ref={hiddenAudioRef} src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" />
        <button onClick={testDelayedAutoplay} style={{ padding: "8px 16px" }}>
          After unlock, try playing without a gesture in 3s
        </button>
        <div style={mono}>{delayedPlayResult}</div>
      </div>

      {/* ---------------- 3. TTS comparison ---------------- */}
      <div style={section}>
        <div style={h2}>3. TTS comparison across 3 methods (5 runs x 2 texts)</div>
        <div style={row}>
          <label>
            Streaming format:
            <select
              value={streamFormat}
              onChange={(e) => setStreamFormat(e.target.value as "pcm" | "wav" | "mp3")}
              style={{ marginLeft: 8 }}
            >
              <option value="pcm">pcm (recommended)</option>
              <option value="wav">wav</option>
              <option value="mp3">mp3 (MediaSource, falls back if unsupported)</option>
            </select>
          </label>
          <button onClick={runTtsComparison} disabled={ttsRunning} style={{ padding: "8px 16px" }}>
            {ttsRunning ? "Running..." : "Run comparison"}
          </button>
        </div>
        <div style={mono}>
          {ttsResults.length === 0
            ? "(not run yet)"
            : ttsResults
                .map((r) => `${r.method.padEnd(10)} [${r.format}] ${r.text}: ${r.ms.toFixed(0)}ms`)
                .join("\n")}
        </div>
      </div>

      {/* ---------------- 4. Voice list ---------------- */}
      <div style={section}>
        <div style={h2}>4. speechSynthesis.getVoices() list</div>
        <p style={{ fontWeight: "bold", color: jaVoices.length > 0 ? "green" : "red", fontSize: 16 }}>
          Japanese voices (lang starts with &quot;ja&quot;): {jaVoices.length}
        </p>
        <div style={mono}>
          {voices.length === 0
            ? "(loading... if this stays at 0, there may genuinely be none)"
            : voices
                .map((v) => `${v.lang.padEnd(8)} ${v.name}  localService=${v.localService}`)
                .join("\n")}
        </div>
      </div>
    </div>
  );
}

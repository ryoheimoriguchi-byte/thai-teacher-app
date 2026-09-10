"use client";

/**
 * Step C1: 録音・音声再生の検証専用ページ。
 *
 * 本番機能には一切つながない。ナビゲーションからリンクしない
 * （直接 URL を叩いたときだけ到達できる）。DB には書き込まない。
 *
 * 検証項目:
 *   1. 録音の自動停止（無音検出）
 *   2. iOS 音声アンロック
 *   3. TTS 3方式（Web Speech / OpenAI一括 / OpenAIストリーミング）比較
 *   4. speechSynthesis.getVoices() の一覧（日本語音声の有無）
 *   5. MediaRecorder の実際の設定値
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { speak } from "@/app/lib/tts";

/* ------------------------------------------------------------------ */
/* 共通スタイル（デザインに凝らない）                                    */
/* ------------------------------------------------------------------ */

const section: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: 16,
  marginBottom: 20,
};
const h2: React.CSSProperties = { fontSize: 16, fontWeight: "bold", marginBottom: 8 };
const mono: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  background: "#f5f5f5",
  padding: 8,
  borderRadius: 4,
};
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 };

/* ------------------------------------------------------------------ */
/* 1. 録音（無音検出による自動停止）                                     */
/* ------------------------------------------------------------------ */

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
    // 念のためのタイムアウト
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

// PCM/WAV: raw サンプルを Web Audio API で順次スケジューリング再生（真のチャンク再生）
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
  let headerSkipped = format === "pcm"; // pcmはヘッダ無し
  let leftover: Uint8Array = new Uint8Array(0);
  let nextStartTime = 0;
  let firstSoundMs: number | null = null;

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk: Uint8Array = value;

    if (!headerSkipped) {
      // WAV: 先頭44バイトの標準 PCM ヘッダをパースしてスキップ
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

    // 16bit PCM は 2 バイト単位。奇数バイトが余ったら次回に持ち越す
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
      nextStartTime = ctx.currentTime + 0.03; // わずかな先読みマージン
      firstSoundMs = performance.now() - t0;
    }
    source.start(nextStartTime);
    nextStartTime += audioBuffer.duration;
  }

  return firstSoundMs ?? -1;
}

// MP3ストリーミング: MediaSource が使えれば真の逐次再生、使えなければ全受信後に再生（その旨を明記）
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
    // フォールバック: 全部読み切ってから再生（本当のストリーミングではない）
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
    return { ms, note: "MSE非対応のため全受信後に再生（真のストリーミングではない）" };
  }

  return await new Promise((resolve) => {
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);
    let resolved = false;
    audio.onplaying = () => {
      if (!resolved) {
        resolved = true;
        resolve({ ms: performance.now() - t0, note: "MediaSourceで逐次appendしながら再生" });
      }
    };
    audio.onerror = () => {
      if (!resolved) {
        resolved = true;
        resolve({ ms: -1, note: "MediaSource再生エラー" });
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
  return ""; // ブラウザ既定に任せる
}

export default function ConversationLabPage() {
  /* ---------------- 録音 ---------------- */
  const [silenceThreshold, setSilenceThreshold] = useState(0.02);
  const [silenceDurationMs, setSilenceDurationMs] = useState(2500);
  const [minRecordingMs, setMinRecordingMs] = useState(500);

  const [recState, setRecState] = useState<"idle" | "recording" | "grace" | "stopped">("idle");
  const [liveRms, setLiveRms] = useState(0);
  const [hasSpokenOnce, setHasSpokenOnce] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [silenceMs, setSilenceMs] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [actualSettings, setActualSettings] = useState<string>("(未取得)");
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
            // grace 期間終了 → 本当に確定
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

      // 無音バッファを再生する古典的な unlock ハック
      const buffer = audioCtxRef.current.createBuffer(1, 1, 22050);
      const source = audioCtxRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtxRef.current.destination);
      source.start(0);

      // <audio> 要素側の自動再生許可も同じジェスチャー内で得る
      if (hiddenAudioRef.current) {
        try {
          await hiddenAudioRef.current.play();
          hiddenAudioRef.current.pause();
          hiddenAudioRef.current.currentTime = 0;
        } catch {
          // 無視。AudioContext 側の unlock 結果を優先して判定する
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

    // iOS unlock は録音ボタンの最初のタップで必ず実行する
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
        `❌ マイクにアクセスできませんでした（${err.name}: ${err.message}）。` +
          `ブラウザの設定でマイク権限を許可してから、もう一度タップしてください。`
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
      setRecordingError(`❌ MediaRecorder の初期化に失敗しました（${err.name}: ${err.message}）`);
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecState("idle");
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) segmentsRef.current.push(e.data);
    };
    recorder.onerror = (e) => {
      setRecordingError(`❌ 録音中にエラーが発生しました: ${String((e as ErrorEvent).error ?? e)}`);
    };
    recorderRef.current = recorder;
    recorder.start();

    setActualSettings(
      `MediaRecorder.mimeType(適用): ${recorder.mimeType || "(不明)"}\n` +
        `要求: channelCount=1, sampleRate=16000\n` +
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
        `⚠️ 無音検出用の AudioContext 初期化に失敗しました（${err.name}: ${err.message}）。` +
          `録音自体は続行されますが、自動停止は機能しません。手動で停止してください。`
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

    hasSpokenOnceRef.current = false; // 続きの発話でもう一度「発話検出→無音判定」からやり直す
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

  /* ---------------- iOS unlock: 遅延再生テスト ---------------- */
  const [delayedPlayResult, setDelayedPlayResult] = useState<string>("(未実行)");
  const testDelayedAutoplay = useCallback(() => {
    setDelayedPlayResult("3秒後に再生を試みます…（この間ボタン等は押さないでください）");
    window.setTimeout(async () => {
      try {
        // ここでの play() 呼び出しはユーザー操作を伴わない（setTimeout経由）
        const audio = new Audio(
          "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
        );
        await audio.play();
        setDelayedPlayResult("✅ 成功: ユーザー操作なしで再生できた（unlock有効）");
      } catch (e) {
        setDelayedPlayResult(
          `❌ 失敗: ${e instanceof Error ? e.message : String(e)}（unlockが効いていない/ブラウザに拒否された）`
        );
      }
    }, 3000);
  }, []);

  /* ---------------- 2. TTS 3方式比較 ---------------- */
  type TtsResult = { method: string; format: string; text: string; ms: number };
  const [ttsResults, setTtsResults] = useState<TtsResult[]>([]);
  const [ttsRunning, setTtsRunning] = useState(false);
  const [streamFormat, setStreamFormat] = useState<"pcm" | "wav" | "mp3">("pcm");

  const runTtsComparison = async () => {
    setTtsRunning(true);
    const results: TtsResult[] = [];
    const texts: { label: string; text: string }[] = [
      { label: "短い", text: SHORT_TEXT },
      { label: "長め", text: LONG_TEXT },
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
        results.push({ method: "B. OpenAI一括", format: "mp3", text: label, ms });
      }
      for (let i = 0; i < 5; i++) {
        if (streamFormat === "mp3") {
          const { ms, note } = await measureStreamingMp3(text);
          results.push({ method: `C. ストリーミング (${note})`, format: "mp3", text: label, ms });
        } else {
          const ms = await measureStreamingPcmLike(text, streamFormat);
          results.push({ method: "C. ストリーミング", format: streamFormat, text: label, ms });
        }
      }
      setTtsResults([...results]);
    }
    setTtsRunning(false);
  };

  /* ---------------- 4. 音声一覧 ---------------- */
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
    // 一部ブラウザは onvoiceschanged が発火しないことがあるためポーリングも併用
    const interval = window.setInterval(load, 1000);
    window.setTimeout(() => window.clearInterval(interval), 5000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);
  const jaVoices = voices.filter((v) => v.lang.toLowerCase().startsWith("ja"));

  /* ------------------------------------------------------------------ */
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 16, color: "#111" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Conversation Lab（検証専用・非公開）</h1>
      <p style={{ fontSize: 12, color: "#888", marginBottom: 20 }}>
        本番機能には接続していません。DBへの書き込みもありません。
      </p>

      {/* ---------------- 1. 録音 ---------------- */}
      <div style={section}>
        <div style={h2}>1. 録音（無音検出で自動停止）</div>

        <div style={row}>
          <label>
            無音判定の閾値(RMS): {silenceThreshold.toFixed(3)}
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
            無音継続で停止(ms):
            <input
              type="number"
              value={silenceDurationMs}
              onChange={(e) => setSilenceDurationMs(Number(e.target.value))}
              style={{ width: 80, marginLeft: 8 }}
            />
          </label>
          <label>
            最低録音時間(ms):
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
              fontSize: 16,
              border: "none",
            }}
          >
            {recState === "recording" ? "録音中" : "タップで\n録音開始"}
          </button>
          {(recState === "recording" || recState === "grace") && (
            <button onClick={stopManually} style={{ padding: "8px 16px" }}>
              手動で停止
            </button>
          )}
          {recState === "grace" && (
            <button onClick={continueSpeaking} style={{ padding: "8px 16px", background: "#ffb300" }}>
              まだ はなす（残り{Math.ceil(graceRemainingMs / 100) / 10}秒）
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
            <div>録音結果の再生:</div>
            <audio controls src={recordedUrl} />
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <div>MediaRecorder / トラックの実際の設定値:</div>
          <div style={mono}>{actualSettings}</div>
        </div>
      </div>

      {/* ---------------- 2. iOS unlock ---------------- */}
      <div style={section}>
        <div style={h2}>2. iOS 音声アンロック</div>
        <p style={{ fontSize: 12 }}>
          録音ボタン（上のセクション）の最初のタップで自動的に unlock を試みています。
          結果: <b>{unlockStatus}</b>
        </p>
        <audio ref={hiddenAudioRef} src="data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" />
        <button onClick={testDelayedAutoplay} style={{ padding: "8px 16px" }}>
          unlock後・3秒後にユーザー操作なしで再生を試す
        </button>
        <div style={mono}>{delayedPlayResult}</div>
      </div>

      {/* ---------------- 3. TTS比較 ---------------- */}
      <div style={section}>
        <div style={h2}>3. TTS 3方式比較（各5回×2テキスト）</div>
        <div style={row}>
          <label>
            ストリーミング方式のフォーマット:
            <select
              value={streamFormat}
              onChange={(e) => setStreamFormat(e.target.value as "pcm" | "wav" | "mp3")}
              style={{ marginLeft: 8 }}
            >
              <option value="pcm">pcm（推奨）</option>
              <option value="wav">wav</option>
              <option value="mp3">mp3（MediaSource、非対応ならフォールバック）</option>
            </select>
          </label>
          <button onClick={runTtsComparison} disabled={ttsRunning} style={{ padding: "8px 16px" }}>
            {ttsRunning ? "計測中..." : "3方式を計測開始"}
          </button>
        </div>
        <div style={mono}>
          {ttsResults.length === 0
            ? "(未実行)"
            : ttsResults
                .map((r) => `${r.method.padEnd(10)} [${r.format}] ${r.text}: ${r.ms.toFixed(0)}ms`)
                .join("\n")}
        </div>
      </div>

      {/* ---------------- 4. 音声一覧 ---------------- */}
      <div style={section}>
        <div style={h2}>4. speechSynthesis.getVoices() 一覧</div>
        <p style={{ fontWeight: "bold", color: jaVoices.length > 0 ? "green" : "red", fontSize: 16 }}>
          日本語音声(lang starts with &quot;ja&quot;): {jaVoices.length} 件
        </p>
        <div style={mono}>
          {voices.length === 0
            ? "(読み込み中... 0件のままなら本当に無い可能性があります)"
            : voices
                .map((v) => `${v.lang.padEnd(8)} ${v.name}  localService=${v.localService}`)
                .join("\n")}
        </div>
      </div>
    </div>
  );
}

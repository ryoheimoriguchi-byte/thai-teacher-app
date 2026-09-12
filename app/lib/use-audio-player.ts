/**
 * Button-triggered TTS playback hook for the Conversation feature.
 *
 * iOS Safari cannot autoplay audio (verified in Step C1's conversation-lab
 * page: AudioContext unlock, delayed <audio> playback, and delayed
 * speechSynthesis playback all failed once a real async delay was
 * introduced). So playback here is ALWAYS triggered directly by a user tap
 * (the 🔊 button) — never automatically. Because the tap itself is the
 * gesture, no unlock hack is needed; a normal AudioContext + scheduled
 * buffers started synchronously within the click handler works.
 *
 * This hook is the ONLY place that starts playback, so if autoplay ever
 * becomes viable (see T-24), only this file needs to change.
 *
 * Client-only. Must be called from a component with "use client".
 */

import { useCallback, useRef, useState } from "react";

export type PlaybackState = "idle" | "loading" | "playing" | "error";

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function useAudioPlayer() {
  const [state, setState] = useState<PlaybackState>("idle");
  const [error, setError] = useState<string | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const generationRef = useRef(0);

  /**
   * Play `text` via the OpenAI pcm-streaming TTS route. Must be called
   * directly inside a click/tap handler (a real user gesture) — that is
   * what makes playback work on iOS Safari.
   */
  const play = useCallback(async (text: string) => {
    const myGeneration = ++generationRef.current;

    // Stop any currently-playing audio from a previous tap before starting new audio.
    activeSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already stopped/ended
      }
    });
    activeSourcesRef.current = [];

    setState("loading");
    setError(null);

    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      // This is called synchronously within the tap handler's call stack (the
      // caller must not await anything before calling play()), so this resume()
      // happens within the user gesture — no separate "unlock" step is needed.
      ctx.resume().catch(() => {});

      const res = await fetch("/api/conversation/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, stream: true, format: "pcm" }),
      });
      if (myGeneration !== generationRef.current) return; // superseded by a newer tap
      if (!res.ok || !res.body) {
        throw new Error(`TTS request failed (status ${res.status})`);
      }

      const sampleRate = 24000; // OpenAI pcm format: 16-bit signed LE, 24kHz, mono
      let leftover: Uint8Array = new Uint8Array(0);
      let nextStartTime = 0;
      let scheduledAny = false;

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (myGeneration !== generationRef.current) return; // superseded by a newer tap
        if (done) break;

        let chunk: Uint8Array = value as Uint8Array;
        if (leftover.length > 0) {
          chunk = concatBytes(leftover, chunk);
          leftover = new Uint8Array(0);
        }

        // 16-bit PCM comes in 2-byte units; carry an odd trailing byte to the next chunk.
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
        const audioBuffer = ctx.createBuffer(1, sampleCount, sampleRate);
        const channelData = audioBuffer.getChannelData(0);
        for (let i = 0; i < sampleCount; i++) {
          channelData[i] = dataView.getInt16(i * 2, true) / 32768;
        }

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);

        if (!scheduledAny) setState("playing");

        // Clamp to "now" whenever nextStartTime has fallen behind real time
        // (the first chunk always falls in this branch since nextStartTime
        // starts at 0). Scheduling source.start() with a time that has
        // already passed does NOT resume mid-buffer — the browser starts it
        // immediately from the beginning, which overlaps with whatever
        // previous chunk is still audibly playing. That overlap is what
        // caused the echo/doubling reported at the start of playback,
        // since early chunks are the most likely to arrive slower than
        // real-time due to network/decode warm-up.
        const now = ctx.currentTime;
        if (nextStartTime < now + 0.01) {
          nextStartTime = now + 0.03; // small lookahead margin
        }
        source.start(nextStartTime);
        nextStartTime += audioBuffer.duration;
        activeSourcesRef.current.push(source);
        scheduledAny = true;
      }

      if (!scheduledAny) {
        if (myGeneration === generationRef.current) setState("idle");
        return;
      }

      const remainingMs = Math.max(0, (nextStartTime - ctx.currentTime) * 1000);
      window.setTimeout(() => {
        if (myGeneration === generationRef.current) setState("idle");
      }, remainingMs + 50);
    } catch (e) {
      if (myGeneration === generationRef.current) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    }
  }, []);

  return { state, error, play };
}

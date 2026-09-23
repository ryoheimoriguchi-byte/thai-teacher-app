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
 * Step C4.1: this now shares ONE AudioContext with the recorder's
 * silence-detection AnalyserNode (see audio-context.ts) rather than owning
 * its own — a real-device bug (tutor's first line had no sound on Listen
 * until after the first recording) traced partly to these being two
 * separate AudioContext instances. See audio-context.ts's doc comment for
 * the full investigation.
 *
 * Client-only. Must be called from a component with "use client".
 */

import { useCallback, useRef, useState } from "react";
import { unlockAudio, logAudioDebug } from "./audio-context";

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
      // Must be called synchronously here, before the `await fetch()` below
      // — see audio-context.ts's unlockAudio() doc comment for why resume()
      // alone (the old implementation here) isn't always enough on iOS
      // Safari, and why this needs to happen inside the tap's synchronous
      // call stack (the caller of play() must not await anything first).
      const ctx = unlockAudio();

      const res = await fetch("/api/conversation/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, stream: true, format: "pcm" }),
      });
      if (myGeneration !== generationRef.current) return; // superseded by a newer tap
      logAudioDebug(`play(): TTS fetch responded status=${res.status} ok=${res.ok} hasBody=${Boolean(res.body)}`);
      if (!res.ok || !res.body) {
        throw new Error(`TTS request failed (status ${res.status})`);
      }

      const sampleRate = 24000; // OpenAI pcm format: 16-bit signed LE, 24kHz, mono
      let leftover: Uint8Array = new Uint8Array(0);
      let nextStartTime = 0;
      let scheduledAny = false;
      // Investigation items 7/8: previously there was no way to tell, from
      // a real device, whether the stream actually delivered bytes or
      // whether the scheduled buffer sources ever finished playing.
      let totalBytesReceived = 0;
      let chunksScheduled = 0;
      let chunksEnded = 0;
      let streamDone = false;

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (myGeneration !== generationRef.current) return; // superseded by a newer tap
        if (done) break;
        totalBytesReceived += value.byteLength;

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
        chunksScheduled++;
        source.onended = () => {
          chunksEnded++;
          // Only log once, when every scheduled chunk (for this generation,
          // i.e. not superseded by a newer tap) has actually finished
          // playing — confirms the output path was live end-to-end, not
          // just that start() was called (investigation item 8).
          if (myGeneration === generationRef.current && streamDone && chunksEnded === chunksScheduled) {
            logAudioDebug(`play(): all ${chunksScheduled} chunk(s) finished (onended) at ctx.currentTime=${ctx.currentTime.toFixed(3)}`);
          }
        };

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
        if (!scheduledAny) {
          // Investigation item 6/7 follow-up: confirms the AudioContext's
          // clock is actually advancing (a suspended/dead context would
          // show ctx.currentTime frozen across taps) and that a real,
          // non-empty buffer was decoded from the TTS response.
          logAudioDebug(
            `play(): first chunk scheduled at ctx.currentTime=${now.toFixed(3)} startAt=${nextStartTime.toFixed(3)} bufferDuration=${audioBuffer.duration.toFixed(3)}`
          );
        }
        source.start(nextStartTime);
        nextStartTime += audioBuffer.duration;
        activeSourcesRef.current.push(source);
        scheduledAny = true;
      }
      streamDone = true;

      logAudioDebug(`play(): stream ended, totalBytesReceived=${totalBytesReceived}, chunksScheduled=${chunksScheduled}`);

      if (!scheduledAny) {
        if (myGeneration === generationRef.current) setState("idle");
        return;
      }

      const remainingMs = Math.max(0, (nextStartTime - ctx.currentTime) * 1000);
      window.setTimeout(() => {
        if (myGeneration === generationRef.current) setState("idle");
      }, remainingMs + 50);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logAudioDebug(`play(): failed: ${message}`);
      if (myGeneration === generationRef.current) {
        setError(message);
        setState("error");
      }
    }
  }, []);

  return { state, error, play };
}

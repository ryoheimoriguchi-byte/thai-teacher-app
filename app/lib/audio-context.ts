/**
 * App-wide singleton AudioContext, shared between TTS playback
 * (use-audio-player.ts) and the recorder's silence-detection AnalyserNode
 * (use-recorder.ts).
 *
 * Background (Step C4.1, real iPhone Safari bug): the tutor's first line
 * had no sound on Listen right after entering the conversation screen, but
 * started working after the first recording. Investigation found two
 * contributing issues:
 *   1. use-recorder.ts kept its OWN separate AudioContext (for the
 *      silence-detection AnalyserNode), entirely disconnected from the one
 *      use-audio-player.ts uses for playback.
 *   2. Even with a single shared context, calling resume() alone isn't
 *      reliable: iOS Safari can auto-suspend an already-"running" context
 *      when a native permission dialog (e.g. getUserMedia's mic prompt)
 *      interrupts the page. After that, ctx.state still reads "running" at
 *      the JS level, so a later resume() call is a no-op — but the actual
 *      output path is dead. Actually starting a real (silent) buffer
 *      source forces the output path back up regardless of what ctx.state
 *      claims, which resume() alone does not guarantee.
 *
 * Client-only. Must be called from code that only runs in the browser.
 */

let ctx: AudioContext | null = null;

/** The one AudioContext for the whole app. Created lazily, on first use. */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
  }
  return ctx;
}

/**
 * Call SYNCHRONOUSLY at the very top of every tap handler that needs audio
 * to work afterwards — Start, Listen, the mic/record button, "Try again" —
 * before any `await` in that handler. Must not be awaited before it runs;
 * the calls inside it (resume(), source.start()) need to happen within the
 * synchronous call stack of the user gesture for iOS Safari to honor them.
 *
 * Does two things, both belt-and-braces for the same goal (see the doc
 * comment above on why resume() alone isn't always enough):
 *   1. ctx.resume()
 *   2. Actually starts a real (1-sample, silent) buffer source. This is
 *      the "actually play something" unlock trick — it works whether or
 *      not the resume()-alone theory was the real cause, so it's kept as
 *      insurance either way.
 *
 * Cheap and inaudible; safe to call on every single tap, not just the
 * first one per session.
 */
export function unlockAudio(): AudioContext {
  const audioCtx = getAudioContext();
  audioCtx.resume().catch(() => {
    // best-effort; the silent-buffer trick below still runs regardless
  });
  try {
    const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch {
    // best-effort — if this throws, the resume() call above is still in flight
  }
  return audioCtx;
}

/**
 * NEVER call audioCtx.close() anywhere in this app. Recording and playback
 * share this one context — closing it from either side would permanently
 * kill audio for the other for the rest of the page's lifetime (e.g. "the
 * mic works but the tutor's voice goes silent forever after one
 * recording"). Recorder cleanup must stop at disconnect()ing its nodes and
 * stopping the MediaStream's tracks — see use-recorder.ts.
 */

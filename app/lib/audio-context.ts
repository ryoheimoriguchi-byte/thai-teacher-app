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

/**
 * Step C4.2 (re-investigation, 2026-09-23): the previous unlockAudio() fix
 * (this file) did NOT resolve the real-device bug on its own — the tutor's
 * first Listen after entering the conversation screen still sometimes had
 * no sound. Investigation items 6/7/8 in the instructions this was built
 * from turned out to be *unanswerable* with the code as it stood: every
 * failure path here and in use-audio-player.ts's play() silently swallowed
 * its own error, so there was no way to tell, from a real device, whether
 * unlockAudio() itself was throwing, whether the TTS fetch was failing, or
 * whether playback nodes were actually completing.
 *
 * This logger is purely observational — it changes NO behavior, only adds
 * visibility into ?debug=1's timing log. use-audio-player.ts also reports
 * through it (fetch byte counts, onended, ctx.currentTime/buffer duration)
 * so all audio-pipeline diagnostics land in one place. The page registers
 * itself as the sink (see app/conversation/page.tsx) via
 * setAudioDebugLogger(); logAudioDebug() is a no-op before that happens
 * (e.g. if this module is ever used outside the conversation page).
 */
type AudioDebugLogger = (msg: string) => void;
let debugLogger: AudioDebugLogger | null = null;

/** Registers (or clears, with null) the sink for logAudioDebug() below. */
export function setAudioDebugLogger(fn: AudioDebugLogger | null): void {
  debugLogger = fn;
}

/** Used by this file and use-audio-player.ts to report into ?debug=1's log. */
export function logAudioDebug(msg: string): void {
  debugLogger?.(msg);
}

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
  audioCtx.resume().catch((e: unknown) => {
    // best-effort; the silent-buffer trick below still runs regardless —
    // but log it, since a rejection here was previously invisible.
    logAudioDebug(`unlockAudio: resume() rejected: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    const buf = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) {
    // best-effort — if this throws, the resume() call above is still in
    // flight. Previously silent; now logged (investigation item 6).
    logAudioDebug(`unlockAudio: silent buffer start() threw: ${e instanceof Error ? e.message : String(e)}`);
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

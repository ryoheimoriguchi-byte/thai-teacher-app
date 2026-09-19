/**
 * Wraps fetch() with a hard timeout via AbortController.
 *
 * Added after a real-device bug: a plain `fetch()` with no timeout can hang
 * indefinitely if the network stalls or the server never responds — leaving
 * the conversation UI stuck on "Listening..."/"The teacher is thinking..."
 * forever, with no way out for the child except closing the tab. Every
 * conversation API call must go through this so a stuck network call always
 * eventually turns into a catchable error (which the UI already knows how
 * to recover from: "Try again" / "End conversation").
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

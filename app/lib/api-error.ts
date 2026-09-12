/**
 * Small helper for API route catch blocks.
 *
 * Supabase's PostgrestError (and some other error-like objects) do NOT
 * extend the built-in Error class, so `error instanceof Error` is false for
 * them and their real `.message` was being silently swallowed into a
 * generic "Unknown error" string in every conversation API route. This
 * made real DB errors impossible to diagnose from the client. Use this
 * helper in catch blocks instead of `error instanceof Error ? error.message
 * : "Unknown error"`.
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

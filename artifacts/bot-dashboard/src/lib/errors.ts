/** Extract a human-friendly message from an API (or any) error. */
export function errMsg(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { data?: { error?: string } | null; message?: string };
    if (e.data?.error) return e.data.error;
    if (e.message) return e.message;
  }
  return String(err);
}

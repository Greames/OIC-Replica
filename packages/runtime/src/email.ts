import type { EngineDeps } from "@oicr/engine";

/**
 * Email for `notify` steps through Resend's API, with the user's own key.
 * Without RESEND_API_KEY and EMAIL_FROM, notify steps are recorded as skipped.
 */
export function emailNotifier(): EngineDeps["notify"] {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return undefined;
  return async ({ to, subject, body }) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text: body }),
    });
    if (!res.ok) {
      const err = new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`) as Error & {
        code: string;
      };
      err.code = "email_failed";
      throw err;
    }
  };
}

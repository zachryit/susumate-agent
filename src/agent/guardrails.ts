// Code-level guardrails (ported from SusuMate's Guardrails.php): egress scrub +
// act-never-pretend. These run on the model's final text before it reaches the user.

const SUCCESS_CLAIMS = [
  'payment started', "i've started", 'i have started', 'contribution started',
  'group created', "i've created", 'i have created',
  'invitation sent', "i've sent", 'i have sent', 'invite sent',
  'vote recorded', "i've recorded", 'i have recorded',
  'code sent', 'sms sent',
];

/** Strip internal identifiers before anything reaches the user. */
export function scrub(text: string, toolNames: string[] = []): string {
  let out = text;
  for (const name of toolNames) {
    if (!name) continue;
    out = replaceAllInsensitive(out, name, 'that action');
  }
  // UUIDs and key-shaped strings never belong in chat.
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{20,})\b/g, '[redacted]');
  return out.trim();
}

/**
 * Act-never-pretend: if the reply claims a completed action but no write tool returned ok=true
 * this turn, replace the claim with a truthful nudge.
 */
export function enforceHonesty(text: string, writeToolSucceeded: boolean): string {
  if (writeToolSucceeded) return text;
  const lower = text.toLowerCase();
  for (const claim of SUCCESS_CLAIMS) {
    if (lower.includes(claim)) {
      return (
        "I wasn't able to complete that action just now. " +
        'Please try again, or use the matching button in the app — nothing has been charged or changed.'
      );
    }
  }
  return text;
}

function replaceAllInsensitive(haystack: string, needle: string, replacement: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return haystack.replace(new RegExp(escaped, 'gi'), replacement);
}

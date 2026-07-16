// Per-user OTP login against SusuMate's existing endpoints:
//   POST /api/auth/request-otp  { phone }
//   POST /api/auth/verify-otp   { phone, code, device_name }  -> { data: { token, user, ... } }
// The returned token is stored (encrypted) per WhatsApp sender and used for all later calls.

import type { SusumateClient } from './client.js';

/** Normalize a phone to E.164 the way SusuMate does (Ghana-first). */
export function toE164(input: string): string {
  let phone = (input ?? '').replace(/[^\d+]/g, '');
  if (phone.startsWith('0')) return '+233' + phone.slice(1);
  if (phone.startsWith('233')) return '+' + phone;
  return phone.startsWith('+') ? phone : '+' + phone;
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

export interface RequestOtpResult {
  ok: boolean;
  message: string;
}

export async function requestOtp(client: SusumateClient, phone: string): Promise<RequestOtpResult> {
  const e164 = toE164(phone);
  if (!isValidE164(e164)) {
    return { ok: false, message: 'That phone number looks off — I need something like +233551234567.' };
  }
  const res = await client.call('POST', 'auth/request-otp', { phone: e164 });
  if (res.ok) {
    return { ok: true, message: `Code sent by SMS to ${e164}. Ask the user to reply with the 6-digit code.` };
  }
  const first = firstError(res.errors);
  return { ok: false, message: first ?? res.message ?? 'Could not send a code to that number right now.' };
}

export interface VerifyOtpResult {
  ok: boolean;
  message: string;
  token?: string;
  userName?: string;
  isNewUser?: boolean;
}

export async function verifyOtp(client: SusumateClient, phone: string, code: string): Promise<VerifyOtpResult> {
  const e164 = toE164(phone);
  const cleanCode = (code ?? '').replace(/\D/g, '');
  if (!isValidE164(e164)) {
    return { ok: false, message: 'I need the phone number again in the form +233551234567.' };
  }
  if (cleanCode.length !== 6) {
    return { ok: false, message: 'The code should be 6 digits — please resend it.' };
  }
  const res = await client.call('POST', 'auth/verify-otp', {
    phone: e164,
    code: cleanCode,
    device_name: 'whatsapp',
  });
  if (!res.ok) {
    const first = firstError(res.errors);
    return { ok: false, message: first ?? res.message ?? 'That code was invalid or expired.' };
  }
  const data = (res.data ?? {}) as { token?: string; is_new_user?: boolean; user?: { name?: string } };
  if (!data.token) {
    return { ok: false, message: 'Signed in, but no session token came back — please try again.' };
  }
  return {
    ok: true,
    message: 'Signed in successfully.',
    token: data.token,
    userName: data.user?.name ?? undefined,
    isNewUser: data.is_new_user ?? undefined,
  };
}

function firstError(errors?: Record<string, string[]>): string | undefined {
  if (!errors) return undefined;
  for (const list of Object.values(errors)) {
    if (Array.isArray(list) && list.length) return list[0];
  }
  return undefined;
}

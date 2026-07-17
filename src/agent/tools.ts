// Tool registry. Builds the AgentTool[] the model may call this turn:
//  - GUEST (not signed in): begin_login + complete_login only.
//  - USER (signed in), private chat: every catalog action as an ApiTool.
//  - USER, group chat: only group-safe read actions (private/money actions need a DM).
//
// Each ApiTool is generated from a catalog entry: it
// substitutes path params, forwards the declared body to the real endpoint via the HTTP client
// (so the user's own validation + authorization applies), enforces the money/destructive
// preview→confirm handshake, and uploads image args.

import type { AgentTool, JsonSchema, ToolExecResult } from './types.js';
import type { SusumateClient, UploadFile } from '../susumate/client.js';
import type { SessionStore, Session } from '../sessions/store.js';
import { CATALOG, type CatalogEntry } from '../susumate/catalog.js';
import { resolveImage, resolveImages } from '../susumate/media.js';
import { requestOtp, verifyOtp } from '../susumate/auth.js';

export interface TurnState {
  writeToolSucceeded: boolean;
  signedInThisTurn: boolean;
}

export interface ToolDeps {
  client: SusumateClient;
  store: SessionStore;
  session: Session;
  groupContext: boolean;
  boundParams: Record<string, string>;
  state: TurnState;
}

/** All tool names Mate could ever use — for the egress scrub. */
export function allToolNames(): string[] {
  return [...Object.keys(CATALOG), 'begin_login', 'complete_login'];
}

export function buildTools(deps: ToolDeps): AgentTool[] {
  const signedIn = deps.store.isSignedIn(deps.session);
  if (!signedIn) {
    // Login is a private-chat flow (OTP by SMS); in a group we stay conversational.
    return deps.groupContext ? [] : buildAuthTools(deps);
  }

  const tools: AgentTool[] = [];
  for (const [key, entry] of Object.entries(CATALOG)) {
    if (deps.groupContext && !entry.group_safe) continue; // group chats: read-only, group-safe only
    if (deps.groupContext && entry.sensitive) continue;
    tools.push(makeApiTool(deps, key, entry));
  }
  return tools;
}

// ── Auth (guest) tools ──────────────────────────────────────────
function buildAuthTools(deps: ToolDeps): AgentTool[] {
  const beginLogin: AgentTool = {
    name: 'begin_login',
    description:
      'Send a 6-digit sign-in code by SMS to the user\'s SusuMate phone number. Only call once they have given a phone number. Convert local 055... to +23355...',
    parameters: {
      type: 'object',
      properties: { phone: { type: 'string', description: 'E.164, e.g. +233551234567' } },
      required: ['phone'],
    },
    async execute(args): Promise<ToolExecResult> {
      const r = await requestOtp(deps.client, String(args.phone ?? ''));
      return { content: JSON.stringify({ ok: r.ok, message: r.message }), isError: !r.ok };
    },
  };

  const completeLogin: AgentTool = {
    name: 'complete_login',
    description:
      'Finish sign-in with the 6-digit code the user received by SMS. Provide the same phone number used for begin_login.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The E.164 phone used for begin_login' },
        code: { type: 'string', description: 'The 6-digit code from the SMS' },
      },
      required: ['phone', 'code'],
    },
    sensitive: true,
    async execute(args): Promise<ToolExecResult> {
      const r = await verifyOtp(deps.client, String(args.phone ?? ''), String(args.code ?? ''));
      if (r.ok && r.token) {
        deps.store.setToken(deps.session, r.token, r.userName);
        deps.state.signedInThisTurn = true;
        deps.state.writeToolSucceeded = true;
      }
      return {
        content: JSON.stringify({
          ok: r.ok,
          message: r.ok ? 'Signed in. You can now help them with their account.' : r.message,
          is_new_user: r.isNewUser ?? undefined,
          name: r.userName ?? undefined,
        }),
        isError: !r.ok,
      };
    },
  };

  return [beginLogin, completeLogin];
}

// ── Catalog action tool ─────────────────────────────────────────
function makeApiTool(deps: ToolDeps, key: string, entry: CatalogEntry): AgentTool {
  return {
    name: key,
    description: entry.summary,
    sensitive: entry.sensitive,
    groupSafe: entry.group_safe,
    parameters: schemaFor(entry, deps.boundParams),
    async execute(args): Promise<ToolExecResult> {
      const token = deps.store.token(deps.session);
      if (!token) {
        return { content: JSON.stringify({ ok: false, message: 'Not signed in.' }), isError: true };
      }

      // Context-bound params win over anything the model supplied (can't be spoofed).
      const merged: Record<string, unknown> = { ...args, ...deps.boundParams };

      // Substitute path params.
      let path = entry.path;
      for (const param of entry.params ?? []) {
        const value = merged[param];
        if (value === undefined || value === null || value === '') {
          return { content: JSON.stringify({ ok: false, message: `I need the ${param} to do that.` }), isError: true };
        }
        path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
      }

      const body = { ...bodyFrom(entry, merged), ...(entry.constants ?? {}) };

      // Money/destructive preview → confirm handshake.
      if (entry.confirm && !truthy(merged.confirm)) {
        return {
          content: JSON.stringify({
            ok: true,
            preview: true,
            message: 'Preview only — nothing done yet. Confirm the details with the user, then call again with confirm=true.',
            summary: body,
          }),
        };
      }

      const files = await filesFrom(entry, merged, deps.session);
      const result = await deps.client.callAs(token, entry.method, path, body, files);

      // 401 → the stored token is dead; sign them out so the next turn re-authenticates.
      if (result.status === 401) {
        deps.store.clear(deps.session);
        return {
          content: JSON.stringify({ ok: false, message: 'The session expired — ask them to sign in again with their phone.' }),
          isError: true,
        };
      }

      if (result.ok && entry.sensitive) {
        deps.state.writeToolSucceeded = true;
      }

      return { content: JSON.stringify(normalize(result)), isError: !result.ok };
    },
  };
}

function schemaFor(entry: CatalogEntry, boundParams: Record<string, string>): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of entry.params ?? []) {
    if (param in boundParams) continue; // context-bound params aren't asked of the model
    properties[param] = { type: 'string', description: `The ${param} id` };
    required.push(param);
  }

  for (const [field, spec] of Object.entries(entry.body ?? {})) {
    properties[field] = spec;
  }

  // Image-by-URL / "attached" fields.
  for (const spec of Object.values(entry.files ?? {})) {
    properties[spec.arg] = spec.multiple
      ? { type: 'array', items: { type: 'string' }, description: 'Public image URLs, or "attached" for a photo the user sent' }
      : { type: 'string', description: 'Public image URL, or "attached" for a photo the user just sent on WhatsApp' };
  }

  for (const field of entry.required ?? []) required.push(field);

  if (entry.confirm) {
    properties.confirm = { type: 'boolean', description: 'false = preview only; true = actually do it (only after the user says yes)' };
    required.push('confirm');
  }

  return {
    type: 'object',
    properties,
    required: [...new Set(required)],
  };
}

function bodyFrom(entry: CatalogEntry, args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of Object.keys(entry.body ?? {})) {
    const v = args[field];
    if (v !== undefined && v !== null && v !== '') body[field] = v;
  }
  return body;
}

async function filesFrom(
  entry: CatalogEntry,
  args: Record<string, unknown>,
  session: Session,
): Promise<Record<string, UploadFile | UploadFile[]>> {
  const files: Record<string, UploadFile | UploadFile[]> = {};
  for (const [field, spec] of Object.entries(entry.files ?? {})) {
    const raw = args[spec.arg];
    if (spec.multiple) {
      const refs = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x));
      const uploads = await resolveImages(refs, session.lastImage);
      if (uploads.length) files[field] = uploads;
    } else if (raw) {
      const up = await resolveImage(String(raw), session.lastImage);
      if (up) files[field] = up;
    }
  }
  return files;
}

function normalize(result: { ok: boolean; data: unknown; message?: string; errors?: Record<string, string[]>; error_code?: string }): Record<string, unknown> {
  if (result.ok) {
    return prune({ ok: true, message: result.message ?? 'Done.', data: result.data ?? null });
  }
  let firstError: string | undefined;
  if (result.errors) {
    for (const list of Object.values(result.errors)) {
      if (Array.isArray(list) && list.length) {
        firstError = list[0];
        break;
      }
    }
  }
  return prune({ ok: false, message: firstError ?? result.message ?? 'That action was not allowed.', error_code: result.error_code });
}

function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

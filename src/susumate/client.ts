// SusuMate API client — the standalone replacement for the embedded InternalApiDispatcher.
// Where the embedded agent dispatched requests in-process through Laravel's router, this makes
// real HTTP calls to the SusuMate API as the user (Bearer token). It returns SusuMate's own
// { data, message, errors, error_code } envelope unchanged so the agent can relay real
// validation messages, and it never throws on 4xx/5xx — it returns { ok: false }.

export interface ApiResult {
  status: number;
  ok: boolean;
  data: unknown;
  message?: string;
  errors?: Record<string, string[]>;
  error_code?: string;
}

export interface UploadFile {
  /** Local file path to stream, or omit and provide `buffer`. */
  path?: string;
  buffer?: Buffer;
  filename: string;
  mime: string;
}

export class SusumateClient {
  constructor(
    private readonly baseUrl: string, // includes /api
    private readonly timeoutMs: number,
  ) {}

  /**
   * Unauthenticated call (e.g. auth/request-otp, auth/verify-otp).
   */
  call(method: string, uri: string, data: Record<string, unknown> = {}): Promise<ApiResult> {
    return this.request(method, uri, data, undefined, {});
  }

  /**
   * Authenticated call as the user. `files` become a multipart body; otherwise JSON.
   */
  callAs(
    token: string,
    method: string,
    uri: string,
    data: Record<string, unknown> = {},
    files: Record<string, UploadFile | UploadFile[]> = {},
  ): Promise<ApiResult> {
    return this.request(method, uri, data, token, files);
  }

  private async request(
    method: string,
    uri: string,
    data: Record<string, unknown>,
    token: string | undefined,
    files: Record<string, UploadFile | UploadFile[]>,
  ): Promise<ApiResult> {
    const m = method.toUpperCase();
    const hasFiles = Object.keys(files).length > 0;
    let url = `${this.baseUrl}/${uri.replace(/^\/+/, '')}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let body: BodyStruct = undefined;

    if (m === 'GET' || m === 'DELETE') {
      const qs = toQuery(data);
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    } else if (hasFiles) {
      body = await buildFormData(data, files);
      // fetch sets the multipart boundary Content-Type automatically for FormData.
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(data);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: m, headers, body, signal: controller.signal });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        parsed = {};
      }
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        data: (parsed.data ?? null) as unknown,
        message: (parsed.message as string) ?? undefined,
        errors: (parsed.errors as Record<string, string[]>) ?? undefined,
        error_code: (parsed.error_code as string) ?? undefined,
      };
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      return {
        status: 0,
        ok: false,
        data: null,
        message: aborted ? 'The request to SusuMate timed out.' : 'Could not reach SusuMate right now.',
        error_code: aborted ? 'timeout' : 'network_error',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

type BodyStruct = string | FormData | undefined;

function toQuery(data: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) params.append(`${k}[]`, String(item));
    } else {
      params.append(k, String(v));
    }
  }
  return params.toString();
}

async function buildFormData(
  data: Record<string, unknown>,
  files: Record<string, UploadFile | UploadFile[]>,
): Promise<FormData> {
  const { readFile } = await import('node:fs/promises');
  const fd = new FormData();

  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) fd.append(`${k}[]`, String(item));
    } else if (typeof v === 'object') {
      fd.append(k, JSON.stringify(v));
    } else {
      fd.append(k, String(v));
    }
  }

  const attach = async (field: string, f: UploadFile) => {
    const buf = f.buffer ?? (f.path ? await readFile(f.path) : Buffer.alloc(0));
    fd.append(field, new Blob([new Uint8Array(buf)], { type: f.mime }), f.filename);
  };

  for (const [field, spec] of Object.entries(files)) {
    if (Array.isArray(spec)) {
      for (const f of spec) await attach(`${field}[]`, f);
    } else {
      await attach(field, spec);
    }
  }
  return fd;
}

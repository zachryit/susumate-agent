// Resolve image args (campaign covers / avatars) into uploadable files. The WhatsApp user can
// either give a public image URL or just send a photo, which we reference with the sentinel
// "attached" (their most recent image), then upload as multipart to the SusuMate API.

import { extname } from 'node:path';
import type { UploadFile } from './client.js';
import type { LastImage } from '../sessions/store.js';

const ATTACHED = new Set(['attached', 'last', 'photo', 'the photo', 'this photo', 'attachment']);
const MAX_BYTES = 20 * 1024 * 1024;

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};

/**
 * Turn a single image reference (a URL, or the "attached" sentinel) into an UploadFile.
 * Returns null if it can't be resolved.
 */
export async function resolveImage(ref: string, lastImage?: LastImage): Promise<UploadFile | null> {
  const value = ref.trim();
  if (!value) return null;

  if (ATTACHED.has(value.toLowerCase())) {
    if (!lastImage) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(lastImage.path);
      return { buffer, filename: `cover${extForMime(lastImage.mime)}`, mime: lastImage.mime };
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(value, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
      if (!mime.startsWith('image/')) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_BYTES) return null;
      const nameFromUrl = value.split('/').pop()?.split('?')[0] || 'image';
      const filename = extname(nameFromUrl) ? nameFromUrl : `image${extForMime(mime)}`;
      return { buffer, filename, mime };
    } catch {
      return null;
    }
  }

  return null; // unrecognized reference
}

/** Resolve one-or-many image refs into UploadFiles, dropping any that fail. */
export async function resolveImages(refs: string[], lastImage?: LastImage): Promise<UploadFile[]> {
  const out: UploadFile[] = [];
  for (const r of refs) {
    const f = await resolveImage(r, lastImage);
    if (f) out.push(f);
  }
  return out;
}

function extForMime(mime: string): string {
  return EXT_FOR_MIME[mime] ?? '.jpg';
}

export interface StripResult {
  data: Uint8Array<ArrayBuffer>;
  stripped: boolean;
  removedBytes: number;
}

/**
 * Losslessly strips EXIF, GPS, XMP, IPTC, comments, and timestamps from JPEG (preserving
 * Orientation), PNG, and WebP images at the binary container level before upload.
 */
export function stripImageMetadata(input: Uint8Array<ArrayBuffer>): StripResult {
  if (input.byteLength < 12) {
    return { data: input, stripped: false, removedBytes: 0 };
  }
  try {
    if (isJpeg(input)) return stripJpegMetadata(input);
    if (isPng(input)) return stripPngMetadata(input);
    if (isWebp(input)) return stripWebpMetadata(input);
  } catch {
    return { data: input, stripped: false, removedBytes: 0 };
  }
  return { data: input, stripped: false, removedBytes: 0 };
}

function isJpeg(buf: Uint8Array): boolean {
  return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function isPng(buf: Uint8Array): boolean {
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function isWebp(buf: Uint8Array): boolean {
  return (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  );
}

function extractJpegExifOrientation(payload: Uint8Array): number | null {
  if (payload.byteLength < 28) return null;
  if (
    payload[0] !== 0x45 ||
    payload[1] !== 0x78 ||
    payload[2] !== 0x69 ||
    payload[3] !== 0x66 ||
    payload[4] !== 0x00 ||
    payload[5] !== 0x00
  ) {
    return null;
  }
  const tiff = payload.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const byteOrder = view.getUint16(0, false);
  const littleEndian = byteOrder === 0x4949;
  if (!littleEndian && byteOrder !== 0x4d4d) return null;
  if (view.getUint16(2, littleEndian) !== 0x002a) return null;
  const ifdOffset = view.getUint32(4, littleEndian);
  if (ifdOffset + 2 > tiff.byteLength) return null;
  const count = view.getUint16(ifdOffset, littleEndian);
  for (let i = 0; i < count; i++) {
    const off = ifdOffset + 2 + i * 12;
    if (off + 12 > tiff.byteLength) break;
    if (view.getUint16(off, littleEndian) === 0x0112) {
      const val = view.getUint16(off + 8, littleEndian);
      if (val >= 1 && val <= 8) return val;
    }
  }
  return null;
}

function buildMinimalOrientationApp1(orientation: number): Uint8Array {
  const out = new Uint8Array(36);
  const view = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xe1;
  view.setUint16(2, 34, false);
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  out[10] = 0x4d;
  out[11] = 0x4d;
  view.setUint16(12, 0x002a, false);
  view.setUint32(14, 8, false);
  view.setUint16(18, 1, false);
  view.setUint16(20, 0x0112, false);
  view.setUint16(22, 3, false);
  view.setUint32(24, 1, false);
  view.setUint16(28, orientation, false);
  view.setUint16(30, 0, false);
  view.setUint32(32, 0, false);
  return out;
}

function stripJpegMetadata(input: Uint8Array<ArrayBuffer>): StripResult {
  const chunks: Uint8Array[] = [input.subarray(0, 2)];
  let pos = 2;
  let stripped = false;
  let preservedOrientation: number | null = null;

  while (pos < input.byteLength) {
    if (input[pos] !== 0xff) return { data: input, stripped: false, removedBytes: 0 };
    while (pos < input.byteLength && input[pos] === 0xff) pos++;
    if (pos >= input.byteLength) break;

    const marker = input[pos++];
    if (marker === 0xd9 || marker === 0xda) {
      chunks.push(input.subarray(pos - 2));
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(input.subarray(pos - 2, pos));
      continue;
    }
    if (pos + 2 > input.byteLength) return { data: input, stripped: false, removedBytes: 0 };
    const segLen = (input[pos] << 8) | input[pos + 1];
    if (segLen < 2 || pos + segLen > input.byteLength) {
      return { data: input, stripped: false, removedBytes: 0 };
    }
    const segStart = pos - 2;
    const segEnd = pos + segLen;
    const removable =
      marker === 0xe1 ||
      marker === 0xed ||
      marker === 0xfe ||
      (marker >= 0xe3 && marker <= 0xec) ||
      marker === 0xef;

    if (removable) {
      stripped = true;
      if (marker === 0xe1 && preservedOrientation === null) {
        const ori = extractJpegExifOrientation(input.subarray(pos + 2, segEnd));
        if (ori !== null && ori > 1) {
          preservedOrientation = ori;
          chunks.push(buildMinimalOrientationApp1(ori));
        }
      }
    } else {
      chunks.push(input.subarray(segStart, segEnd));
    }
    pos = segEnd;
  }

  if (!stripped) return { data: input, stripped: false, removedBytes: 0 };
  const out = concatChunks(chunks);
  return { data: out, stripped: true, removedBytes: Math.max(0, input.byteLength - out.byteLength) };
}

const PNG_STRIP_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPngMetadata(input: Uint8Array<ArrayBuffer>): StripResult {
  const chunks: Uint8Array[] = [input.subarray(0, 8)];
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let pos = 8;
  let stripped = false;

  while (pos + 12 <= input.byteLength) {
    const length = view.getUint32(pos, false);
    const total = 12 + length;
    if (pos + total > input.byteLength) return { data: input, stripped: false, removedBytes: 0 };
    const type = String.fromCharCode(input[pos + 4], input[pos + 5], input[pos + 6], input[pos + 7]);
    if (PNG_STRIP_CHUNKS.has(type)) {
      stripped = true;
    } else {
      chunks.push(input.subarray(pos, pos + total));
    }
    pos += total;
    if (type === 'IEND') break;
  }

  if (!stripped) return { data: input, stripped: false, removedBytes: 0 };
  const out = concatChunks(chunks);
  return { data: out, stripped: true, removedBytes: Math.max(0, input.byteLength - out.byteLength) };
}

function stripWebpMetadata(input: Uint8Array<ArrayBuffer>): StripResult {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const chunks: Uint8Array[] = [new Uint8Array(input.subarray(0, 12))];
  let pos = 12;
  let stripped = false;

  while (pos + 8 <= input.byteLength) {
    const fourCC = String.fromCharCode(input[pos], input[pos + 1], input[pos + 2], input[pos + 3]);
    const chunkSize = view.getUint32(pos + 4, true);
    const padded = chunkSize + (chunkSize & 1);
    const total = 8 + padded;
    if (pos + total > input.byteLength) return { data: input, stripped: false, removedBytes: 0 };

    if (fourCC === 'EXIF' || fourCC === 'XMP ') {
      stripped = true;
    } else if (fourCC === 'VP8X' && chunkSize >= 10) {
      const vp8xCopy = new Uint8Array(input.subarray(pos, pos + total));
      vp8xCopy[8] &= ~0x0c;
      chunks.push(vp8xCopy);
    } else {
      chunks.push(input.subarray(pos, pos + total));
    }
    pos += total;
  }

  if (!stripped) return { data: input, stripped: false, removedBytes: 0 };
  const out = concatChunks(chunks);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, out.byteLength - 8, true);
  return { data: out, stripped: true, removedBytes: Math.max(0, input.byteLength - out.byteLength) };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function computeSha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
};

export function getExtension(filename: string, mime?: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot).toLowerCase();
    if (/^\.[a-z0-9]{1,12}$/.test(ext)) return ext;
  }
  if (mime) {
    const clean = mime.split(';')[0].trim().toLowerCase();
    if (MIME_TO_EXT[clean]) return MIME_TO_EXT[clean];
  }
  return '';
}

/**
 * Extracts image pixel dimensions from binary container headers (PNG, JPEG, WebP, GIF).
 * Accounts for JPEG EXIF orientation (5-8 swaps width/height).
 */
export function extractImageDimensions(input: Uint8Array): { width: number; height: number } | null {
  if (input.byteLength < 12) return null;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  try {
    // PNG: IHDR width at 16, height at 20
    if (isPng(input) && input.byteLength >= 24) {
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // GIF: GIF87a / GIF89a width at 6, height at 8 (LE)
    if (
      input[0] === 0x47 &&
      input[1] === 0x49 &&
      input[2] === 0x46 &&
      input[3] === 0x38 &&
      input.byteLength >= 10
    ) {
      const width = view.getUint16(6, true);
      const height = view.getUint16(8, true);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    // WebP: VP8X / VP8L / VP8
    if (isWebp(input) && input.byteLength >= 30) {
      const chunk = String.fromCharCode(input[12], input[13], input[14], input[15]);
      if (chunk === 'VP8X') {
        const width = 1 + (input[24] | (input[25] << 8) | (input[26] << 16));
        const height = 1 + (input[27] | (input[28] << 8) | (input[29] << 16));
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunk === 'VP8L' && input[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (chunk === 'VP8 ' && input[23] === 0x9d && input[24] === 0x01 && input[25] === 0x2a) {
        const width = view.getUint16(26, true) & 0x3fff;
        const height = view.getUint16(28, true) & 0x3fff;
        return width > 0 && height > 0 ? { width, height } : null;
      }
    }

    // JPEG: scan SOF markers + EXIF orientation
    if (isJpeg(input)) {
      let pos = 2;
      let orientation = 1;
      while (pos < input.byteLength) {
        if (input[pos] !== 0xff) break;
        while (pos < input.byteLength && input[pos] === 0xff) pos++;
        if (pos >= input.byteLength) break;
        const marker = input[pos++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (pos + 2 > input.byteLength) break;
        const segLen = view.getUint16(pos, false);
        if (segLen < 2 || pos + segLen > input.byteLength) break;

        if (marker === 0xe1) {
          const ori = extractJpegExifOrientation(input.subarray(pos + 2, pos + segLen));
          if (ori !== null) orientation = ori;
        }
        const isSOF =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSOF && segLen >= 7) {
          const height = view.getUint16(pos + 3, false);
          const width = view.getUint16(pos + 5, false);
          if (width > 0 && height > 0) {
            return orientation >= 5 && orientation <= 8
              ? { width: height, height: width }
              : { width, height };
          }
          break;
        }
        pos += segLen;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const DIMS_STORAGE_KEY = 'yukideck_storage_img_dims_v1';
const DIMS_CACHE_LIMIT = 1500;

export function loadCachedDimensions(): Record<string, [number, number]> {
  try {
    const raw = localStorage.getItem(DIMS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, [number, number]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCachedDimensionsBatch(entries: Record<string, [number, number]>): void {
  try {
    const merged = { ...loadCachedDimensions(), ...entries };
    const keys = Object.keys(merged);
    if (keys.length > DIMS_CACHE_LIMIT) {
      const trimmed: Record<string, [number, number]> = {};
      for (const k of keys.slice(keys.length - DIMS_CACHE_LIMIT)) {
        trimmed[k] = merged[k];
      }
      localStorage.setItem(DIMS_STORAGE_KEY, JSON.stringify(trimmed));
    } else {
      localStorage.setItem(DIMS_STORAGE_KEY, JSON.stringify(merged));
    }
  } catch {
    // Ignore storage quota errors
  }
}

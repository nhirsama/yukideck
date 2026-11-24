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

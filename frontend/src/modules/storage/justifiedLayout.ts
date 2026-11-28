import type { FileEntry, PrefixGroup } from './api';

export interface JustifiedTile {
  file: FileEntry;
  width: number;
  height: number;
  aspectRatio: number;
}

export interface JustifiedRow {
  tiles: JustifiedTile[];
  height: number;
}

export interface JustifiedLayoutResult {
  rows: JustifiedRow[];
  totalHeight: number;
}

export interface JustifiedOptions {
  targetRowHeight?: number;
  minRowHeight?: number;
  maxRowHeight?: number;
  gap?: number;
}

const MIN_AR = 0.48;
const MAX_AR = 2.8;
const DEFAULT_IMAGE_AR = 4 / 3;
const DEFAULT_FILE_AR = 1.18;

export function getFileDimensions(
  file: FileEntry,
  dimsMap: Record<string, [number, number]>,
): [number, number] | undefined {
  if (file.width && file.height && file.width > 0 && file.height > 0) {
    return [file.width, file.height];
  }
  return dimsMap[file.key] ?? dimsMap[file.url];
}

export function getFileAspectRatio(
  file: FileEntry,
  dimsMap: Record<string, [number, number]>,
): number {
  if (!file.is_image) return DEFAULT_FILE_AR;
  const dims = getFileDimensions(file, dimsMap);
  if (!dims || dims[0] <= 0 || dims[1] <= 0) return DEFAULT_IMAGE_AR;
  const raw = dims[0] / dims[1];
  return Math.max(MIN_AR, Math.min(MAX_AR, raw));
}

/**
 * Computes a Google Photos / Immich style justified-row (木桶) layout where every row has
 * uniform height and each image keeps its natural aspect ratio without cropping.
 */
export function computeJustifiedLayout(
  files: FileEntry[],
  containerWidth: number,
  dimsMap: Record<string, [number, number]>,
  options: JustifiedOptions = {},
): JustifiedLayoutResult {
  if (files.length === 0 || containerWidth <= 0) {
    return { rows: [], totalHeight: 0 };
  }

  const isNarrow = containerWidth < 520;
  const targetRowHeight = options.targetRowHeight ?? (isNarrow ? 148 : 204);
  const minRowHeight = options.minRowHeight ?? (isNarrow ? 105 : 132);
  const maxRowHeight = options.maxRowHeight ?? (isNarrow ? 210 : 288);
  const gap = options.gap ?? (isNarrow ? 8 : 10);

  const items = files.map((file) => ({
    file,
    ar: getFileAspectRatio(file, dimsMap),
  }));

  const rows: JustifiedRow[] = [];
  let rowItems: Array<{ file: FileEntry; ar: number }> = [];
  let sumAr = 0;

  const flushRow = (justify: boolean) => {
    if (rowItems.length === 0) return;
    const totalGap = gap * (rowItems.length - 1);
    const availW = Math.max(1, containerWidth - totalGap);

    let rowH: number;
    if (justify) {
      rowH = Math.max(minRowHeight, Math.min(maxRowHeight, availW / sumAr));
    } else {
      // Incomplete trailing row: justify if already >= 74% filled, else keep natural target height.
      const naturalW = sumAr * targetRowHeight;
      if (naturalW >= availW * 0.74) {
        rowH = Math.max(minRowHeight, Math.min(maxRowHeight, availW / sumAr));
      } else {
        rowH = Math.min(targetRowHeight, availW / sumAr);
      }
    }

    const willFillFullWidth =
      justify || sumAr * targetRowHeight >= availW * 0.74 || rowH * sumAr >= availW - 0.5;
    let usedW = 0;
    const tiles: JustifiedTile[] = rowItems.map((it, idx) => {
      const isLast = idx === rowItems.length - 1;
      const rawW = it.ar * rowH;
      const w =
        willFillFullWidth && isLast
          ? Math.max(40, availW - usedW)
          : Math.max(40, Math.round(rawW * 10) / 10);
      usedW += w;
      return {
        file: it.file,
        width: w,
        height: Math.round(rowH * 10) / 10,
        aspectRatio: it.ar,
      };
    });

    rows.push({
      tiles,
      height: Math.round(rowH * 10) / 10,
    });
    rowItems = [];
    sumAr = 0;
  };

  for (let i = 0; i < items.length; i++) {
    const cand = items[i];
    if (rowItems.length === 0) {
      rowItems.push(cand);
      sumAr = cand.ar;
      continue;
    }

    const totalGapWithout = gap * (rowItems.length - 1);
    const hWithout = (containerWidth - totalGapWithout) / sumAr;

    const nextSumAr = sumAr + cand.ar;
    const totalGapWith = gap * rowItems.length;
    const hWith = (containerWidth - totalGapWith) / nextSumAr;

    // If adding this item still fits comfortably above target height, include it.
    if (hWith >= targetRowHeight) {
      rowItems.push(cand);
      sumAr = nextSumAr;
      continue;
    }

    // Decide whether closing before `cand` or including `cand` stays closer to targetRowHeight.
    const errWithout = Math.abs(hWithout - targetRowHeight);
    const errWith = Math.abs(hWith - targetRowHeight);
    if (errWith <= errWithout && hWith >= minRowHeight) {
      rowItems.push(cand);
      sumAr = nextSumAr;
      flushRow(true);
    } else {
      flushRow(true);
      rowItems.push(cand);
      sumAr = cand.ar;
    }
  }

  flushRow(false);

  let totalHeight = 0;
  for (let i = 0; i < rows.length; i++) {
    totalHeight += rows[i].height;
    if (i > 0) totalHeight += gap;
  }

  return { rows, totalHeight: Math.ceil(totalHeight) };
}

export interface PathTreeNode {
  /** Normalized prefix: "" for root, otherwise ends with "/" (e.g. "blog/2026/") */
  prefix: string;
  /** Display segment label (e.g. "根目录", "blog", "2026") */
  label: string;
  /** Indentation depth: 0 for root & top-level folders, 1 for second-level, etc. */
  depth: number;
  /** Number of files directly inside this prefix */
  directCount: number;
  /** Total number of files in this prefix and all descendant prefixes */
  subtreeCount: number;
  /** Whether a concrete PrefixGroup section exists for this exact prefix */
  hasSection: boolean;
}

/**
 * Builds a lexicographically ordered path outline tree from prefix groups for the right-side navigator.
 * Virtual intermediate ancestor folders (e.g. "blog/" when only "blog/2026/" has files) are included
 * so the hierarchy stays clear and filterable.
 */
export function buildPathTree(groups: PrefixGroup[]): PathTreeNode[] {
  const directMap = new Map<string, number>();
  const sectionSet = new Set<string>();
  const allPrefixes = new Set<string>();

  for (const g of groups) {
    directMap.set(g.prefix, g.files.length);
    sectionSet.add(g.prefix);
    allPrefixes.add(g.prefix);

    if (g.prefix !== '') {
      const parts = g.prefix.replace(/\/+$/, '').split('/').filter(Boolean);
      let acc = '';
      for (const seg of parts) {
        acc += `${seg}/`;
        allPrefixes.add(acc);
      }
    }
  }

  const sorted = Array.from(allPrefixes).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return sorted.map((prefix) => {
    const directCount = directMap.get(prefix) ?? 0;
    let subtreeCount = 0;
    if (prefix === '') {
      subtreeCount = directCount;
    } else {
      for (const [p, cnt] of directMap.entries()) {
        if (p === prefix || p.startsWith(prefix)) {
          subtreeCount += cnt;
        }
      }
    }

    const parts = prefix === '' ? [] : prefix.replace(/\/+$/, '').split('/').filter(Boolean);
    const label = prefix === '' ? '/' : parts[parts.length - 1];
    const depth = prefix === '' ? 0 : parts.length - 1;

    return {
      prefix,
      label,
      depth,
      directCount,
      subtreeCount,
      hasSection: sectionSet.has(prefix),
    };
  });
}

export function formatPrefixLabel(prefix: string): string {
  if (!prefix) return '/';
  return `/${prefix.replace(/\/+$/, '')}`;
}

const TRANSPARENT_IMAGE_EXT_RE = /\.(png|svg|webp|gif|avif|ico)$/i;

export function isTransparentCapableImage(file: FileEntry): boolean {
  if (!file.is_image) return false;
  if (TRANSPARENT_IMAGE_EXT_RE.test(file.name)) return true;
  const ct = (file.content_type || '').toLowerCase();
  return (
    ct.includes('png') ||
    ct.includes('svg') ||
    ct.includes('webp') ||
    ct.includes('gif') ||
    ct.includes('avif') ||
    ct.includes('icon')
  );
}

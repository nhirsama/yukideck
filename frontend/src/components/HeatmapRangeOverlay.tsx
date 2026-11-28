import { useCallback, useEffect, useMemo, useState } from 'react';

export interface HeatmapGridCell {
  date: string;
  inRange?: boolean;
}

/**
 * Traces closed rounded orthogonal SVG polygon path(s) in `0..numCols x 0..7` grid coordinates
 * tightly framing every cell whose date falls inside [startDate, endDate].
 */
export function buildHeatmapRangePaths(
  weeks: HeatmapGridCell[][],
  startDate: string,
  endDate: string,
): string[] {
  if (!weeks.length || !startDate || !endDate || startDate > endDate) return [];

  const cols = weeks.length;
  const rows = 7;
  const selected = new Set<string>();
  const key = (c: number, r: number) => `${c},${r}`;

  for (let c = 0; c < cols; c++) {
    const col = weeks[c];
    for (let r = 0; r < col.length && r < rows; r++) {
      const cell = col[r];
      if (cell.inRange !== false && cell.date >= startDate && cell.date <= endDate) {
        selected.add(key(c, r));
      }
    }
  }
  if (selected.size === 0) return [];

  interface Edge {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    used: boolean;
  }
  const outgoing = new Map<string, Edge[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const e: Edge = { x1, y1, x2, y2, used: false };
    const k = `${x1},${y1}`;
    const list = outgoing.get(k);
    if (list) list.push(e);
    else outgoing.set(k, [e]);
  };

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (!selected.has(key(c, r))) continue;
      if (!selected.has(key(c, r - 1))) addEdge(c, r, c + 1, r); // top
      if (!selected.has(key(c + 1, r))) addEdge(c + 1, r, c + 1, r + 1); // right
      if (!selected.has(key(c, r + 1))) addEdge(c + 1, r + 1, c, r + 1); // bottom
      if (!selected.has(key(c - 1, r))) addEdge(c, r + 1, c, r); // left
    }
  }

  const paths: string[] = [];
  for (const list of outgoing.values()) {
    for (const startEdge of list) {
      if (startEdge.used) continue;
      const pts: Array<[number, number]> = [[startEdge.x1, startEdge.y1]];
      let cur: Edge | undefined = startEdge;
      let guard = 0;
      while (cur && !cur.used && guard < 2000) {
        guard++;
        cur.used = true;
        pts.push([cur.x2, cur.y2]);
        if (cur.x2 === startEdge.x1 && cur.y2 === startEdge.y1) break;
        const candidates: Edge[] = outgoing.get(`${cur.x2},${cur.y2}`) ?? [];
        cur = candidates.find((e) => !e.used);
      }
      if (pts.length < 4) continue;

      // Remove duplicate closing point and collapse collinear intermediate vertices
      pts.pop();
      const simplified: Array<[number, number]> = [];
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const prev = pts[(i - 1 + n) % n];
        const curr = pts[i];
        const next = pts[(i + 1) % n];
        const sameX = prev[0] === curr[0] && curr[0] === next[0];
        const sameY = prev[1] === curr[1] && curr[1] === next[1];
        if (!sameX && !sameY) {
          simplified.push(curr);
        }
      }

      if (simplified.length >= 3) {
        const cornerRadius = 0.28; // cell-grid units (1 unit = 1 square cell pitch)
        const fmt = (v: number) => Number(v.toFixed(3));
        const segments: string[] = [];
        const m = simplified.length;
        let firstStart: [number, number] | null = null;

        for (let i = 0; i < m; i++) {
          const prev = simplified[(i - 1 + m) % m];
          const curr = simplified[i];
          const next = simplified[(i + 1) % m];

          const vx1 = curr[0] - prev[0];
          const vy1 = curr[1] - prev[1];
          const len1 = Math.hypot(vx1, vy1);

          const vx2 = next[0] - curr[0];
          const vy2 = next[1] - curr[1];
          const len2 = Math.hypot(vx2, vy2);

          const r = Math.min(cornerRadius, len1 * 0.45, len2 * 0.45);
          const inX = curr[0] - (vx1 / len1) * r;
          const inY = curr[1] - (vy1 / len1) * r;
          const outX = curr[0] + (vx2 / len2) * r;
          const outY = curr[1] + (vy2 / len2) * r;

          if (i === 0) {
            firstStart = [inX, inY];
            segments.push(`M${fmt(inX)} ${fmt(inY)}`);
          } else {
            segments.push(`L${fmt(inX)} ${fmt(inY)}`);
          }
          segments.push(`Q${fmt(curr[0])} ${fmt(curr[1])} ${fmt(outX)} ${fmt(outY)}`);
        }
        if (firstStart) {
          segments.push(`L${fmt(firstStart[0])} ${fmt(firstStart[1])} Z`);
        }
        paths.push(segments.join(' '));
      }
    }
  }

  return paths;
}

/**
 * Triggers a temporary highlight flag that auto-fades after `durationMs` (default 3000ms).
 * Starts hidden on initial page mount and only activates after explicit user range changes.
 */
export function useTemporaryRangeHighlight(durationMs = 3000) {
  const [seq, setSeq] = useState(0);
  const [visible, setVisible] = useState(false);

  const trigger = useCallback(() => {
    setSeq((n) => n + 1);
  }, []);

  useEffect(() => {
    if (seq === 0) return;
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [seq, durationMs]);

  return { visible, trigger };
}

interface HeatmapRangeOverlayProps {
  weeks: HeatmapGridCell[][];
  startDate: string;
  endDate: string;
  visible: boolean;
  disabled?: boolean;
}

export function HeatmapRangeOverlay({
  weeks,
  startDate,
  endDate,
  visible,
  disabled = false,
}: HeatmapRangeOverlayProps) {
  const paths = useMemo(() => {
    if (disabled || weeks.length === 0) return [];
    return buildHeatmapRangePaths(weeks, startDate, endDate);
  }, [disabled, weeks, startDate, endDate]);

  if (paths.length === 0 || weeks.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${weeks.length} 7`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`pointer-events-none absolute -inset-[1px] sm:-inset-[1.5px] w-[calc(100%+2px)] h-[calc(100%+2px)] sm:w-[calc(100%+3px)] sm:h-[calc(100%+3px)] overflow-visible transition-opacity duration-700 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {paths.map((d, idx) => (
        <path
          key={idx}
          d={d}
          fill="rgba(14, 165, 233, 0.08)"
          stroke="#0284c7"
          strokeWidth={1.75}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

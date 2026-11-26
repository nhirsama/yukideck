import { useEffect, useRef } from 'react';

interface LoaderProps {
  size?: number;
}

const ICE_PALETTE: Array<{ rgb: [number, number, number]; head: string }> = [
  { rgb: [2, 132, 199], head: '#0284c7' }, // Sky 600
  { rgb: [14, 165, 233], head: '#0ea5e9' }, // Sky 500
  { rgb: [56, 189, 248], head: '#38bdf8' }, // Sky 400
];

// --- 1. Exact 2D Chenciner-Montgomery Figure-8 Three-Body Periodic Orbit ---

type Point2D = [number, number];
let cachedFigure8Samples: [Point2D[], Point2D[], Point2D[]] | null = null;

function getFigure8Samples(): [Point2D[], Point2D[], Point2D[]] {
  if (cachedFigure8Samples) return cachedFigure8Samples;

  const period = 6.32591398;
  const totalSteps = 3600;
  const sampleCount = 450;
  const normScale = 1.05;
  const dt = period / totalSteps;

  type State = [number, number, number, number];
  let s: [State, State, State] = [
    [-0.97000436, 0.24308753, 0.466203685, 0.43236573],
    [0.97000436, -0.24308753, 0.466203685, 0.43236573],
    [0, 0, -0.93240737, -0.86473146],
  ];

  const accel = (st: [State, State, State]): [Point2D, Point2D, Point2D] => {
    const a: [Point2D, Point2D, Point2D] = [
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const dx = st[j][0] - st[i][0];
        const dy = st[j][1] - st[i][1];
        const inv3 = 1 / Math.pow(dx * dx + dy * dy, 1.5);
        a[i][0] += dx * inv3;
        a[i][1] += dy * inv3;
        a[j][0] -= dx * inv3;
        a[j][1] -= dy * inv3;
      }
    }
    return a;
  };

  const samples: [Point2D[], Point2D[], Point2D[]] = [[], [], []];
  const stride = totalSteps / sampleCount;
  let nextMark = 0;

  for (let k = 0; k < totalSteps; k++) {
    if (k >= nextMark) {
      for (let i = 0; i < 3; i++) {
        samples[i].push([s[i][0] / normScale, -s[i][1] / normScale]);
      }
      nextMark += stride;
    }
    const a1 = accel(s);
    const s2 = s.map((b, i): State => [
      b[0] + 0.5 * dt * b[2],
      b[1] + 0.5 * dt * b[3],
      b[2] + 0.5 * dt * a1[i][0],
      b[3] + 0.5 * dt * a1[i][1],
    ]) as [State, State, State];
    const a2 = accel(s2);
    const s3 = s.map((b, i): State => [
      b[0] + 0.5 * dt * s2[i][2],
      b[1] + 0.5 * dt * s2[i][3],
      b[2] + 0.5 * dt * a2[i][0],
      b[3] + 0.5 * dt * a2[i][1],
    ]) as [State, State, State];
    const a3 = accel(s3);
    const s4 = s.map((b, i): State => [
      b[0] + dt * s3[i][2],
      b[1] + dt * s3[i][3],
      b[2] + dt * a3[i][0],
      b[3] + dt * a3[i][1],
    ]) as [State, State, State];
    const a4 = accel(s4);
    s = s.map((b, i): State => [
      b[0] + (dt / 6) * (b[2] + 2 * s2[i][2] + 2 * s3[i][2] + s4[i][2]),
      b[1] + (dt / 6) * (b[3] + 2 * s2[i][3] + 2 * s3[i][3] + s4[i][3]),
      b[2] + (dt / 6) * (a1[i][0] + 2 * a2[i][0] + 2 * a3[i][0] + a4[i][0]),
      b[3] + (dt / 6) * (a1[i][1] + 2 * a2[i][1] + 2 * a3[i][1] + a4[i][1]),
    ]) as [State, State, State];
  }

  cachedFigure8Samples = samples;
  return samples;
}

export function Figure8ThreeBodyLoader({ size = 80 }: LoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const samples = getFigure8Samples();
    const total = samples[0].length;
    const trailSamples = 95;
    const cyclesPerSec = 0.26;
    const sf = size / 64;
    const half = size * 0.5;
    const radius = size * 0.45;
    const batches = 20;

    let phase = Math.random() * total;

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const headIdx = Math.floor(phase);
      const step = (trailSamples - 1) / batches;

      for (let bi = 0; bi < 3; bi++) {
        const bodySamples = samples[bi];
        const { rgb, head } = ICE_PALETTE[bi];

        for (let b = 0; b < batches; b++) {
          const k0 = Math.floor(b * step);
          const k1 = Math.floor((b + 1) * step);
          if (k1 <= k0) continue;
          const t = (b + 1) / batches;
          const startSample = bodySamples[(headIdx - (trailSamples - 1 - k0) + total * 4) % total];
          ctx.beginPath();
          ctx.moveTo(half + startSample[0] * radius, half + startSample[1] * radius);
          for (let k = k0 + 1; k <= k1; k++) {
            const pt = bodySamples[(headIdx - (trailSamples - 1 - k) + total * 4) % total];
            ctx.lineTo(half + pt[0] * radius, half + pt[1] * radius);
          }
          ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(Math.pow(t, 1.8) * 0.88).toFixed(3)})`;
          ctx.lineWidth = (0.5 + t * 1.2) * sf;
          ctx.stroke();
        }

        const headPt = bodySamples[headIdx % total];
        ctx.fillStyle = head;
        ctx.beginPath();
        ctx.arc(half + headPt[0] * radius, half + headPt[1] * radius, 1.65 * sf, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    draw();
    if (reducedMotion) return;

    let rafId = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      phase = (phase + dt * cyclesPerSec * total) % total;
      draw();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="block"
      aria-hidden="true"
    />
  );
}

// --- 2. Pure 2D Chaotic Double Pendulum ---

export function DoublePendulumLoader({ size = 92 }: LoaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    let a1 = Math.PI * 0.78 + (Math.random() - 0.5) * 0.32;
    let a2 = Math.PI * 0.62 + (Math.random() - 0.5) * 0.32;
    let w1 = 0.4;
    let w2 = -0.3;

    const g = 9.81;
    const L1 = 1;
    const L2 = 1;
    const m1 = 1;
    const m2 = 1;
    const trail1: Point2D[] = [];
    const trail2: Point2D[] = [];
    const trail1Len = 55;
    const trail2Len = 135;

    const deriv = ([th1, th2, om1, om2]: [number, number, number, number]): [
      number,
      number,
      number,
      number,
    ] => {
      const d = th1 - th2;
      const sinD = Math.sin(d);
      const cosD = Math.cos(d);
      const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
      const a1Dot =
        (-g * (2 * m1 + m2) * Math.sin(th1) -
          m2 * g * Math.sin(th1 - 2 * th2) -
          2 * sinD * m2 * (om2 * om2 * L2 + om1 * om1 * L1 * cosD)) /
        (L1 * den);
      const a2Dot =
        (2 *
          sinD *
          (om1 * om1 * L1 * (m1 + m2) + g * (m1 + m2) * Math.cos(th1) + om2 * om2 * L2 * m2 * cosD)) /
        (L2 * den);
      return [om1, om2, a1Dot, a2Dot];
    };

    const step = (dt: number) => {
      const s0: [number, number, number, number] = [a1, a2, w1, w2];
      const k1 = deriv(s0);
      const k2 = deriv([
        s0[0] + 0.5 * dt * k1[0],
        s0[1] + 0.5 * dt * k1[1],
        s0[2] + 0.5 * dt * k1[2],
        s0[3] + 0.5 * dt * k1[3],
      ]);
      const k3 = deriv([
        s0[0] + 0.5 * dt * k2[0],
        s0[1] + 0.5 * dt * k2[1],
        s0[2] + 0.5 * dt * k2[2],
        s0[3] + 0.5 * dt * k2[3],
      ]);
      const k4 = deriv([
        s0[0] + dt * k3[0],
        s0[1] + dt * k3[1],
        s0[2] + dt * k3[2],
        s0[3] + dt * k3[3],
      ]);
      a1 += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      a2 += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      w1 += (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
      w2 += (dt / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
    };

    const push = () => {
      const x1 = 0.48 * Math.sin(a1);
      const y1 = 0.48 * Math.cos(a1);
      const x2 = x1 + 0.48 * Math.sin(a2);
      const y2 = y1 + 0.48 * Math.cos(a2);
      trail1.push([x1, y1]);
      trail2.push([x2, y2]);
      if (trail1.length > trail1Len) trail1.shift();
      if (trail2.length > trail2Len) trail2.shift();
    };

    for (let i = 0; i < 80; i++) {
      step(0.012);
      push();
    }

    const sf = size / 64;
    const cx = size * 0.5;
    const cy = size * 0.46;
    const R = size * 0.44;
    const c1 = ICE_PALETTE[0];
    const c2 = ICE_PALETTE[1];

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const batches = 20;
      const stepB = (trail2.length - 1) / batches;
      for (let b = 0; b < batches; b++) {
        const i0 = Math.floor(b * stepB);
        const i1 = Math.floor((b + 1) * stepB);
        if (i1 <= i0) continue;
        const t = (b + 1) / batches;
        ctx.beginPath();
        ctx.moveTo(cx + trail2[i0][0] * R, cy + trail2[i0][1] * R);
        for (let i = i0 + 1; i <= i1; i++) {
          ctx.lineTo(cx + trail2[i][0] * R, cy + trail2[i][1] * R);
        }
        ctx.strokeStyle = `rgba(${c2.rgb[0]}, ${c2.rgb[1]}, ${c2.rgb[2]}, ${(Math.pow(t, 1.8) * 0.9).toFixed(3)})`;
        ctx.lineWidth = (0.5 + t * 1.35) * sf;
        ctx.stroke();
      }

      const stepB1 = (trail1.length - 1) / 12;
      for (let b = 0; b < 12; b++) {
        const i0 = Math.floor(b * stepB1);
        const i1 = Math.floor((b + 1) * stepB1);
        if (i1 <= i0) continue;
        const t = (b + 1) / 12;
        ctx.beginPath();
        ctx.moveTo(cx + trail1[i0][0] * R, cy + trail1[i0][1] * R);
        for (let i = i0 + 1; i <= i1; i++) {
          ctx.lineTo(cx + trail1[i][0] * R, cy + trail1[i][1] * R);
        }
        ctx.strokeStyle = `rgba(${c1.rgb[0]}, ${c1.rgb[1]}, ${c1.rgb[2]}, ${(Math.pow(t, 1.8) * 0.35).toFixed(3)})`;
        ctx.lineWidth = (0.4 + t * 0.7) * sf;
        ctx.stroke();
      }

      const p1 = trail1[trail1.length - 1];
      const p2 = trail2[trail2.length - 1];

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + p1[0] * R, cy + p1[1] * R);
      ctx.lineTo(cx + p2[0] * R, cy + p2[1] * R);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 0.9 * sf;
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.beginPath();
      ctx.arc(cx, cy, 1.3 * sf, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = c1.head;
      ctx.beginPath();
      ctx.arc(cx + p1[0] * R, cy + p1[1] * R, 1.6 * sf, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = c2.head;
      ctx.beginPath();
      ctx.arc(cx + p2[0] * R, cy + p2[1] * R, 1.9 * sf, 0, Math.PI * 2);
      ctx.fill();
    };

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    draw();
    if (reducedMotion) return;

    let rafId = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (let s = 0; s < 4; s++) {
        step((dt * 1.15) / 4);
        push();
      }
      draw();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="block"
      aria-hidden="true"
    />
  );
}

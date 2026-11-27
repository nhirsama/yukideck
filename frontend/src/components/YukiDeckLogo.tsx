import { useId } from 'react';

const PETAL_PATH =
  'M30.33 7.11A1.90 1.90 0 0 1 33.67 7.11L36.42 12.21A2.00 2.00 0 0 1 36.46 14.02L33.26 20.74A1.40 1.40 0 0 1 30.74 20.74L27.54 14.02A2.00 2.00 0 0 1 27.58 12.21Z';

const BUD_PATH =
  'M31.02 13.92A1.10 1.10 0 0 1 32.98 13.92L34.20 16.30A1.00 1.00 0 0 1 34.23 17.12L32.84 20.67A0.90 0.90 0 0 1 31.16 20.67L29.77 17.12A1.00 1.00 0 0 1 29.80 16.30Z';

const CORE_PATH =
  'M34.14 26.81A0.95 0.95 0 0 1 35.43 27.55L35.73 29.54A0.72 0.72 0 0 0 35.99 30.00L37.57 31.26A0.95 0.95 0 0 1 37.57 32.74L35.99 34.00A0.72 0.72 0 0 0 35.73 34.46L35.43 36.45A0.95 0.95 0 0 1 34.14 37.19L32.26 36.45A0.72 0.72 0 0 0 31.74 36.45L29.86 37.19A0.95 0.95 0 0 1 28.57 36.45L28.27 34.46A0.72 0.72 0 0 0 28.01 34.00L26.43 32.74A0.95 0.95 0 0 1 26.43 31.26L28.01 30.00A0.72 0.72 0 0 0 28.27 29.54L28.57 27.55A0.95 0.95 0 0 1 29.86 26.81L31.74 27.55A0.72 0.72 0 0 0 32.26 27.55Z';

const CORE_FACETS_PATH =
  'M32 32L32.00 21.00L37.50 22.47ZM32 32L41.53 26.50L43.00 32.00ZM32 32L41.53 37.50L37.50 41.53ZM32 32L32.00 43.00L26.50 41.53ZM32 32L22.47 37.50L21.00 32.00ZM32 32L22.47 26.50L26.50 22.47Z';

const MAIN_ANGLES = [0, 60, 120, 180, 240, 300] as const;
const SUB_ANGLES = [30, 90, 150, 210, 270, 330] as const;

export function YukiDeckLogo({ className = 'h-7 w-7' }: { className?: string }) {
  const uid = useId().replace(/:/g, '');
  const petalGrad = `${uid}-pg`;
  const budGrad = `${uid}-bg`;
  const coreLit = `${uid}-cl`;
  const coreDeep = `${uid}-cd`;
  const petalClip = `${uid}-pc`;
  const budClip = `${uid}-bc`;
  const coreClip = `${uid}-cc`;
  const petalRef = `${uid}-p`;
  const budRef = `${uid}-b`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={petalGrad} gradientUnits="userSpaceOnUse" cx="32" cy="32" r="28.5">
          <stop offset="0.22" stopColor="#c6e6fe" />
          <stop offset="0.58" stopColor="#7ec4fc" />
          <stop offset="1" stopColor="#389ef6" />
        </radialGradient>
        <radialGradient id={budGrad} gradientUnits="userSpaceOnUse" cx="32" cy="32" r="22">
          <stop offset="0.30" stopColor="#e3f3ff" />
          <stop offset="1" stopColor="#aed9fe" />
        </radialGradient>
        <radialGradient id={coreLit} gradientUnits="userSpaceOnUse" cx="32" cy="32" r="7.0">
          <stop offset="0" stopColor="#f5fbff" />
          <stop offset="1" stopColor="#cbe8fe" />
        </radialGradient>
        <radialGradient id={coreDeep} gradientUnits="userSpaceOnUse" cx="32" cy="32" r="7.0">
          <stop offset="0" stopColor="#6cbdf9" />
          <stop offset="1" stopColor="#9fd4fd" />
        </radialGradient>
        <clipPath id={petalClip}>
          <path d={PETAL_PATH} />
        </clipPath>
        <clipPath id={budClip}>
          <path d={BUD_PATH} />
        </clipPath>
        <clipPath id={coreClip}>
          <path d={CORE_PATH} />
        </clipPath>
        <g id={petalRef}>
          <path d={PETAL_PATH} fill={`url(#${petalGrad})`} />
          <rect x="20" y="0" width="12" height="30" fill="#ffffff" fillOpacity="0.22" clipPath={`url(#${petalClip})`} />
        </g>
        <g id={budRef}>
          <path d={BUD_PATH} fill={`url(#${budGrad})`} />
          <rect x="24" y="10" width="8" height="16" fill="#ffffff" fillOpacity="0.24" clipPath={`url(#${budClip})`} />
        </g>
      </defs>
      {SUB_ANGLES.map((deg) => (
        <use key={deg} href={`#${budRef}`} transform={`rotate(${deg} 32 32)`} />
      ))}
      {MAIN_ANGLES.map((deg) => (
        <use key={deg} href={`#${petalRef}`} transform={deg === 0 ? undefined : `rotate(${deg} 32 32)`} />
      ))}
      <path d={CORE_PATH} fill={`url(#${coreLit})`} />
      <path d={CORE_FACETS_PATH} fill={`url(#${coreDeep})`} clipPath={`url(#${coreClip})`} />
    </svg>
  );
}

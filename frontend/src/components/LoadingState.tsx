import type { ReactNode } from 'react';
import { DoublePendulumLoader, Figure8ThreeBodyLoader } from './ChaosLoaders';

export type LoadingVariant = 'fullscreen' | 'module' | 'section' | 'compact';

interface LoadingStateProps {
  label?: string;
  variant?: LoadingVariant;
  animation?: ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<LoadingVariant, string> = {
  fullscreen: 'min-h-screen bg-[#f8fafc]',
  module: 'min-h-[60vh]',
  section: 'py-16',
  compact: 'py-8',
};

const VARIANT_ANIMATION_SIZE: Record<LoadingVariant, number> = {
  fullscreen: 96,
  module: 84,
  section: 72,
  compact: 56,
};

export function LoadingState({
  label = '正在加载模块...',
  variant = 'section',
  animation,
  className = '',
}: LoadingStateProps) {
  const animSize = VARIANT_ANIMATION_SIZE[variant];
  const animNode =
    animation !== undefined ? (
      animation
    ) : variant === 'fullscreen' ? (
      <DoublePendulumLoader size={animSize} />
    ) : (
      <Figure8ThreeBodyLoader size={animSize} />
    );

  return (
    <div
      role="status"
      aria-live="polite"
      className={`w-full flex flex-col items-center justify-center text-center select-none ${VARIANT_CLASSES[variant]} ${className}`}
    >
      <div
        data-yd-loading-animation=""
        className="mb-3 flex items-center justify-center empty:hidden"
      >
        {animNode}
      </div>
      <span className="text-xs tracking-wide text-zinc-400">{label}</span>
    </div>
  );
}

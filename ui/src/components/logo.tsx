import { cn } from '@/lib/utils';

export interface LogoProps {
  className?: string;
}

/**
 * Brand mark for `e -`: Euler's identity, e^(iπ) + 1 = 0, drawn as its
 * geometric meaning in the complex plane. The faint circle and axes are
 * the unit circle; the bold arc is the half-turn from 1 to −1 traced by
 * e^(iπ); the solid point is −1, which +1 brings back to the origin.
 * Inline SVG so it renders at any size and inherits the text color.
 */
export function Logo({ className }: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      role="img"
      aria-label="e -"
      className={cn('h-6 w-6', className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* unit circle and axes */}
      <circle
        cx="16"
        cy="16"
        r="12"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.4"
      />
      <path
        d="M2 16 H30 M16 2 V30"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.4"
      />
      {/* e^(iπ): half-turn from 1 to -1 along the upper arc */}
      <path
        d="M28 16 A12 12 0 0 0 4 16"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {/* start at 1 */}
      <circle cx="28" cy="16" r="2" fill="currentColor" opacity="0.4" />
      {/* land on -1 */}
      <circle cx="4" cy="16" r="3" fill="currentColor" />
    </svg>
  );
}

import { cn } from '@/lib/utils';

export interface LogoProps {
  className?: string;
}

/**
 * Brand mark for `e -`. Inline SVG so it renders at any size
 * and inherits the current text color.
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
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="8"
        stroke="currentColor"
        strokeWidth="2"
      />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fontSize="16"
        fontWeight="700"
        fill="currentColor"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      >
        e -
      </text>
    </svg>
  );
}

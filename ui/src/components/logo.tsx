import { cn } from '@/lib/utils';

export interface LogoProps {
  className?: string;
}

/**
 * Brand mark for `e -`. Inline SVG so it renders at any size
 * and inherits the current text color. Terminal caret with block
 * cursor replaces the old text glyph.
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
      <path
        d="M10 10 L17 16 L10 22"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="19"
        y="12.5"
        width="3.5"
        height="7"
        rx="1.5"
        fill="currentColor"
      />
    </svg>
  );
}

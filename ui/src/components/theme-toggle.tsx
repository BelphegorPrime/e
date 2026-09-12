import { Laptop, Moon, Sun } from 'lucide-react';

import { useTheme, type Theme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

const options: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Laptop, label: 'System' },
];

/** Segmented light / dark / system switcher. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5"
    >
      {options.map(option => {
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.label}
            aria-pressed={active}
            onClick={() => setTheme(option.value)}
            className={cn(
              'rounded-xs p-1.5 text-muted-foreground transition-colors hover:text-foreground',
              active && 'bg-background text-foreground shadow-xs'
            )}
          >
            <option.icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}

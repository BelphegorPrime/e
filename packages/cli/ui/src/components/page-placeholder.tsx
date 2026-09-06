import type { LucideIcon } from 'lucide-react';

import { PageHeader } from '@/components/page-header';

export interface PagePlaceholderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  blurb: string;
}

/** Standard empty-state body for views that have not landed yet. */
export function PagePlaceholder({
  title,
  description,
  icon: Icon,
  blurb,
}: PagePlaceholderProps) {
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <PageHeader title={title} description={description} />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-6" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {blurb}
          </p>
        </div>
      </div>
    </div>
  );
}

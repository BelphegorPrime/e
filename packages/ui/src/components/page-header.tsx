import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';

export interface PageHeaderProps {
  title: string;
  description: string;
}

/** Shared page header: sidebar trigger, title block and theme toggle. */
export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 !h-6" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <ThemeToggle />
    </div>
  );
}

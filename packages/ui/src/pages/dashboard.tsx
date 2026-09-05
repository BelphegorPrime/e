import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

/**
 * Placeholder layout for the dashboard. CSS containers stand in
 * for real content until the dashboard features land.
 */
export function DashboardPage() {
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-2 !h-6" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">e - overview</p>
        </div>
      </div>

      {/* hero container */}
      <div className="flex min-h-56 flex-col justify-between rounded-xl border border-dashed border-border bg-muted/30 p-6">
        <div className="flex items-start justify-between">
          <div className="h-8 w-48 rounded-md bg-muted" />
          <div className="h-8 w-8 rounded-md bg-muted" />
        </div>
        <div className="h-4 w-96 max-w-full rounded-md bg-muted" />
      </div>

      {/* stat containers */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {['Runs', 'Agents', 'Queued', 'Errors'].map(label => (
          <div
            key={label}
            className="flex h-28 flex-col justify-between rounded-xl border border-dashed border-border bg-muted/30 p-4"
          >
            <p className="text-sm text-muted-foreground">{label}</p>
            <div className="h-6 w-12 rounded-md bg-muted" />
          </div>
        ))}
      </div>

      {/* content containers */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex min-h-64 flex-col gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-4 lg:col-span-2">
          <div className="h-5 w-40 rounded-md bg-muted" />
          <div className="flex-1 rounded-md bg-muted/60" />
        </div>
        <div className="flex min-h-64 flex-col gap-4 rounded-xl border border-dashed border-border bg-muted/30 p-4">
          <div className="h-5 w-32 rounded-md bg-muted" />
          <div className="flex-1 space-y-3">
            <div className="h-16 rounded-md bg-muted/60" />
            <div className="h-16 rounded-md bg-muted/60" />
            <div className="h-16 rounded-md bg-muted/60" />
          </div>
        </div>
      </div>
    </div>
  );
}

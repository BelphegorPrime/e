import { Play } from 'lucide-react';

import { PagePlaceholder } from '@/components/page-placeholder';

export function RunsPage() {
  return (
    <PagePlaceholder
      title="Runs"
      description="e - run history"
      icon={Play}
      blurb="Placeholder view. Run lifecycle, outputs and logs will land here."
    />
  );
}

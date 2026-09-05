import { Activity } from 'lucide-react';

import { PagePlaceholder } from '@/components/page-placeholder';

export function ActivityPage() {
  return (
    <PagePlaceholder
      title="Activity"
      description="e - event stream"
      icon={Activity}
      blurb="Placeholder view. Orchestrator events and audit trail will land here."
    />
  );
}

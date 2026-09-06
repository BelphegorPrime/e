import { Settings } from 'lucide-react';

import { PagePlaceholder } from '@/components/page-placeholder';

export function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      description="e - configuration"
      icon={Settings}
      blurb="Placeholder view. Orchestrator settings and preferences will land here."
    />
  );
}

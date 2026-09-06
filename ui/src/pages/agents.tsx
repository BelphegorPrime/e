import { Bot } from 'lucide-react';

import { PagePlaceholder } from '@/components/page-placeholder';

export function AgentsPage() {
  return (
    <PagePlaceholder
      title="Agents"
      description="e - agent inventory"
      icon={Bot}
      blurb="Placeholder view. Agent images, definitions and status will land here."
    />
  );
}

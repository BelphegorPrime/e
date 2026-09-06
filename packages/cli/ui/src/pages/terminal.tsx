import { TerminalSquare } from 'lucide-react';

import { PagePlaceholder } from '@/components/page-placeholder';

export function TerminalPage() {
  return (
    <PagePlaceholder
      title="Terminal"
      description="e - live session"
      icon={TerminalSquare}
      blurb="Placeholder view. A live terminal session into the workspace will land here."
    />
  );
}

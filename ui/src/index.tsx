import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ActivityPage } from '@/pages/activity';
import { AgentsPage } from '@/pages/agents';
import { DashboardPage } from '@/pages/dashboard';
import { OmniRoutePage } from '@/pages/omniroute';
import { RunsPage } from '@/pages/runs';
import { SettingsPage } from '@/pages/settings';
import { TerminalPage } from '@/pages/terminal';

import './index.css';

function App() {
  return (
    <HashRouter>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/omniroute" element={<OmniRoutePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SidebarInset>
      </SidebarProvider>
    </HashRouter>
  );
}

const root = globalThis.document.getElementById('root');
if (!root) throw new Error('UI root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

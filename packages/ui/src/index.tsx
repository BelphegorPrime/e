import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppSidebar } from '@/components/app-sidebar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { DashboardPage } from '@/pages/dashboard';

import './index.css';

function App() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <DashboardPage />
      </SidebarInset>
    </SidebarProvider>
  );
}

const root = globalThis.document.getElementById('root');
if (!root) throw new Error('UI root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

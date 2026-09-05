import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  return (
    <main>
      <h1>e</h1>
      <p>Orchestrator UI</p>
    </main>
  );
}

const root = globalThis.document.getElementById('root');
if (!root) throw new Error('UI root element is missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

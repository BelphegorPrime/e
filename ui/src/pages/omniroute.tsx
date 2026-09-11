import { useEffect, useState } from 'react';

interface InfoResponse {
  omniRouteEmbedPort: number | null;
}

type EmbedState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; url: string };

// OmniRoute refuses to be framed directly (`frame-ancestors 'none'`), so the
// BFF runs an embed proxy on its own port that mirrors OmniRoute 1:1 with
// those headers stripped (see `startOmniRouteEmbedProxy` in serve.ts). The
// proxy needs its own port because OmniRoute's login, assets and API are
// root-anchored and would not survive a path prefix. Using the page's own
// hostname keeps the frame same-site, so the dashboard session cookie works.
function embedUrl(port: number): string {
  return `${window.location.protocol}//${window.location.hostname}:${port}/dashboard`;
}

export function OmniRoutePage() {
  const [state, setState] = useState<EmbedState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/info');
        if (!response.ok) {
          throw new Error(`BFF returned HTTP ${response.status}`);
        }
        const body = (await response.json()) as InfoResponse;
        if (body.omniRouteEmbedPort === null) {
          throw new Error(
            'The BFF is running without the OmniRoute embed proxy.'
          );
        }
        if (!cancelled) {
          setState({ status: 'ready', url: embedUrl(body.omniRouteEmbedPort) });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-svh w-full flex-col">
      {state.status === 'ready' ? (
        <iframe
          src={state.url}
          title="OmniRoute dashboard"
          className="size-full flex-1 border-0"
        />
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {state.status === 'loading'
            ? 'Loading OmniRoute…'
            : `Could not load OmniRoute: ${state.message}`}
        </p>
      )}
    </div>
  );
}

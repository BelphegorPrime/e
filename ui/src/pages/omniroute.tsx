// Proxied through the BFF (see the /dashboard pathFilter in serve.ts) so the
// dashboard's `frame-ancestors 'none'` header never reaches the browser. The
// path mirrors OmniRoute's own basePath 1:1 so its absolute asset and
// navigation links keep working once proxied.
const OMNIROUTE_DASHBOARD_URL = '/dashboard';

export function OmniRoutePage() {
  return (
    <div className="flex h-svh w-full flex-col">
      <iframe
        src={OMNIROUTE_DASHBOARD_URL}
        title="OmniRoute dashboard"
        className="size-full flex-1 border-0"
      />
    </div>
  );
}

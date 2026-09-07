const OMNIROUTE_DASHBOARD_URL = 'http://localhost:20128/dashboard';

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
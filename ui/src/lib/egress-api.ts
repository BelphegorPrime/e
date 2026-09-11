import { useCallback, useEffect, useState } from 'react';
export interface EgressLogEntry {
  timestamp: string;
  runID: string;
  domain: string;
  protocol: 'DNS';
  action: 'allow' | 'deny(sinkholed)';
}

export interface SquashedEntry {
  domain: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface BlacklistStatus {
  status: 'ok' | 'error';
  reload?: 'manual_required';
  error?: string;
}

export function useEgressLogs() {
  const [logs, setLogs] = useState<EgressLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/egress/logs');
      if (response.ok) setLogs(await response.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  return { logs, loading, load };
}

export function useSquashedEgressLogs() {
  const [logs, setLogs] = useState<SquashedEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/egress/logs/squashed');
      if (response.ok) setLogs(await response.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  return { logs, loading, load };
}

export function useBlacklist() {
  const [domains, setDomains] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/egress/blacklist/domains');
      if (response.ok) {
        const body = await response.json();
        setDomains(body.domains);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  return { domains, loading, load };
}

export async function addBlacklistDomain(
  domain: string
): Promise<BlacklistStatus> {
  const response = await fetch('/api/egress/blacklist/domains', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  return response.json();
}

export async function removeBlacklistDomain(
  domain: string
): Promise<BlacklistStatus> {
  const response = await fetch(`/api/egress/blacklist/domains/${domain}`, {
    method: 'DELETE',
  });
  return response.json();
}

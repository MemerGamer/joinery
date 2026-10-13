/**
 * Bottom-left version label with the update affordance beside it.
 *
 * Fetches `/api/version` once on mount. Clicking "Update to vX" asks the
 * server to run `joinery update`, which restarts the server; we then poll
 * until it answers with a different `current` and reload into the new build.
 */
import type { VersionInfo } from '@joinery/core';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../../lib/apiClient.ts';

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

type Phase = 'idle' | 'updating' | 'failed';

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let live = true;
    callApi('version')
      .then((v) => {
        if (live) setInfo(v);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, []);

  if (info === null) return null;

  const startUpdate = () => {
    const before = info.current;
    setPhase('updating');
    callApi('startUpdate')
      .then(() => {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        timer.current = setInterval(() => {
          void callApi('version')
            .then((v) => {
              if (v.current !== before) location.reload();
            })
            .catch(() => {
              // Server is down mid-restart; keep polling until the deadline.
            });
          if (Date.now() > deadline) {
            if (timer.current !== null) clearInterval(timer.current);
            setPhase('failed');
          }
        }, POLL_MS);
      })
      .catch(() => setPhase('failed'));
  };

  return (
    <div className="absolute bottom-4 left-[3.25rem] z-20 flex h-9 items-center gap-2 text-micro text-chrome-fg-muted">
      <span>v{info.current}</span>
      {phase === 'failed' ? (
        <span>Update failed — run joinery update</span>
      ) : info.updateAvailable && info.latest !== null ? (
        info.mode === 'installed' ? (
          <button type="button" disabled={phase === 'updating'} onClick={startUpdate} className="chrome-btn disabled:opacity-60">
            {phase === 'updating' ? 'Updating…' : `Update to v${info.latest}`}
          </button>
        ) : (
          <span>v{info.latest} available</span>
        )
      ) : null}
    </div>
  );
}

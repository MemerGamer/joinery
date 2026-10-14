/**
 * Bottom-left island showing the current version, with an update segment
 * (button, dev-mode notice or failure message) attached when relevant.
 *
 * Fetches `/api/version` once on mount. Clicking "Update to vX" asks the
 * server to run `joinery update`, which restarts the server; we then poll
 * until it answers with a different `current` and reload into the new build.
 */
import type { VersionInfo } from '@joinery/core';
import { ArrowUpCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../lib/apiClient.ts';

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

type Phase = 'idle' | 'updating' | 'failed';

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);

  // Poll until the server reports a `current` different from `before`, then reload.
  const pollForNewVersion = useCallback(
    (before: string) => {
      stopPolling();
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      const id = setInterval(() => {
        void callApi('version')
          .then((v) => {
            if (timer.current !== id) return; // stopped (reloaded, failed or unmounted)
            if (v.current !== before) {
              stopPolling();
              location.reload();
            }
          })
          .catch(() => {
            // Server is down mid-restart; keep polling until the deadline.
          });
        if (timer.current === id && Date.now() > deadline) {
          stopPolling();
          setPhase('failed');
        }
      }, POLL_MS);
      timer.current = id;
    },
    [stopPolling],
  );

  useEffect(() => {
    let live = true;
    callApi('version')
      .then((v) => {
        if (!live) return;
        setInfo(v);
        if (v.updating) {
          setPhase('updating');
          pollForNewVersion(v.current);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      stopPolling();
    };
  }, [pollForNewVersion, stopPolling]);

  if (info === null) return null;

  const startUpdate = () => {
    setPhase('updating');
    callApi('startUpdate')
      .then(() => pollForNewVersion(info.current))
      .catch(() => setPhase('failed'));
  };

  const segment = 'flex h-full items-center gap-1.5 border-l border-chrome-border px-3';
  const updating = phase === 'updating';

  return (
    <div className="home-island absolute bottom-4 left-[3.25rem] z-20 flex h-9 items-center text-micro text-chrome-fg-muted">
      <span className="px-3">v{info.current}</span>
      {phase === 'failed' ? (
        <span className={`${segment} text-chrome-danger`}>Update failed — run joinery update</span>
      ) : info.updateAvailable && info.latest !== null ? (
        info.mode === 'installed' ? (
          <button
            type="button"
            disabled={updating}
            onClick={startUpdate}
            className={`${segment} bg-chrome-success-bg text-chrome-success transition-colors hover:bg-chrome-success/20 disabled:opacity-60`}
          >
            {updating ? (
              <RefreshCw size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />
            ) : (
              <ArrowUpCircle size={14} strokeWidth={1.75} aria-hidden />
            )}
            {updating ? 'Updating…' : `Update to v${info.latest}`}
          </button>
        ) : (
          <span className={`${segment} text-chrome-success`}>v{info.latest} available</span>
        )
      ) : null}
    </div>
  );
}

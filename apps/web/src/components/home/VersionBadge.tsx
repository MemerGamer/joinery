/**
 * The running version and updates. `useVersion` fetches; `VersionText` is the
 * quiet line at the foot of the Homebase; `UpdateButton` is the green button
 * in its top-right corner, shown only when there's a newer version.
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

export interface VersionState {
  info: VersionInfo | null;
  phase: Phase;
  startUpdate: () => void;
}

export function useVersion(): VersionState {
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

  const startUpdate = () => {
    if (info === null) return;
    setPhase('updating');
    callApi('startUpdate')
      .then(() => pollForNewVersion(info.current))
      .catch(() => setPhase('failed'));
  };

  return { info, phase, startUpdate };
}

/** "Joinery v0.2.1", for the foot of the page. */
export function VersionText({ info }: { info: VersionInfo | null }): React.JSX.Element | null {
  if (info === null) return null;
  return <p className="text-micro text-chrome-fg-subtle">Joinery v{info.current}</p>;
}

/** Green, and only there when a newer version is out (or an update is running or failed). */
export function UpdateButton({ info, phase, startUpdate }: VersionState): React.JSX.Element | null {
  if (info === null) return null;
  const text = 'flex h-7 items-center gap-1.5 px-1.5 text-xs font-medium';
  if (phase === 'failed') {
    return <span className={`${text} text-chrome-danger`}>Update failed — run joinery update</span>;
  }
  if (!info.updateAvailable || info.latest === null) return null;
  if (info.mode !== 'installed') {
    return (
      <span className={`home-update ${text} text-chrome-success`} title="Running from source — pull to update">
        v{info.latest} available
      </span>
    );
  }
  const updating = phase === 'updating';
  return (
    <button
      type="button"
      disabled={updating}
      onClick={startUpdate}
      title={`Update Joinery from v${info.current} to v${info.latest}`}
      className={`home-update ${text} rounded-md text-chrome-success transition-colors hover:bg-chrome-success-bg disabled:opacity-60`}
    >
      {updating ? (
        <RefreshCw size={14} strokeWidth={1.75} className="animate-spin" aria-hidden />
      ) : (
        <ArrowUpCircle size={14} strokeWidth={1.75} aria-hidden />
      )}
      {updating ? 'Updating…' : `Update to v${info.latest}`}
    </button>
  );
}

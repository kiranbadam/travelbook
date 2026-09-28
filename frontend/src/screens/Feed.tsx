import { Badge, Banner, Button, EmptyState, ProgressBar } from '@astryxdesign/core';
import { useEffect, useState } from 'react';
import { useApi } from '../useApi';
import { getPreviewSnapshot, isPreviewMode } from '../preview-data';
import type { ApiError, FeedJobProgress, FeedJobStatus, FeedSnapshot } from '../types';
import { timeAgo } from '../components/bits';
import { FeedCard } from './FeedCard';

const POLL_MS = 3000;

/* Preview-only feed-generation theater: stages shown while "generating". */
const PREVIEW_STAGES = [
  'Checking fares, weather & events',
  'Scoring destinations against your prefs',
  'Hunting luxury car events',
  'Polishing your lineup',
];

function isTerminal(status: FeedJobStatus): boolean {
  return status === 'READY' || status === 'PARTIAL' || status === 'FAILED';
}

export function FeedScreen() {
  const api = useApi();
  const preview = isPreviewMode();

  const [snapshot, setSnapshot] = useState<FeedSnapshot | null>(null);
  const [shared, setShared] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<FeedJobStatus | null>(null);
  const [progress, setProgress] = useState<FeedJobProgress | null>(null);
  const [polling, setPolling] = useState(false);
  const [jobError, setJobError] = useState<ApiError | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  /* Load the latest snapshot on mount, if one exists. */
  useEffect(() => {
    if (preview) {
      // PREVIEW-ONLY: seed mock cards; no auth, no backend.
      setSnapshot(getPreviewSnapshot());
      setInitialLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.getFeed();
        if (!cancelled) setSnapshot(snap);
      } catch {
        // No snapshot yet (or backend not up) — the empty state covers it.
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, preview]);

  /* Poll the job until it reaches a terminal state. */
  useEffect(() => {
    if (preview || !jobId || !polling) return;
    let cancelled = false;
    async function poll() {
      try {
        const job = await api.getFeedJob(jobId as string);
        if (cancelled) return;
        setJobStatus(job.status);
        setProgress(job.progress);
        if (job.status === 'READY' || job.status === 'PARTIAL') {
          setPolling(false);
          const snap = await api.getFeed(job.snapshotId);
          if (!cancelled) {
            setSnapshot(snap);
            setHiddenIds(new Set());
          }
        } else if (job.status === 'FAILED') {
          setPolling(false);
          setJobError(job.error ?? { class: 'UNKNOWN', message: 'Feed generation failed.' });
        }
      } catch (err) {
        if (!cancelled) {
          setPolling(false);
          setJobError({
            class: 'POLL_FAILED',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, polling, api, preview]);

  async function startJob() {
    if (preview) {
      // PREVIEW-ONLY: simulate a feed generation run against the mock data.
      setStarting(true);
      setJobError(null);
      setJobStatus('RUNNING');
      setPolling(true);
      let step = 0;
      setProgress({ completedSteps: 0, totalSteps: PREVIEW_STAGES.length, currentStage: PREVIEW_STAGES[0] });
      const timer = setInterval(() => {
        step += 1;
        if (step >= PREVIEW_STAGES.length) {
          clearInterval(timer);
          setPolling(false);
          setJobStatus('READY');
          setProgress(null);
          setSnapshot(getPreviewSnapshot());
          setHiddenIds(new Set());
          setStarting(false);
        } else {
          setProgress({
            completedSteps: step,
            totalSteps: PREVIEW_STAGES.length,
            currentStage: PREVIEW_STAGES[step],
          });
        }
      }, 700);
      return;
    }
    setStarting(true);
    setJobError(null);
    setLoadError(null);
    try {
      const { jobId: id } = await api.createFeedJob();
      setJobId(id);
      setJobStatus('PENDING');
      setProgress(null);
      setPolling(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  const working = polling || (jobStatus != null && !isTerminal(jobStatus));
  const visibleCards = (snapshot?.cards ?? []).filter((c) => !hiddenIds.has(c.destinationId));

  // Keep the share toggle in sync with the loaded snapshot.
  useEffect(() => {
    setShared(snapshot?.visibility === 'friends');
  }, [snapshot?.snapshotId]);

  async function toggleShare() {
    if (sharing) return;
    if (preview) {
      // PREVIEW-ONLY: local toggle, no backend.
      setShared((s) => !s);
      return;
    }
    setSharing(true);
    try {
      const res = await api.shareFeed(shared ? 'private' : 'friends');
      setShared(res.visibility === 'friends');
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="tb-page tb-feed">
      <div>
        <span className="tb-feed-eyebrow">✨ Fresh drop{preview ? ' · Preview' : ''}</span>
        <h1 className="tb-feed-title">
          Your <span className="tb-accent-word">feed</span>
        </h1>
        <p className="tb-feed-sub">
          Destination ideas scored against your preferences — every fact carries
          its source. {shared ? '👥 Shared with friends.' : '🔒 Private until you share it.'}
        </p>
        <div className="tb-feed-ctas">
          {snapshot && (
            <Button
              label={shared ? 'Unshare feed' : 'Share with friends'}
              variant="secondary"
              isLoading={sharing}
              clickAction={toggleShare}
            />
          )}
          <Button
            label={snapshot ? '✨ Generate new ideas' : '✨ Generate ideas'}
            variant="primary"
            isLoading={starting || working}
            clickAction={startJob}
          />
        </div>
      </div>

      {loadError && (
        <div className="tb-section">
          <Banner status="error" title="Couldn't reach the API" description={loadError} isDismissable onDismiss={() => setLoadError(null)} />
        </div>
      )}

      {working && (
        <div className="tb-section">
          <ProgressBar
            label={progress ? `Working: ${progress.currentStage}` : 'Starting feed generation…'}
            value={progress?.completedSteps ?? 0}
            max={progress?.totalSteps ?? 100}
          />
          <p className="tb-muted" style={{ fontSize: 13 }}>
            Checking flights, weather, events, and risks. This usually takes under a minute.
          </p>
        </div>
      )}

      {jobError && (
        <div className="tb-section">
          <Banner
            status="error"
            title={`Feed generation failed (${jobError.class})`}
            description={jobError.message}
            endContent={<Button label="Retry" variant="primary" clickAction={startJob} />}
          />
        </div>
      )}

      {snapshot?.state === 'PARTIAL' && (
        <div className="tb-section">
          <Banner
            status="warning"
            title="Partial results — some providers failed"
            description={
              snapshot.partialFailures && snapshot.partialFailures.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {snapshot.partialFailures.map((f, i) => (
                    <li key={i}>
                      <strong>{f.provider}:</strong> {f.message}
                    </li>
                  ))}
                </ul>
              ) : (
                'Some evidence could not be refreshed. Shown facts are labeled; missing facts are marked unknown rather than guessed.'
              )
            }
          />
        </div>
      )}

      {initialLoading ? (
        <div className="tb-center">
          <p className="tb-muted">Loading your latest feed…</p>
        </div>
      ) : !snapshot && !working ? (
        <EmptyState
          title="No ideas yet"
          description="Set your preferences, then generate a feed. We'll check fares, weather, events, and travel risks for you."
          actions={<Button label="✨ Generate ideas" variant="primary" clickAction={startJob} />}
        />
      ) : (
        snapshot && (
          <>
            <p className="tb-muted" style={{ fontSize: 13, marginTop: 20 }}>
              Snapshot generated {timeAgo(snapshot.createdAt)}{' '}
              {snapshot.state === 'PARTIAL' ? (
                <Badge variant="warning" label="Partial" />
              ) : (
                <Badge variant="success" label="Complete" />
              )}
            </p>
            {visibleCards.length === 0 ? (
              <EmptyState
                title="Everything is hidden"
                description="You hid every card in this snapshot. Generate new ideas or clear your reactions."
                actions={<Button label="✨ Generate new ideas" variant="primary" clickAction={startJob} />}
              />
            ) : (
              <div className="tb-posts">
                {visibleCards.map((card) => (
                  <FeedCard
                    key={card.destinationId}
                    card={card}
                    onHidden={(id) =>
                      setHiddenIds((prev) => {
                        const next = new Set(prev);
                        next.add(id);
                        return next;
                      })
                    }
                  />
                ))}
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}

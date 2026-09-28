import { Badge, Card } from '@astryxdesign/core';
import { useState } from 'react';
import { useApi } from '../useApi';
import { isPreviewMode } from '../preview-data';
import type { FeedCard as FeedCardT, ReactionKind } from '../types';
import {
  FareBlock,
  RiskBlock,
  ScoreBars,
  SourceChip,
  SourceChips,
} from '../components/bits';

/**
 * Bold-social feed post: photo-forward, Instagram-energy.
 *
 * Layout:
 *   Hero       → full-bleed photo, gradient scrim, overlaid destination name,
 *                hot-pink score pill, Pexels attribution below
 *   Actions    → ♥ Like / 🔖 Save / 🙈 Hide action bar (optimistic)
 *   Body       → Why it matches / Agent's take / Score breakdown /
 *                What we found / What could change / Sources
 *
 * Model narration is rendered clearly labeled as the agent's take — it is
 * additive; the score components and source chips are the explanation.
 */
export function FeedCard({
  card,
  onHidden,
  hideReactions = false,
}: {
  card: FeedCardT;
  onHidden: (id: string) => void;
  /** Friend shared feeds render read-only: no reactions. */
  hideReactions?: boolean;
}) {
  const api = useApi();
  const [reaction, setReaction] = useState<ReactionKind | null>(card.reaction ?? null);
  const [reacting, setReacting] = useState(false);
  const [popping, setPopping] = useState(false);

  async function react(kind: ReactionKind) {
    // Reactions are sticky and replace each other (like ⇄ save); the contract
    // has no "un-react" endpoint, so there is no toggle-off.
    const prev = reaction;
    setReaction(kind);
    if (kind === 'like') {
      setPopping(true);
      window.setTimeout(() => setPopping(false), 400);
    }
    if (kind === 'hide') onHidden(card.destinationId);
    if (isPreviewMode()) return; // preview: keep the optimistic state, no backend
    setReacting(true);
    try {
      await api.postReaction({ destinationId: card.destinationId, kind });
    } catch {
      setReaction(prev); // revert optimistic update
    } finally {
      setReacting(false);
    }
  }

  const entryUnknown = (card.risks ?? []).some(
    (r) => r.type === 'ENTRY_RULE' && r.severity === 'UNKNOWN',
  );

  return (
    <Card className="tb-post">
      {card.heroImage && (
        <>
          <div className="tb-post-hero">
            <img
              src={card.heroImage.url}
              alt={`${card.name} — travel photo`}
              loading="lazy"
            />
            <div className="tb-post-scrim" aria-hidden="true" />
            <div
              className="tb-post-score"
              aria-label={`Score ${Math.round(card.score)} out of 100`}
            >
              {Math.round(card.score)}
              <small>/100</small>
            </div>
            <div className="tb-post-titleblock">
              <div className="tb-post-locale">
                {card.country}
                {card.region ? ` · ${card.region}` : ''}
              </div>
              <h2 className="tb-post-name">{card.name}</h2>
            </div>
          </div>
          <p className="tb-post-credit">
            Photo by{' '}
            <a href={card.heroImage.photographerUrl} target="_blank" rel="noreferrer">
              {card.heroImage.photographer}
            </a>{' '}
            on{' '}
            <a href={card.heroImage.pageUrl} target="_blank" rel="noreferrer">
              Pexels
            </a>
          </p>
        </>
      )}

      {!hideReactions && (
        <div className="tb-post-actions" role="group" aria-label="React to this destination">
          <button
            type="button"
            className={`tb-action${popping ? ' tb-action-pop' : ''}`}
            aria-pressed={reaction === 'like'}
            aria-label="Like this destination"
            disabled={reacting}
            onClick={() => react('like')}
          >
            <span aria-hidden="true">{reaction === 'like' ? '♥' : '♡'}</span>
            <span className="tb-action-label">Like</span>
          </button>
          <button
            type="button"
            className="tb-action"
            aria-pressed={reaction === 'save'}
            aria-label="Save this destination"
            disabled={reacting}
            onClick={() => react('save')}
          >
            <span aria-hidden="true">🔖</span>
            <span className="tb-action-label">Save</span>
          </button>
          <button
            type="button"
            className="tb-action"
            aria-pressed={reaction === 'hide'}
            aria-label="Hide this destination"
            disabled={reacting}
            onClick={() => react('hide')}
          >
            <span aria-hidden="true">🙈</span>
            <span className="tb-action-label">Hide</span>
          </button>
        </div>
      )}

      <div className="tb-post-body">
        {entryUnknown && (
          <div style={{ marginTop: 12 }}>
            <Badge variant="warning" label="Verify before booking — entry rules unresolved" />
          </div>
        )}

        <h3 className="tb-microlabel">Why it matches</h3>
        <ul className="tb-post-reasons">
          {(card.reasons ?? []).map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        {card.narration && (
          <p className="tb-post-take">
            <strong>Agent&apos;s take:</strong> {card.narration}
          </p>
        )}

        <h3 className="tb-microlabel">Score breakdown</h3>
        <ScoreBars
          components={
            card.components ?? {
              airfare: 0,
              weather: 0,
              interest: 0,
              travelTime: 0,
              freshness: 0,
              novelty: 0,
            }
          }
          riskPenalty={card.riskPenalty}
        />

        <h3 className="tb-microlabel">What we found</h3>
        <div className="tb-grid-2">
          <div>
            {card.fare ? (
              <FareBlock fare={card.fare} />
            ) : (
              <p className="tb-muted">No fare evidence for this destination.</p>
            )}
          </div>
          <div>
            {card.weather ? (
              <div>
                <p style={{ margin: '0 0 6px' }}>
                  <strong>{card.weather.windowSummary}</strong>
                </p>
                <p className="tb-muted" style={{ fontSize: 13, margin: '0 0 6px' }}>
                  {card.weather.daysInBand} of {card.weather.totalDays} trip days in your temp band.
                </p>
                <SourceChip source={card.weather.source} />
              </div>
            ) : (
              <p className="tb-muted">No weather evidence for this destination.</p>
            )}
          </div>
        </div>

        {card.events && card.events.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontWeight: 600, margin: '0 0 6px' }}>Matching events</p>
            {card.events.map((ev, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div>
                  {ev.url ? (
                    <a href={ev.url} target="_blank" rel="noreferrer">
                      {ev.name} ↗
                    </a>
                  ) : (
                    <strong>{ev.name}</strong>
                  )}
                  {ev.date && <span className="tb-muted"> · {ev.date}</span>}
                  {ev.venue && <span className="tb-muted"> · {ev.venue}</span>}
                </div>
                <div style={{ marginTop: 4 }}>
                  <SourceChip source={ev.source} />
                </div>
              </div>
            ))}
          </div>
        )}

        {((card.risks ?? []).length > 0 || (card.uncertainties ?? []).length > 0) && (
          <>
            <h3 className="tb-microlabel">What could change</h3>
            {(card.risks ?? []).map((risk, i) => (
              <RiskBlock key={i} risk={risk} />
            ))}
            {(card.uncertainties ?? []).length > 0 && (
              <ul className="tb-reasons" style={{ marginTop: 8 }}>
                {(card.uncertainties ?? []).map((u, i) => (
                  <li key={i} className="tb-muted">
                    {u}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="tb-post-sources">
          <SourceChips sources={card.sources ?? []} />
        </div>
      </div>
    </Card>
  );
}

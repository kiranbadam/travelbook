import { Badge, Card, Heading } from '@astryxdesign/core';
import { useState } from 'react';
import { useApi } from '../useApi';
import type { FeedCard as FeedCardT, ReactionKind } from '../types';
import {
  CardSection,
  FareBlock,
  RiskBlock,
  ScoreBars,
  SourceChip,
  SourceChips,
} from '../components/bits';

/**
 * A feed card is an evidence packet, not a postcard.
 *
 * Layout (per the architecture plan):
 *   Fit        → score + deterministic breakdown bars + "Why it matches"
 *   Evidence   → fare (LIVE vs ILLUSTRATIVE), weather window, events
 *   Caution    → "What could change": expiry, risks, uncertainties
 *   Reactions  → Like / Save / Hide (optimistic)
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

  async function react(kind: ReactionKind) {
    // Reactions are sticky and replace each other (like ⇄ save); the contract
    // has no "un-react" endpoint, so there is no toggle-off.
    const prev = reaction;
    setReaction(kind);
    if (kind === 'hide') onHidden(card.destinationId);
    setReacting(true);
    try {
      await api.postReaction({ destinationId: card.destinationId, kind });
    } catch {
      setReaction(prev); // revert optimistic update
    } finally {
      setReacting(false);
    }
  }

  const entryUnknown = card.risks.some(
    (r) => r.type === 'ENTRY_RULE' && r.severity === 'UNKNOWN',
  );

  return (
    <Card>
      <div className="tb-spread">
        <div>
          <Heading level={2}>
            {card.name}
            <span className="tb-muted" style={{ fontWeight: 400 }}>
              {' '}
              · {card.country}
              {card.region ? ` · ${card.region}` : ''}
            </span>
          </Heading>
        </div>
        <div className="tb-score-total" aria-label={`Score ${Math.round(card.score)} out of 100`}>
          <span className="tb-score-number">{Math.round(card.score)}</span>
          <span className="tb-muted">/ 100</span>
        </div>
      </div>

      {entryUnknown && (
        <div style={{ marginTop: 8 }}>
          <Badge variant="warning" label="Verify before booking — entry rules unresolved" />
        </div>
      )}

      <CardSection title="Why it matches">
        <ul className="tb-reasons">
          {card.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        {card.narration && (
          <p className="tb-narration">
            <strong>Agent&apos;s take:</strong> {card.narration}
          </p>
        )}
      </CardSection>

      <CardSection title="Score breakdown">
        <ScoreBars components={card.components} riskPenalty={card.riskPenalty} />
      </CardSection>

      <CardSection title="What we found">
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
      </CardSection>

      {(card.risks.length > 0 || card.uncertainties.length > 0) && (
        <CardSection title="What could change">
          {card.risks.map((risk, i) => (
            <RiskBlock key={i} risk={risk} />
          ))}
          {card.uncertainties.length > 0 && (
            <ul className="tb-reasons" style={{ marginTop: 8 }}>
              {card.uncertainties.map((u, i) => (
                <li key={i} className="tb-muted">
                  {u}
                </li>
              ))}
            </ul>
          )}
        </CardSection>
      )}

      {!hideReactions && (
        <CardSection title="Reactions">
          <div className="tb-reactions" role="group" aria-label="React to this destination">
            <button
              type="button"
              className="tb-reaction"
              aria-pressed={reaction === 'like'}
              disabled={reacting}
              onClick={() => react('like')}
            >
              👍 Like
            </button>
            <button
              type="button"
              className="tb-reaction"
              aria-pressed={reaction === 'save'}
              disabled={reacting}
              onClick={() => react('save')}
            >
              🔖 Save
            </button>
            <button
              type="button"
              className="tb-reaction"
              aria-pressed={reaction === 'hide'}
              disabled={reacting}
              onClick={() => react('hide')}
            >
              🙈 Hide
            </button>
          </div>
        </CardSection>
      )}

      <div className="tb-card-section">
        <SourceChips sources={card.sources} />
      </div>
    </Card>
  );
}

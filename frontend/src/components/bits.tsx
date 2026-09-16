import { Badge } from '@astryxdesign/core';
import type { ReactNode } from 'react';
import type {
  FareInfo,
  RiskItem,
  RiskSeverity,
  ScoreComponents,
  SourceRef,
} from '../types';
import { SCORE_LABELS, SCORE_WEIGHTS } from '../types';

/* ------------------------------- time ------------------------------------- */

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown time';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ----------------------------- source chips -------------------------------- */
/**
 * Explainability rule: every displayed fact carries a source chip —
 * provider name + checked time. Stale evidence gets a visible "Stale" chip.
 */
export function SourceChip({ source }: { source: SourceRef }) {
  return (
    <span className={`tb-source-chip${source.stale ? ' tb-stale' : ''}`}>
      <span className="tb-source-provider">{source.provider}</span>
      <span>{source.label}</span>
      <span>· checked {timeAgo(source.checkedAt)}</span>
      {source.stale && <Badge variant="warning" label="Stale" />}
      {source.url && (
        <a href={source.url} target="_blank" rel="noreferrer">
          source ↗
        </a>
      )}
    </span>
  );
}

export function SourceChips({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="tb-row" style={{ marginTop: 8 }}>
      {sources.map((s, i) => (
        <SourceChip key={`${s.provider}-${s.label}-${i}`} source={s} />
      ))}
    </div>
  );
}

/* ----------------------------- score breakdown ----------------------------- */
/**
 * The deterministic score components are ALWAYS rendered — model prose is
 * additive and never the only explanation.
 */
const COMPONENT_KEYS = Object.keys(SCORE_WEIGHTS) as (keyof ScoreComponents)[];

export function ScoreBars({
  components,
  riskPenalty,
}: {
  components: ScoreComponents;
  riskPenalty?: number;
}) {
  return (
    <div>
      {COMPONENT_KEYS.map((key) => (
        <div className="tb-scorebar" key={key}>
          <span className="tb-scorebar-label">
            {SCORE_LABELS[key]} · {SCORE_WEIGHTS[key]}%
          </span>
          <div
            className="tb-scorebar-track"
            role="progressbar"
            aria-label={`${SCORE_LABELS[key]} score`}
            aria-valuenow={Math.round(components[key])}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="tb-scorebar-fill"
              style={{ width: `${Math.max(0, Math.min(100, components[key]))}%` }}
            />
          </div>
          <span className="tb-scorebar-value">{Math.round(components[key])}</span>
        </div>
      ))}
      {riskPenalty != null && riskPenalty > 0 && (
        <p className="tb-muted" style={{ fontSize: 13, margin: '6px 0 0' }}>
          −{riskPenalty.toFixed(0)} risk penalty applied to the total.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------- risk ----------------------------------- */

const RISK_META: Record<RiskSeverity, { cls: string; title: string }> = {
  LOW: { cls: 'tb-risk-low', title: 'Note' },
  MODERATE: { cls: 'tb-risk-moderate', title: 'Caution' },
  HIGH: { cls: 'tb-risk-high', title: 'Warning' },
  CRITICAL: { cls: 'tb-risk-critical', title: 'Do not recommend' },
  UNKNOWN: { cls: 'tb-risk-unknown', title: 'Verify before booking' },
};

/**
 * Severity → UI treatment per the architecture plan:
 * LOW = informational note · MODERATE = visible caution · HIGH = expanded
 * warning · CRITICAL = do-not-recommend banner · UNKNOWN = verify banner.
 */
export function RiskBlock({ risk }: { risk: RiskItem }) {
  const meta = RISK_META[risk.severity] ?? RISK_META.UNKNOWN;
  return (
    <div className={`tb-risk ${meta.cls}`} role="note">
      <div className="tb-risk-title">
        <span>{meta.title}</span>
        {risk.severity === 'UNKNOWN' && <Badge variant="warning" label="Verify before booking" />}
        {risk.severity === 'CRITICAL' && <Badge variant="error" label="Critical" />}
      </div>
      <p className="tb-risk-detail">{risk.summary}</p>
      {risk.detail && <p className="tb-risk-detail">{risk.detail}</p>}
      {risk.sourceUrl && (
        <p className="tb-risk-detail">
          <a href={risk.sourceUrl} target="_blank" rel="noreferrer">
            Official source ↗
          </a>
          {risk.observedAt && <> · updated {timeAgo(risk.observedAt)}</>}
        </p>
      )}
    </div>
  );
}

/* ---------------------------------- fare ----------------------------------- */

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

/**
 * Honest labeling: mock/illustrative fares always carry the "Illustrative"
 * badge and are never presented as live prices.
 */
export function FareBlock({ fare, partySize }: { fare: FareInfo; partySize?: number }) {
  const live = fare.kind === 'LIVE';
  return (
    <div>
      <div className="tb-fare">
        <span className="tb-fare-amount">{formatMoney(fare.amount, fare.currency)}</span>
        <Badge
          variant={live ? 'success' : 'warning'}
          label={live ? 'Live price' : 'Illustrative'}
        />
      </div>
      <p className="tb-muted" style={{ fontSize: 13, margin: '4px 0 0' }}>
        {live ? 'Live offer' : 'Illustrative estimate — not a bookable price'}
        {partySize ? ` · per person for ${partySize} traveler${partySize === 1 ? '' : 's'}` : ''}
        {fare.totalForParty != null && ` · ${formatMoney(fare.totalForParty, fare.currency)} total`}
      </p>
      <div style={{ marginTop: 6 }}>
        <SourceChip source={fare.source} />
      </div>
    </div>
  );
}

/* --------------------------------- section --------------------------------- */

export function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tb-card-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

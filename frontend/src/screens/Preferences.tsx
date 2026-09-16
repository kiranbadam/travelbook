import {
  Banner,
  Button,
  Card,
  DateRangeInput,
  Heading,
  NumberInput,
  SegmentedControl,
  SegmentedControlItem,
  TextInput,
} from '@astryxdesign/core';
import type { DateRange } from '@astryxdesign/core/DateRangeInput';
import { useState } from 'react';
import { useApi } from '../useApi';
import type { DateMode, NormalizedPreferences } from '../types';
import { SourceChips } from '../components/bits';

const INTERESTS = [
  'luxury-car events',
  'motorsport',
  'beach',
  'food & drink',
  'hiking & outdoors',
  'museums & art',
  'live music',
  'skiing',
  'city breaks',
  'wildlife',
  'history & culture',
  'nightlife',
];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function PreferencesScreen() {
  const api = useApi();

  const [origin, setOrigin] = useState('SEA');
  const [dateMode, setDateMode] = useState<DateMode>('flexible');
  const [range, setRange] = useState<DateRange | null>(null);
  const [month, setMonth] = useState('');
  const [tempMin, setTempMin] = useState<number | null>(70);
  const [tempMax, setTempMax] = useState<number | null>(90);
  const [ceiling, setCeiling] = useState<number | null>(1000);
  const [partySize, setPartySize] = useState<number | null>(2);
  const [interests, setInterests] = useState<string[]>(['luxury-car events']);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<NormalizedPreferences | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  function toggleInterest(interest: string) {
    setInterests((prev) =>
      prev.includes(interest) ? prev.filter((i) => i !== interest) : [...prev, interest],
    );
  }

  const monthValid = dateMode === 'fixed' || month === '' || MONTH_RE.test(month);
  const canSubmit =
    origin.trim() !== '' &&
    (tempMin ?? 70) <= (tempMax ?? 90) &&
    (ceiling ?? 0) > 0 &&
    (partySize ?? 0) >= 1 &&
    (dateMode === 'flexible' ? monthValid : range !== null);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.putPreferences({
        origin: origin.trim(),
        dateMode,
        startDate: dateMode === 'fixed' && range ? range.start : undefined,
        endDate: dateMode === 'fixed' && range ? range.end : undefined,
        flexibleMonth: dateMode === 'flexible' && month !== '' ? month : undefined,
        tempF: { min: tempMin ?? 70, max: tempMax ?? 90 },
        airfareMaxPerPerson: ceiling ?? 1000,
        partySize: partySize ?? 1,
        interests,
      });
      setSaved(res.preferences);
      setWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tb-page">
      <Heading level={1}>Travel preferences</Heading>
      <p className="tb-muted">
        Tell TravelBook what a good trip looks like. These become hard filters
        (airfare ceiling, temperature band) and soft signals (interests) for scoring.
      </p>

      {error && (
        <div className="tb-section">
          <Banner status="error" title="Couldn't save preferences" description={error} isDismissable onDismiss={() => setError(null)} />
        </div>
      )}

      <Card>
        <div className="tb-grid-2">
          <div className="tb-section">
            <TextInput
              label="Origin airport or city"
              value={origin}
              onChange={setOrigin}
              placeholder="SEA"
              description="Airport code works best, e.g. SEA."
            />
          </div>
          <div className="tb-section">
            <SegmentedControl
              value={dateMode}
              onChange={(v) => setDateMode(v as DateMode)}
              label="Trip dates"
            >
              <SegmentedControlItem value="fixed" label="Fixed dates" />
              <SegmentedControlItem value="flexible" label="Flexible month" />
            </SegmentedControl>
          </div>
        </div>

        {dateMode === 'fixed' ? (
          <div className="tb-section">
            <DateRangeInput
              label="Travel dates"
              value={range}
              onChange={setRange}
              placeholder="Pick a date range"
            />
          </div>
        ) : (
          <div className="tb-section" style={{ maxWidth: 320 }}>
            <TextInput
              label="Flexible month (optional)"
              value={month}
              onChange={setMonth}
              placeholder="2026-12"
              description="YYYY-MM. Leave blank for anytime."
              status={month !== '' && !MONTH_RE.test(month) ? { type: 'error', message: 'Use YYYY-MM format.' } : undefined}
            />
          </div>
        )}

        <div className="tb-grid-2">
          <div className="tb-section">
            <NumberInput label="Min temp (°F)" value={tempMin} onChange={setTempMin} min={-20} max={120} />
          </div>
          <div className="tb-section">
            <NumberInput label="Max temp (°F)" value={tempMax} onChange={setTempMax} min={-20} max={120} />
          </div>
        </div>

        <div className="tb-grid-2">
          <div className="tb-section">
            <NumberInput
              label="Airfare ceiling per person (USD)"
              value={ceiling}
              onChange={setCeiling}
              min={50}
              step={50}
              description="Destinations above this are filtered out."
            />
          </div>
          <div className="tb-section">
            <NumberInput label="Party size" value={partySize} onChange={setPartySize} min={1} max={20} />
          </div>
        </div>

        <div className="tb-section">
          <Heading level={3}>Interests</Heading>
          <div className="tb-chips" role="group" aria-label="Interests">
            {INTERESTS.map((interest) => (
              <button
                key={interest}
                type="button"
                className="tb-chip"
                aria-pressed={interests.includes(interest)}
                onClick={() => toggleInterest(interest)}
              >
                {interest}
              </button>
            ))}
          </div>
        </div>

        <Button
          label="Save preferences"
          variant="primary"
          isLoading={busy}
          isDisabled={!canSubmit}
          clickAction={handleSubmit}
        />
      </Card>

      {warnings.length > 0 && (
        <div className="tb-section" style={{ marginTop: 16 }}>
          <Banner
            status="warning"
            title="Heads up"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            }
          />
        </div>
      )}

      {saved && (
        <div className="tb-section" style={{ marginTop: 16 }}>
          <Card>
            <Heading level={2}>Saved — normalized</Heading>
            <dl className="tb-kv">
              <dt>Origin</dt>
              <dd>{saved.origin}</dd>
              <dt>Airports</dt>
              <dd>{saved.airports.join(', ') || '—'}</dd>
              <dt>Dates</dt>
              <dd>
                {saved.dateMode === 'fixed'
                  ? `${saved.startDate} → ${saved.endDate}`
                  : saved.flexibleMonth ?? 'anytime'}
              </dd>
              <dt>Temp band</dt>
              <dd>
                {saved.tempF.min}–{saved.tempF.max}°F
              </dd>
              <dt>Ceiling</dt>
              <dd>${saved.airfareMaxPerPerson.toLocaleString()} / person</dd>
              <dt>Party</dt>
              <dd>{saved.partySize}</dd>
              <dt>Interests</dt>
              <dd>{saved.interests.join(', ') || '—'}</dd>
              <dt>Bundle</dt>
              <dd>
                <code>{saved.bundleHash.slice(0, 12)}…</code> · v{saved.version}
              </dd>
            </dl>
            <SourceChips
              sources={[
                {
                  provider: 'TravelBook',
                  label: 'preference normalization',
                  checkedAt: new Date().toISOString(),
                },
              ]}
            />
          </Card>
        </div>
      )}
    </div>
  );
}

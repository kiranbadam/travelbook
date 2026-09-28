import { Badge, Banner, Button, Card, DateRangeInput, Heading, TextInput } from '@astryxdesign/core';
import type { DateRange } from '@astryxdesign/core/DateRangeInput';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApi } from '../useApi';
import { useAuth } from '../auth/AuthContext';
import type { GroupRecommendations, Trip, TripDetail } from '../types';
import { getPreviewDestinationName, getPreviewRecommendations, getPreviewTripDetail, getPreviewTrips, isPreviewMode } from '../preview-data';

/* --------------------------------- list ----------------------------------- */

export function TripsScreen() {
  const api = useApi();
  const navigate = useNavigate();
  const preview = isPreviewMode();

  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [range, setRange] = useState<DateRange | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (preview) {
      // PREVIEW-ONLY: seed mock trips; no backend.
      setTrips(getPreviewTrips());
      setLoading(false);
      return;
    }
    try {
      const res = await api.listTrips();
      setTrips(res.trips);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api, preview]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (preview) {
      // PREVIEW-ONLY: jump to the seeded trip detail; no backend.
      setName('');
      setRange(null);
      navigate('/trips/preview-trip-riviera?preview');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api.createTrip({
        name: name.trim(),
        startDate: range?.start,
        endDate: range?.end,
      });
      setName('');
      setRange(null);
      navigate(`/trips/${res.trip.tripId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="tb-page">
      <span className="tb-feed-eyebrow">🧳 Plan together</span>
      <h1 className="tb-feed-title">
        Your <span className="tb-accent-word">trips</span>
      </h1>
      <p className="tb-feed-sub">
        Members rank destinations, and group-fit recommendations
        keep the decision fair — no averaging away objections.
      </p>

      {error && (
        <div className="tb-section" style={{ marginTop: 16 }}>
          <Banner status="error" title="Couldn't load trips" description={error} isDismissable onDismiss={() => setError(null)} />
        </div>
      )}

      <div className="tb-section" style={{ marginTop: 20 }}>
        <Card>
          <Heading level={2}>New trip</Heading>
          <div className="tb-grid-2">
            <div className="tb-section">
              <TextInput label="Trip name" value={name} onChange={setName} placeholder="Winter sun with friends" />
            </div>
            <div className="tb-section">
              <DateRangeInput label="Dates (optional)" value={range} onChange={setRange} placeholder="Pick a range" />
            </div>
          </div>
          <Button label="Create trip" variant="primary" isLoading={creating} isDisabled={name.trim() === ''} clickAction={create} />
        </Card>
      </div>

      {loading ? (
        <p className="tb-muted">Loading trips…</p>
      ) : trips.length === 0 ? (
        <p className="tb-muted">No trips yet — create one above.</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {trips.map((trip) => (
            <Card key={trip.tripId} className="tb-trip-card">
              <div className="tb-spread">
                <div>
                  <p className="tb-trip-name">{trip.name}</p>
                  <p className="tb-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
                    {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : 'Dates TBD'}
                  </p>
                </div>
                <Button label="Open" variant="secondary" clickAction={() => navigate(`/trips/${trip.tripId}${preview ? '?preview' : ''}`)} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- detail ---------------------------------- */

async function resolveNames(
  api: ReturnType<typeof useApi>,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { destination } = await api.getDestination(id);
        map.set(id, destination.name);
      } catch {
        map.set(id, id); // fall back to the raw id
      }
    }),
  );
  return map;
}

export function TripDetailScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const { tokens } = useAuth();
  const preview = isPreviewMode();

  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [ranking, setRanking] = useState<string[]>([]);
  const [recs, setRecs] = useState<GroupRecommendations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [newMemberSub, setNewMemberSub] = useState('');
  const [addingMember, setAddingMember] = useState(false);

  const load = useCallback(async () => {
    if (preview) {
      // PREVIEW-ONLY: seed mock trip detail; no backend.
      const t = getPreviewTripDetail();
      setTrip(t);
      setRanking(t.myRanking.length > 0 ? t.myRanking : t.candidateIds);
      setNames(new Map(t.candidateIds.map((cid) => [cid, getPreviewDestinationName(cid)])));
      setLoading(false);
      return;
    }
    try {
      const { trip: t } = await api.getTrip(id);
      setTrip(t);
      const order = t.myRanking.length > 0 ? t.myRanking : t.candidateIds;
      setRanking(order);
      setNames(await resolveNames(api, t.candidateIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api, id, preview]);

  useEffect(() => {
    void load();
  }, [load]);

  function move(index: number, delta: -1 | 1) {
    setRanking((prev) => {
      const next = [...prev];
      const j = index + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j] as string, next[index] as string];
      return next;
    });
    setSavedNote(false);
  }

  async function saveVote() {
    if (preview) {
      // PREVIEW-ONLY: local confirmation; no backend.
      setSavedNote(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.voteTrip(id, ranking);
      setSavedNote(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function loadRecs() {
    if (preview) {
      // PREVIEW-ONLY: seed mock recommendations; no backend.
      const recs = getPreviewRecommendations();
      setRecs(recs);
      setNames((prev) => {
        const next = new Map(prev);
        for (const cid of [recs.bestOverall, recs.bestBudget, recs.bestWeather, recs.bestSharedInterest]) {
          if (cid && !next.has(cid)) next.set(cid, getPreviewDestinationName(cid));
        }
        return next;
      });
      return;
    }
    setError(null);
    try {
      const { recommendations } = await api.getTripRecommendations(id);
      setRecs(recommendations);
      setNames((prev) => {
        const ids = [recommendations.bestOverall, recommendations.bestBudget, recommendations.bestWeather, recommendations.bestSharedInterest].filter(
          (x): x is string => !!x && !prev.has(x),
        );
        if (ids.length > 0) void resolveNames(api, ids).then((m) => setNames(new Map([...prev, ...m])));
        return prev;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addMember() {
    const sub = newMemberSub.trim();
    if (!sub) return;
    if (preview) {
      // PREVIEW-ONLY: append locally; no backend.
      setTrip((t) =>
        t
          ? { ...t, members: [...t.members, { userSub: sub, displayName: sub.slice(0, 8), role: 'member' as const, joinedAt: new Date().toISOString() }] }
          : t,
      );
      setNewMemberSub('');
      return;
    }
    setAddingMember(true);
    setError(null);
    try {
      await api.addTripMember(id, sub);
      setNewMemberSub('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingMember(false);
    }
  }

  if (loading) return <div className="tb-page"><p className="tb-muted">Loading trip…</p></div>;
  if (!trip) {
    return (
      <div className="tb-page">
        <Banner status="error" title="Trip not found" description={error ?? 'This trip does not exist or you are not a member.'} />
      </div>
    );
  }

  const recCards: { title: string; id?: string; hint: string }[] = recs
    ? [
        { title: 'Best overall', id: recs.bestOverall, hint: 'Fairest pick for the whole group.' },
        { title: 'Best budget', id: recs.bestBudget, hint: 'Kindest to the tightest wallet.' },
        { title: 'Best weather', id: recs.bestWeather, hint: 'Best fit for your temp bands.' },
        { title: 'Best shared interest', id: recs.bestSharedInterest, hint: 'Most overlap in what everyone wants to do.' },
      ]
    : [];

  return (
    <div className="tb-page">
      <span className="tb-feed-eyebrow">🧳 Trip</span>
      <h1 className="tb-feed-title">{trip.name}</h1>
      <p className="tb-feed-sub">
        {trip.startDate && trip.endDate ? `${trip.startDate} → ${trip.endDate}` : 'Dates TBD'} ·{' '}
        {trip.members.length} member{trip.members.length === 1 ? '' : 's'} · 🔒 private trip
      </p>

      {error && (
        <div className="tb-section" style={{ marginTop: 16 }}>
          <Banner status="error" title="Something went wrong" description={error} isDismissable onDismiss={() => setError(null)} />
        </div>
      )}

      <div className="tb-grid-2" style={{ marginTop: 20 }}>
        <div className="tb-section">
          <Card>
            <Heading level={2}>Members</Heading>
            {trip.members.map((m) => (
              <div key={m.userSub} className="tb-friend-row">
                <span className="tb-avatar">
                  {(m.displayName ?? m.userSub).charAt(0).toUpperCase()}
                </span>
                <span className="tb-friend-meta">
                  <strong>{m.displayName ?? m.userSub.slice(0, 8)}</strong>{' '}
                  {m.userSub === tokens?.sub && <Badge variant="info" label="you" />}
                </span>
                <Badge variant={m.role === 'owner' ? 'neutral' : 'blue'} label={m.role} />
              </div>
            ))}
            <div style={{ marginTop: 12 }}>
              <TextInput
                label="Add member by user ID"
                value={newMemberSub}
                onChange={setNewMemberSub}
                placeholder="Paste their Cognito user sub"
                description="Limitation: trips invite by user ID only — there's no email lookup yet. Ask them to copy it from their profile."
              />
              <div style={{ marginTop: 8 }}>
                <Button label="Add member" variant="secondary" isLoading={addingMember} isDisabled={newMemberSub.trim() === ''} clickAction={addMember} />
              </div>
            </div>
          </Card>
        </div>

        <div className="tb-section">
          <Card>
            <Heading level={2}>Your ranking</Heading>
            <p className="tb-muted" style={{ fontSize: 13, marginTop: 0 }}>
              Order the destinations best-first. The server aggregates everyone&apos;s
              rankings deterministically.
            </p>
            {ranking.map((destId, i) => (
              <div className="tb-vote-row" key={destId}>
                <span className="tb-vote-rank">{i + 1}</span>
                <span className="tb-vote-name">{names.get(destId) ?? destId}</span>
                <Button label="Move up" variant="ghost" size="sm" isDisabled={i === 0} clickAction={() => move(i, -1)} />
                <Button label="Move down" variant="ghost" size="sm" isDisabled={i === ranking.length - 1} clickAction={() => move(i, 1)} />
              </div>
            ))}
            <div className="tb-row" style={{ marginTop: 8 }}>
              <Button label="Save my vote" variant="primary" isLoading={saving} isDisabled={ranking.length === 0} clickAction={saveVote} />
              {savedNote && <Badge variant="success" label="Vote saved" />}
            </div>
          </Card>
        </div>
      </div>

      <div className="tb-section">
        <Card>
          <div className="tb-spread">
            <Heading level={2}>Group-fit recommendations</Heading>
            <Button label="Compute" variant="secondary" clickAction={loadRecs} />
          </div>
          {!recs ? (
            <p className="tb-muted">
              Fairness-first: the backend intersects hard constraints (dates, budgets,
              entry rules), scores each destination per traveler, then maximizes
              group utility minus a penalty for the worst-off traveler.
            </p>
          ) : (
            <>
              <div className="tb-grid-2">
                {recCards.map((r) => (
                  <Card key={r.title}>
                    <p className="tb-rec-label">{r.title}</p>
                    <p className="tb-rec-name">
                      {r.id ? (names.get(r.id) ?? r.id) : '—'}
                    </p>
                    <p className="tb-muted" style={{ fontSize: 13, margin: 0 }}>{r.hint}</p>
                  </Card>
                ))}
              </div>
              {recs.note && <p className="tb-note">{recs.note}</p>}
              {recs.memberScores && Object.keys(recs.memberScores).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Heading level={3}>Who benefits, who compromises</Heading>
                  {Object.entries(recs.memberScores).map(([sub, scores]) => (
                    <p key={sub} className="tb-muted" style={{ fontSize: 13, margin: '4px 0' }}>
                      <strong>{sub === tokens?.sub ? 'You' : sub.slice(0, 8)}</strong>:{' '}
                      {Object.entries(scores)
                        .map(([destId, score]) => `${names.get(destId) ?? destId} ${Math.round(score)}`)
                        .join(' · ')}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

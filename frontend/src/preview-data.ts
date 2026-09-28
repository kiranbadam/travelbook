/**
 * PREVIEW-ONLY seed data for design review (`?preview` in the URL).
 *
 * Lets reviewers see the redesigned feed without Cognito credentials or a
 * live backend. NOT used in production: FeedScreen only consults this module
 * when `isPreviewMode()` is true. The hero images are real Pexels CDN URLs
 * (images.pexels.com) with the standard "Photo by {photographer} on Pexels"
 * attribution — the same shape the backend's Pexels provider produces, so
 * this previews exactly what production cards will look like once the
 * Pexels key is live in SSM.
 *
 * NOTE: photographer profile URLs below fall back to Pexels search pages —
 * the production provider resolves exact @-handles via the Pexels API.
 */
import type { FeedCard, FeedSnapshot, Friend, FriendFeed, FriendRequest, GroupRecommendations, Trip, TripDetail } from './types';

export function isPreviewMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('preview');
  } catch {
    return false;
  }
}

const now = Date.now();
const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

function src(provider: string, label: string, minsAgo: number, url?: string) {
  return { provider, label, checkedAt: iso(minsAgo), url };
}

const kyoto: FeedCard = {
  destinationId: 'preview-kyoto',
  name: 'Kyoto',
  country: 'Japan',
  region: 'Kansai',
  heroImage: {
    url: 'https://images.pexels.com/photos/31698252/pexels-photo-31698252.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1',
    photographer: 'Rizk Nas',
    photographerUrl: 'https://www.pexels.com/search/rizk%20nas/',
    pageUrl: 'https://www.pexels.com/photo/beautiful-fushimi-inari-taisha-torii-gates-in-kyoto-31698252/',
  },
  score: 92,
  components: { airfare: 88, weather: 96, interest: 94, travelTime: 82, freshness: 90, novelty: 70 },
  riskPenalty: 2,
  reasons: [
    '26 of 30 trip days land inside your 70–90°F band — peak autumn color season.',
    'Round-trip fare estimate $812 per person — under your $1,000 cap.',
  ],
  narration:
    "Kyoto in late October is the closest thing to a cheat code in this feed: perfect weather, direct-ish routings from SEA, and fares that haven't caught up to demand yet.",
  fare: {
    amount: 812,
    currency: 'USD',
    kind: 'ILLUSTRATIVE',
    source: src('Duffel', 'round-trip fare', 42),
  },
  weather: {
    windowSummary: '26 of 30 trip days within 70–90°F',
    daysInBand: 26,
    totalDays: 30,
    source: src('Open-Meteo', 'daily highs', 38),
  },
  events: [
    {
      name: 'Kyoto Autumn Light-ups (temple illuminations)',
      date: 'Nov 8 – Dec 7',
      venue: 'Kiyomizu-dera & Arashiyama',
      source: src('Ticketmaster', 'event listing', 55),
    },
  ],
  uncertainties: ['Fare is an illustrative estimate — not a bookable price.'],
  risks: [
    {
      type: 'SEASONAL',
      severity: 'LOW',
      summary: 'Typhoon season is tapering off, but one late storm a year still reaches Kansai.',
      observedAt: iso(38),
    },
  ],
  sources: [
    src('Duffel', 'round-trip fare', 42),
    src('Open-Meteo', 'daily highs', 38),
    src('Ticketmaster', 'event listing', 55),
  ],
};

const santorini: FeedCard = {
  destinationId: 'preview-santorini',
  name: 'Santorini',
  country: 'Greece',
  region: 'Cyclades',
  heroImage: {
    url: 'https://images.pexels.com/photos/16511639/pexels-photo-16511639.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1',
    photographer: 'Mike Kw',
    photographerUrl: 'https://www.pexels.com/search/mike%20kw/',
    pageUrl: 'https://www.pexels.com/photo/view-of-white-houses-in-oia-santorini-greece-16511639/',
  },
  score: 88,
  components: { airfare: 74, weather: 98, interest: 88, travelTime: 78, freshness: 92, novelty: 64 },
  riskPenalty: 4,
  reasons: [
    '28 of 30 trip days inside your 70–90°F band — the Aegean at its warmest.',
    'Strong match for "islands + sunsets" from your interest profile.',
  ],
  narration:
    'Santorini trades a pricier flight for near-guaranteed weather. If the fare dips under $900 in the next refresh, this jumps to the top of the feed.',
  fare: {
    amount: 940,
    currency: 'USD',
    kind: 'ILLUSTRATIVE',
    source: src('Duffel', 'round-trip fare', 47),
  },
  weather: {
    windowSummary: '28 of 30 trip days within 70–90°F',
    daysInBand: 28,
    totalDays: 30,
    source: src('Open-Meteo', 'daily highs', 44),
  },
  events: [
    {
      name: 'Sunset catamaran sailing — Oia caldera',
      date: 'Daily',
      venue: 'Oia harbor',
      source: src('Ticketmaster', 'event listing', 61),
    },
  ],
  uncertainties: ['Fare is an illustrative estimate — not a bookable price.'],
  risks: [
    {
      type: 'SEASONAL',
      severity: 'MODERATE',
      summary: 'Meltemi winds peak in August and can cancel ferry crossings for a day at a time.',
      detail: 'Build a buffer day around any ferry-dependent island hops.',
      observedAt: iso(44),
    },
  ],
  sources: [
    src('Duffel', 'round-trip fare', 47),
    src('Open-Meteo', 'daily highs', 44),
    src('Ticketmaster', 'event listing', 61),
  ],
};

const monaco: FeedCard = {
  destinationId: 'preview-monaco',
  name: 'Monaco',
  country: 'Monaco',
  region: 'French Riviera',
  heroImage: {
    url: 'https://images.pexels.com/photos/28193003/pexels-photo-28193003.jpeg?auto=compress&cs=tinysrgb&w=1260&h=750&dpr=1',
    photographer: 'Hudson McDonald',
    photographerUrl: 'https://www.pexels.com/search/hudson%20mcdonald/',
    pageUrl: 'https://www.pexels.com/photo/dusk-panoramic-aerial-view-of-monaco-28193003/',
  },
  score: 95,
  components: { airfare: 81, weather: 90, interest: 100, travelTime: 80, freshness: 96, novelty: 88 },
  riskPenalty: 3,
  reasons: [
    'Perfect interest hit: Top Marques supercar show lands inside your trip window.',
    'Fare estimate $998 per person — squeaks in under your $1,000 cap.',
  ],
  narration:
    "The feed's top pick and it's not close: Monaco pairs your luxury-car-events interest with Riviera weather. Book the show tickets before flights — they sell out first.",
  fare: {
    amount: 998,
    currency: 'USD',
    kind: 'ILLUSTRATIVE',
    source: src('Duffel', 'round-trip fare', 51),
  },
  weather: {
    windowSummary: '25 of 30 trip days within 70–90°F',
    daysInBand: 25,
    totalDays: 30,
    source: src('Open-Meteo', 'daily highs', 49),
  },
  events: [
    {
      name: 'Top Marques Monaco — supercar show',
      date: 'Jun 10–14',
      venue: 'Grimaldi Forum',
      url: 'https://topmarquesmonaco.com',
      source: src('Ticketmaster', 'event listing', 58, 'https://topmarquesmonaco.com'),
    },
  ],
  uncertainties: ['Fare is an illustrative estimate — not a bookable price.'],
  risks: [
    {
      type: 'BOOKING_CONFIDENCE',
      severity: 'MODERATE',
      summary: 'Event-week hotel rates in Monaco run 3–5x normal — Nice is the sane base.',
      detail: 'The 20-minute train from Nice-Ville drops you at Monaco-Monte-Carlo station.',
      observedAt: iso(49),
    },
  ],
  sources: [
    src('Duffel', 'round-trip fare', 51),
    src('Open-Meteo', 'daily highs', 49),
    src('Ticketmaster', 'event listing', 58),
  ],
};

export function getPreviewSnapshot(): FeedSnapshot {
  return {
    snapshotId: 'preview-snapshot',
    createdAt: iso(35),
    state: 'READY',
    cards: [monaco, kyoto, santorini],
    visibility: 'private',
  };
}

/* --------------------- preview trips & friends (design review) ------------- */

export function getPreviewTrips(): Trip[] {
  return [
    {
      tripId: 'preview-trip-riviera',
      name: 'Riviera run with the crew',
      startDate: '2026-06-08',
      endDate: '2026-06-15',
      ownerSub: 'preview-me',
      createdAt: iso(60 * 26),
    },
    {
      tripId: 'preview-trip-kyoto',
      name: 'Autumn in Kyoto',
      startDate: '2026-10-24',
      endDate: '2026-11-02',
      ownerSub: 'preview-me',
      createdAt: iso(60 * 49),
    },
  ];
}

export function getPreviewTripDetail(): TripDetail {
  return {
    ...getPreviewTrips()[0]!,
    members: [
      { userSub: 'preview-me', displayName: 'You', role: 'owner', joinedAt: iso(60 * 26) },
      { userSub: 'preview-priya', displayName: 'Priya', role: 'member', joinedAt: iso(60 * 25) },
      { userSub: 'preview-alex', displayName: 'Alex', role: 'member', joinedAt: iso(60 * 24) },
    ],
    myRanking: ['preview-monaco', 'preview-santorini', 'preview-kyoto'],
    candidateIds: ['preview-monaco', 'preview-kyoto', 'preview-santorini'],
  };
}

/** Resolves preview destination ids to display names (no backend call). */
export function getPreviewDestinationName(id: string): string {
  const map: Record<string, string> = {
    'preview-monaco': 'Monaco',
    'preview-kyoto': 'Kyoto',
    'preview-santorini': 'Santorini',
  };
  return map[id] ?? id;
}

export function getPreviewRecommendations(): GroupRecommendations {
  return {
    bestOverall: 'preview-monaco',
    bestBudget: 'preview-kyoto',
    bestWeather: 'preview-santorini',
    bestSharedInterest: 'preview-monaco',
    note: 'Preview: computed with the same fairness-first algorithm — group utility minus a penalty for the worst-off traveler.',
    memberScores: {
      'preview-me': { 'preview-monaco': 95, 'preview-kyoto': 88, 'preview-santorini': 84 },
      'preview-priya': { 'preview-monaco': 91, 'preview-santorini': 93, 'preview-kyoto': 86 },
    },
  };
}

export function getPreviewFriends(): Friend[] {
  return [
    { userSub: 'preview-priya', displayName: 'Priya', email: 'priya@example.com', friendsSince: iso(60 * 24 * 40) },
    { userSub: 'preview-alex', displayName: 'Alex', email: 'alex@example.com', friendsSince: iso(60 * 24 * 12) },
  ];
}

export function getPreviewIncoming(): FriendRequest[] {
  return [
    { requestId: 'preview-req-1', fromSub: 'preview-sam', fromEmail: 'sam@example.com', toSub: 'preview-me', createdAt: iso(60 * 5) },
  ];
}

export function getPreviewFriendFeed(): FriendFeed {
  return {
    friend: getPreviewFriends()[0]!,
    sharedAt: iso(90),
    cards: [monaco, kyoto],
  };
}

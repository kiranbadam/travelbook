import type { Destination } from "./types.js";

/** Versioned static destination catalog (plan: 20-30 entries, catalog TTL 30d). */
export const CATALOG_VERSION = "2026-09-16.1";

export const CATALOG: Destination[] = [
  { id: "monterey", name: "Monterey", country: "United States", countryCode: "US", airports: ["MRY"], lat: 36.6002, lon: -121.8947, seasonalityTags: ["car-week-aug"], interestTags: ["luxury-car events", "motorsport", "food", "wine", "beach"], timezone: "America/Los_Angeles" },
  { id: "goodwood", name: "Goodwood / Chichester", country: "United Kingdom", countryCode: "GB", airports: ["LGW"], lat: 50.8595, lon: -0.7565, seasonalityTags: ["goodwood-revival-sep"], interestTags: ["luxury-car events", "motorsport", "history"], timezone: "Europe/London" },
  { id: "dubai", name: "Dubai", country: "United Arab Emirates", countryCode: "AE", airports: ["DXB"], lat: 25.2048, lon: 55.2708, seasonalityTags: ["heat-jun-sep"], interestTags: ["luxury-car events", "shopping", "nightlife", "beach"], timezone: "Asia/Dubai" },
  { id: "tokyo", name: "Tokyo", country: "Japan", countryCode: "JP", airports: ["HND", "NRT"], lat: 35.6762, lon: 139.6503, seasonalityTags: ["tokyo-auto-salon-jan"], interestTags: ["luxury-car events", "food", "museums", "shopping"], timezone: "Asia/Tokyo" },
  { id: "austin", name: "Austin", country: "United States", countryCode: "US", airports: ["AUS"], lat: 30.2672, lon: -97.7431, seasonalityTags: ["tornado-season-apr-jun", "heat-jun-sep", "f1-oct"], interestTags: ["motorsport", "music", "food", "luxury-car events"], timezone: "America/Chicago" },
  { id: "miami", name: "Miami", country: "United States", countryCode: "US", airports: ["MIA"], lat: 25.7617, lon: -80.1918, seasonalityTags: ["hurricane-season-jun-nov", "f1-may"], interestTags: ["beach", "nightlife", "motorsport", "luxury-car events"], timezone: "America/New_York" },
  { id: "singapore", name: "Singapore", country: "Singapore", countryCode: "SG", airports: ["SIN"], lat: 1.3521, lon: 103.8198, seasonalityTags: ["f1-sep", "monsoon-nov-jan"], interestTags: ["food", "motorsport", "luxury-car events", "shopping"], timezone: "Asia/Singapore" },
  { id: "monaco", name: "Monaco", country: "Monaco", countryCode: "MC", airports: ["NCE"], lat: 43.7384, lon: 7.4246, seasonalityTags: ["grand-prix-may"], interestTags: ["luxury-car events", "motorsport", "beach"], timezone: "Europe/Monaco" },
  { id: "las-vegas", name: "Las Vegas", country: "United States", countryCode: "US", airports: ["LAS"], lat: 36.1699, lon: -115.1398, seasonalityTags: ["sema-nov", "heat-jun-sep"], interestTags: ["nightlife", "motorsport", "luxury-car events", "food"], timezone: "America/Los_Angeles" },
  { id: "los-angeles", name: "Los Angeles", country: "United States", countryCode: "US", airports: ["LAX"], lat: 34.0522, lon: -118.2437, seasonalityTags: ["la-auto-show-nov"], interestTags: ["luxury-car events", "beach", "museums", "food"], timezone: "America/Los_Angeles" },
  { id: "munich", name: "Munich", country: "Germany", countryCode: "DE", airports: ["MUC"], lat: 48.1351, lon: 11.582, seasonalityTags: ["iaa-sep"], interestTags: ["luxury-car events", "history", "food", "museums"], timezone: "Europe/Berlin" },
  { id: "detroit", name: "Detroit", country: "United States", countryCode: "US", airports: ["DTW"], lat: 42.3314, lon: -83.0458, seasonalityTags: ["auto-show-jan", "winter-dec-feb"], interestTags: ["luxury-car events", "music", "history"], timezone: "America/Detroit" },
  { id: "london", name: "London", country: "United Kingdom", countryCode: "GB", airports: ["LHR"], lat: 51.5074, lon: -0.1278, seasonalityTags: [], interestTags: ["museums", "history", "food", "art", "luxury-car events"], timezone: "Europe/London" },
  { id: "paris", name: "Paris", country: "France", countryCode: "FR", airports: ["CDG"], lat: 48.8566, lon: 2.3522, seasonalityTags: [], interestTags: ["art", "food", "history", "museums", "architecture"], timezone: "Europe/Paris" },
  { id: "rome", name: "Rome", country: "Italy", countryCode: "IT", airports: ["FCO"], lat: 41.9028, lon: 12.4964, seasonalityTags: ["heat-jul-aug"], interestTags: ["history", "food", "art", "architecture"], timezone: "Europe/Rome" },
  { id: "barcelona", name: "Barcelona", country: "Spain", countryCode: "ES", airports: ["BCN"], lat: 41.3874, lon: 2.1686, seasonalityTags: [], interestTags: ["beach", "food", "art", "architecture", "nightlife"], timezone: "Europe/Madrid" },
  { id: "honolulu", name: "Honolulu", country: "United States", countryCode: "US", airports: ["HNL"], lat: 21.3099, lon: -157.8581, seasonalityTags: ["hurricane-season-jun-nov"], interestTags: ["beach", "hiking", "food", "family"], timezone: "Pacific/Honolulu" },
  { id: "cancun", name: "Cancun", country: "Mexico", countryCode: "MX", airports: ["CUN"], lat: 21.1619, lon: -86.8515, seasonalityTags: ["hurricane-season-jun-nov"], interestTags: ["beach", "family", "nightlife"], timezone: "America/Cancun" },
  { id: "dallas", name: "Dallas", country: "United States", countryCode: "US", airports: ["DFW"], lat: 32.7767, lon: -96.797, seasonalityTags: ["tornado-season-apr-jun", "heat-jun-sep"], interestTags: ["food", "motorsport", "museums"], timezone: "America/Chicago" },
  { id: "seattle", name: "Seattle", country: "United States", countryCode: "US", airports: ["SEA"], lat: 47.6062, lon: -122.3321, seasonalityTags: [], interestTags: ["mountains", "hiking", "food", "museums"], timezone: "America/Los_Angeles" },
  { id: "new-york", name: "New York City", country: "United States", countryCode: "US", airports: ["JFK", "EWR", "LGA"], lat: 40.7128, lon: -74.006, seasonalityTags: ["winter-dec-feb"], interestTags: ["museums", "food", "art", "nightlife", "shopping"], timezone: "America/New_York" },
  { id: "san-francisco", name: "San Francisco", country: "United States", countryCode: "US", airports: ["SFO"], lat: 37.7749, lon: -122.4194, seasonalityTags: [], interestTags: ["food", "museums", "hiking", "art"], timezone: "America/Los_Angeles" },
  { id: "chicago", name: "Chicago", country: "United States", countryCode: "US", airports: ["ORD"], lat: 41.8781, lon: -87.6298, seasonalityTags: ["winter-dec-feb"], interestTags: ["food", "museums", "music", "architecture"], timezone: "America/Chicago" },
  { id: "vancouver", name: "Vancouver", country: "Canada", countryCode: "CA", airports: ["YVR"], lat: 49.2827, lon: -123.1207, seasonalityTags: [], interestTags: ["mountains", "hiking", "food", "family"], timezone: "America/Vancouver" },
  { id: "kyoto", name: "Kyoto", country: "Japan", countryCode: "JP", airports: ["KIX"], lat: 35.0116, lon: 135.7681, seasonalityTags: ["cherry-blossom-mar-apr"], interestTags: ["history", "food", "art", "architecture"], timezone: "Asia/Tokyo" },
  { id: "sydney", name: "Sydney", country: "Australia", countryCode: "AU", airports: ["SYD"], lat: -33.8688, lon: 151.2093, seasonalityTags: [], interestTags: ["beach", "food", "hiking", "family"], timezone: "Australia/Sydney" },
];

export const CATALOG_BY_ID = new Map(CATALOG.map((d) => [d.id, d])) as Map<string, Destination>;

/** Haversine distance in miles. */
export function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

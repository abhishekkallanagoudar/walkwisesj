import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { MaterialIcons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';

// App-wide typefaces. Custom fonts ignore fontWeight on Android, so each
// weight is its own family.
const FONT = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semibold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
};
const HEADING_FONT = FONT.bold;

const USER_NAME = 'User';

type LatLng = { latitude: number; longitude: number };

// An address match from the device geocoder, which already has coordinates.
type Suggestion = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
};

type ResolvedPlace = Suggestion;

type Step = {
  instruction: string;
  meters: number;
};

type Route = {
  points: LatLng[];
  meters: number;
  seconds: number;
  steps: Step[];
};

type TravelMode = 'walk' | 'bike' | 'drive';

type GoogleTravelMode = 'walking' | 'bicycling' | 'driving';

const GOOGLE_MODE: Record<TravelMode, GoogleTravelMode> = {
  walk: 'walking',
  bike: 'bicycling',
  drive: 'driving',
};

// Tab order and labels for the travel mode switcher.
const TRAVEL_TABS: {
  mode: TravelMode;
  label: string;
  icon: 'directions-walk' | 'directions-bike' | 'directions-car';
}[] = [
  { mode: 'walk', label: 'Walk', icon: 'directions-walk' },
  { mode: 'bike', label: 'Bike', icon: 'directions-bike' },
  { mode: 'drive', label: 'Drive', icon: 'directions-car' },
];

type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

type Corridor = {
  points: LatLng[];
  bbox: BBox;
};

type CrashSeverity = 'fatal' | 'severe' | 'moderate' | 'minor';

type Crash = {
  id: number;
  at: LatLng;
  severity: CrashSeverity;
  weight: number; // fatal 8 / severe 4 / moderate 2 / minor 1
  ksi: boolean; // killed or severely injured
  // Details shown when a crash dot is tapped.
  dateMs: number | null; // San José local time, stored as if it were UTC
  streets: string;
  narrative: string;
  collisionType: string;
  involvedWith: string;
  lighting: string;
  weather: string;
  hitAndRun: boolean;
  speeding: boolean;
};

type MapRegion = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

type SafetyLevel = 'low' | 'medium' | 'high';

// Current conditions near a route, from Open-Meteo.
type Weather = {
  tempF: number;
  description: string;
};

// A route plus its safety assessment against the San José datasets.
type ScoredRoute = Route & {
  crashes: Crash[];
  corridorMeters: number;
  corridorRatio: number;
  crashCount: number;
  ksiCount: number;
  weightedPerKm: number;
  level: SafetyLevel;
  riskScore: number; // lower = safer
  rank: number; // 0 = safest of the alternatives
};

// Search is keyless: Photon (komoot's free OpenStreetMap search, built for
// search-as-you-type) first, then the phone's own geocoder if Photon is down
// or finds nothing.
const PHOTON_URL = 'https://photon.komoot.io/api/';
// Santa Clara County, roughly. The safety data only covers San José, so
// results from farther away aren't useful.
const SEARCH_BBOX: BBox = [-122.21, 36.89, -121.2, 37.49];

function dedupeByLabel(places: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = p.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function searchPhoton(
  query: string,
  bias: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const params = new URLSearchParams({
    q: query,
    // Rank results near the user, or near downtown before location arrives.
    lat: String(bias?.lat ?? DEFAULT_REGION.latitude),
    lon: String(bias?.lon ?? DEFAULT_REGION.longitude),
    bbox: SEARCH_BBOX.join(','),
    limit: '10',
    lang: 'en',
  });
  const res = await fetch(`${PHOTON_URL}?${params.toString()}`, { signal });
  const json = await res.json();
  const places: Suggestion[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    if (!Array.isArray(c) || c.length < 2) continue;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    // "Starbucks, 1751 North 1st Street, San Jose" / "Park Ave, San Jose".
    const label = [p.name, street, p.city ?? p.district]
      .filter((part, i, all) => part && all.indexOf(part) === i)
      .join(', ');
    if (!label) continue;
    places.push({
      id: `${p.osm_type}${p.osm_id}`,
      label,
      latitude: c[1],
      longitude: c[0],
    });
  }
  return dedupeByLabel(places).slice(0, 6);
}

// Fallback: the phone's own geocoder (Apple's on iOS, the system Geocoder on
// Android) through expo-location. It only matches complete addresses.
function formatAddress(a: Location.LocationGeocodedAddress): string {
  if (a.formattedAddress) return a.formattedAddress;
  const street = a.name ?? [a.streetNumber, a.street].filter(Boolean).join(' ');
  return [street, a.city, a.region].filter(Boolean).join(', ');
}

async function searchDevice(
  query: string,
  bias: { lat: number; lon: number } | null,
): Promise<Suggestion[]> {
  // Without a city the geocoder may pick a same-named street in another state.
  const q = query.includes(',') ? query : `${query}, San Jose, CA`;
  const results = await Location.geocodeAsync(q);
  const center = bias ?? {
    lat: DEFAULT_REGION.latitude,
    lon: DEFAULT_REGION.longitude,
  };
  const byDistance = [...results].sort(
    (a, b) =>
      Math.hypot(a.latitude - center.lat, a.longitude - center.lon) -
      Math.hypot(b.latitude - center.lat, b.longitude - center.lon),
  );
  const places = await Promise.all(
    byDistance.slice(0, 4).map(async ({ latitude, longitude }) => {
      let label = query;
      try {
        const [addr] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (addr) label = formatAddress(addr) || query;
      } catch {
        // Keep the typed text as the label.
      }
      return { id: `${latitude},${longitude}`, label, latitude, longitude };
    }),
  );
  return dedupeByLabel(places);
}

async function searchPlaces(
  query: string,
  bias: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  try {
    const found = await searchPhoton(query, bias, signal);
    if (found.length) return found;
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  return searchDevice(query, bias);
}

// Routing comes from the public OpenStreetMap routing servers (OSRM, run by
// FOSSGIS), which are free and need no key.
const OSRM_URL: Record<GoogleTravelMode, string> = {
  walking: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  bicycling: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
  driving: 'https://routing.openstreetmap.de/routed-car/route/v1/driving',
};

// OSRM describes each maneuver as a type/modifier pair plus a street name.
function stepInstruction(s: any): string {
  const type: string = s.maneuver?.type ?? '';
  const modifier: string = s.maneuver?.modifier ?? '';
  const onto = s.name ? ` onto ${s.name}` : '';
  if (type === 'depart') return s.name ? `Start on ${s.name}` : 'Start';
  if (type === 'arrive') return 'Arrive at your destination';
  if (!modifier || modifier === 'straight') return `Continue${onto}`;
  if (modifier === 'uturn') return `Make a U-turn${onto}`;
  return `Turn ${modifier}${onto}`;
}

// Ask OSRM for one or more routes, each with per-maneuver steps, so we can
// both rank them for safety and show turn-by-turn directions. Walk and Bike
// ask for alternatives to rank; Drive just needs the one default route to
// check for corridor overlap.
async function fetchRoutes(
  from: LatLng,
  to: LatLng,
  mode: GoogleTravelMode = 'walking',
  alternatives = true,
): Promise<Route[]> {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    alternatives: alternatives ? 'true' : 'false',
  });
  const res = await fetch(`${OSRM_URL[mode]}/${coords}?${params.toString()}`);
  const json = await res.json();
  const rs = json.routes;
  if (json.code !== 'Ok' || !Array.isArray(rs) || rs.length === 0) return [];
  return rs.map((r: any) => ({
    points: ((r.geometry?.coordinates ?? []) as number[][]).map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    })),
    meters: r.distance ?? 0,
    seconds: r.duration ?? 0,
    steps: ((r.legs ?? []) as any[])
      .flatMap((leg) => (leg.steps ?? []) as any[])
      .map((s) => ({ instruction: stepInstruction(s), meters: s.distance ?? 0 })),
  }));
}

// US units: feet for short distances, miles (one decimal) beyond ~0.1 mi.
function formatDistance(m: number): string {
  const miles = m / 1609.344;
  return miles < 0.1
    ? `${Math.round((m * 3.28084) / 10) * 10} ft`
    : `${miles.toFixed(1)} mi`;
}

function formatDuration(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// --- San José Vision Zero priority safety corridors (high-injury streets) ---

const SAFETY_CORRIDORS_URL =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
  '/MapServer/514/query?where=1%3D1&outFields=SAFETYPRIORITYSTREET&outSR=4326&f=geojson';

// Local metre-per-degree scale around San José, good enough for city distances.
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((37.3 * Math.PI) / 180);
// A route point within this many metres of a corridor counts as "on" it.
const ON_CORRIDOR_M = 25;
// A crash within this many metres of the route counts as "along" it.
const NEAR_CRASH_M = 40;

// "Crash Locations Last Five Years" — every reported injury crash, not just the
// killed-or-severely-injured ones. NOTE: San José only logs crashes inside its
// own city limits, so county expressways (e.g. Lawrence Expwy) and neighbouring
// cities have little or no data here regardless of their real crash history.
const CRASH_WHERE =
  'FATALINJURIES>0 OR SEVEREINJURIES>0 OR MODERATEINJURIES>0 OR MINORINJURIES>0';

const CRASH_FIELDS = [
  'OBJECTID',
  'FATALINJURIES',
  'SEVEREINJURIES',
  'MODERATEINJURIES',
  'MINORINJURIES',
  'CRASHDATETIME',
  'INTASTREETNAME',
  'INTBSTREETNAME',
  'NARRATIVE',
  'COLLISIONTYPE',
  'VEHICLEINVOLVEDWITH',
  'LIGHTING',
  'WEATHER',
  'HITANDRUNFLAG',
  'SPEEDINGFLAG',
].join(',');

// Newest first, so when a busy area hits the record limit the recent crashes
// are the ones kept.
function crashesUrl(box: BBox, limit: number): string {
  const geometry = box.join(',');
  return (
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
    '/MapServer/553/query?where=' +
    encodeURIComponent(CRASH_WHERE) +
    `&geometry=${geometry}` +
    '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326' +
    `&outFields=${CRASH_FIELDS}` +
    '&orderByFields=CRASHDATETIME%20DESC' +
    `&resultRecordCount=${limit}&returnGeometry=true&f=geojson`
  );
}

// The dataset stores street names in capitals ("SANTA CLARA ST").
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function toXY(p: LatLng): { x: number; y: number } {
  return { x: p.longitude * M_PER_DEG_LON, y: p.latitude * M_PER_DEG_LAT };
}

function segMeters(a: LatLng, b: LatLng): number {
  const A = toXY(a);
  const B = toXY(b);
  return Math.hypot(B.x - A.x, B.y - A.y);
}

function pointToSegMeters(p: LatLng, a: LatLng, b: LatLng): number {
  const P = toXY(p);
  const A = toXY(a);
  const B = toXY(b);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

function bboxOf(pts: LatLng[]): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of pts) {
    minLon = Math.min(minLon, p.longitude);
    maxLon = Math.max(maxLon, p.longitude);
    minLat = Math.min(minLat, p.latitude);
    maxLat = Math.max(maxLat, p.latitude);
  }
  return [minLon, minLat, maxLon, maxLat];
}

function bboxIntersect(a: BBox, b: BBox, pad = 0): boolean {
  return (
    a[0] - pad <= b[2] &&
    a[2] + pad >= b[0] &&
    a[1] - pad <= b[3] &&
    a[3] + pad >= b[1]
  );
}

function padBBox(b: BBox, deg: number): BBox {
  return [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];
}

// A map region that frames a whole route with a little breathing room.
function regionForRoute(pts: LatLng[]): MapRegion {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(pts);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.5),
    longitudeDelta: Math.max(0.01, (maxLon - minLon) * 1.5),
  };
}

async function fetchSafetyCorridors(): Promise<Corridor[]> {
  const res = await fetch(SAFETY_CORRIDORS_URL);
  const json = await res.json();
  const out: Corridor[] = [];
  for (const f of json.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    const lines: number[][][] =
      g.type === 'LineString'
        ? [g.coordinates]
        : g.type === 'MultiLineString'
          ? g.coordinates
          : [];
    for (const line of lines) {
      const points: LatLng[] = line
        .filter((c) => Array.isArray(c) && c.length >= 2)
        .map(([lon, lat]) => ({ latitude: lat, longitude: lon }));
      if (points.length < 2) continue;
      out.push({
        points,
        bbox: bboxOf(points),
      });
    }
  }
  return out;
}

async function fetchCrashes(
  box: BBox,
  limit = 2000,
  signal?: AbortSignal,
): Promise<Crash[]> {
  const res = await fetch(crashesUrl(box, limit), { signal });
  const json = await res.json();
  const out: Crash[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const p = f.properties ?? {};
    const fatal = Number(p.FATALINJURIES ?? 0) > 0;
    const severe = Number(p.SEVEREINJURIES ?? 0) > 0;
    const moderate = Number(p.MODERATEINJURIES ?? 0) > 0;
    const severity: CrashSeverity = fatal
      ? 'fatal'
      : severe
        ? 'severe'
        : moderate
          ? 'moderate'
          : 'minor';
    out.push({
      id: Number(p.OBJECTID ?? out.length),
      at: { latitude: c[1], longitude: c[0] },
      severity,
      weight: fatal ? 8 : severe ? 4 : moderate ? 2 : 1,
      ksi: fatal || severe,
      dateMs: typeof p.CRASHDATETIME === 'number' ? p.CRASHDATETIME : null,
      streets: [p.INTASTREETNAME, p.INTBSTREETNAME]
        .filter(Boolean)
        .map(titleCase)
        .join(' & '),
      narrative: p.NARRATIVE ?? '',
      collisionType: p.COLLISIONTYPE ?? '',
      involvedWith: p.VEHICLEINVOLVEDWITH ?? '',
      lighting: p.LIGHTING ?? '',
      weather: p.WEATHER ?? '',
      hitAndRun: p.HITANDRUNFLAG === 'True',
      speeding: p.SPEEDINGFLAG === 'True',
    });
  }
  return out;
}

function crashesNearRoute(routePts: LatLng[], all: Crash[]): Crash[] {
  return all.filter((cr) => {
    for (let i = 0; i < routePts.length - 1; i++) {
      if (pointToSegMeters(cr.at, routePts[i], routePts[i + 1]) <= NEAR_CRASH_M) {
        return true;
      }
    }
    return false;
  });
}

// Rate one route: metres on Vision Zero priority safety corridors, plus the
// severity-weighted injury crashes alongside it (fatal 8 / severe 4 / moderate 2
// / minor 1). Lower riskScore = safer / calmer.
function scoreRoute(
  route: Route,
  corridors: Corridor[],
  allCrashes: Crash[],
): ScoredRoute {
  const box = bboxOf(route.points);
  const nearCorridors = corridors.filter((c) =>
    bboxIntersect(c.bbox, box, 0.003),
  );

  let total = 0;
  let onCorridor = 0;
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const segLen = segMeters(a, b);
    total += segLen;
    const mid: LatLng = {
      latitude: (a.latitude + b.latitude) / 2,
      longitude: (a.longitude + b.longitude) / 2,
    };
    let near = false;
    for (const c of nearCorridors) {
      if (near) break;
      for (let j = 0; j < c.points.length - 1; j++) {
        if (pointToSegMeters(mid, c.points[j], c.points[j + 1]) <= ON_CORRIDOR_M) {
          near = true;
          break;
        }
      }
    }
    if (near) onCorridor += segLen;
  }

  const corridorRatio = total > 0 ? onCorridor / total : 0;
  const crashes = crashesNearRoute(route.points, allCrashes);
  const km = total / 1000;
  const crashCount = crashes.length;
  const ksiCount = crashes.filter((c) => c.ksi).length;
  const crashWeight = crashes.reduce((sum, c) => sum + c.weight, 0);
  const weightedPerKm = km > 0 ? crashWeight / km : 0;

  // Amber on any injury history along the route; red where injuries are frequent
  // (severity-weighted) or anyone was killed or severely hurt.
  const high =
    corridorRatio >= 0.25 || weightedPerKm >= 8 || ksiCount >= 1;
  const medium =
    corridorRatio >= 0.05 || weightedPerKm >= 3 || crashCount >= 3;
  const level: SafetyLevel = high ? 'high' : medium ? 'medium' : 'low';

  // Corridor exposure dominates the ranking; the weighted crash rate and any KSI
  // only separate routes whose corridor use is close.
  const riskScore =
    corridorRatio * 10000 + weightedPerKm * 5 + ksiCount * 25;

  return {
    ...route,
    crashes,
    corridorMeters: onCorridor,
    corridorRatio,
    crashCount,
    ksiCount,
    weightedPerKm,
    level,
    riskScore,
    rank: 0,
  };
}

// A route only counts as genuinely clear if it neither touches a safety
// corridor nor has a nearby death/severe-injury crash — the two things that
// actually draw alarming amber lines / red dots on the map.
function isRouteClear(r: ScoredRoute): boolean {
  return r.corridorMeters === 0 && r.ksiCount === 0;
}

// Rank-based name for a route among its alternatives (0 = safest). If even
// the top-ranked route isn't genuinely clear, don't oversell it as "Calmest".
function routeName(r: ScoredRoute, total: number): string {
  if (total < 2) return isRouteClear(r) ? 'Your route' : 'Moderately safe';
  if (r.rank <= 0) return isRouteClear(r) ? 'Calmest' : 'Moderately safe';
  if (r.rank >= total - 1) return 'Busier streets';
  return 'Middle route';
}

// Calmest (green) -> middle (yellow) -> busiest (red).
function safetyColor(level: SafetyLevel): string {
  return level === 'low' ? '#34C759' : level === 'medium' ? '#FFCC00' : '#FF3B30';
}

// The dot shown next to each ranked alternative: rank-based among the current
// alternatives — busiest is red, anything in between is yellow — but the top
// rank only gets green if it's genuinely clear; otherwise yellow, matching
// the "Moderately safe" label instead of a falsely reassuring green.
function dotLevel(r: ScoredRoute, all: ScoredRoute[]): SafetyLevel {
  if (all.length < 2) return isRouteClear(r) ? 'low' : 'medium';
  if (r.rank === 0) return isRouteClear(r) ? 'low' : 'medium';
  if (r.rank === all.length - 1) return 'high';
  return 'medium';
}

// Translucent variant for the un-selected alternative routes.
function altColor(level: SafetyLevel): string {
  return level === 'low'
    ? 'rgba(52,199,89,0.75)'
    : level === 'medium'
      ? 'rgba(255,204,0,0.75)'
      : 'rgba(255,59,48,0.8)';
}

// --- Crash dots on the map ---

// Where the map starts if the device location isn't available: downtown San José.
const DEFAULT_REGION: MapRegion = {
  latitude: 37.3382,
  longitude: -121.8863,
  latitudeDelta: 0.03,
  longitudeDelta: 0.03,
};
// Crash dots only load once the map is zoomed in at least this far, so a
// city-wide view doesn't try to draw thousands of markers.
const MAX_CRASH_DELTA = 0.06;
const MAP_CRASH_LIMIT = 500;

// Red = death or severe injury, orange = moderate, green = minor.
function crashColor(c: Crash): string {
  return c.ksi ? '#FF3B30' : c.severity === 'moderate' ? '#FF9500' : '#34C759';
}

function crashTitle(c: Crash): string {
  switch (c.severity) {
    case 'fatal':
      return 'Fatal crash';
    case 'severe':
      return 'Severe injury crash';
    case 'moderate':
      return 'Moderate injury crash';
    default:
      return 'Minor injury crash';
  }
}

function formatCrashDate(ms: number): string {
  // The timestamp already holds local time, so format it as UTC to avoid
  // shifting it by the phone's own time zone.
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function bboxOfRegion(r: MapRegion): BBox {
  return [
    r.longitude - r.longitudeDelta / 2,
    r.latitude - r.latitudeDelta / 2,
    r.longitude + r.longitudeDelta / 2,
    r.latitude + r.latitudeDelta / 2,
  ];
}

function googleMapsUrl(route: Route, mode: GoogleTravelMode = 'walking'): string {
  const pts = route.points;
  const at = (p: LatLng) => `${p.latitude},${p.longitude}`;
  const params = new URLSearchParams({
    api: '1',
    origin: at(pts[0]),
    destination: at(pts[pts.length - 1]),
    travelmode: mode,
  });
  // Walking and biking only: Google Maps has no way to accept a full custom
  // path, so we pin a handful of points from this route as waypoints, keeping
  // Google close to the calmest (or busier) line we picked instead of letting
  // it choose its own route. Driving intentionally skips this — it's just
  // Google's own default route, not one we ranked or chose.
  if (mode !== 'driving') {
    const inner = pts.slice(1, -1);
    const want = Math.min(8, inner.length); // consumer Google Maps caps at ~9
    const waypoints: string[] = [];
    for (let i = 1; i <= want; i++) {
      const p = inner[Math.floor((i * inner.length) / (want + 1))];
      if (p) waypoints.push(at(p));
    }
    if (waypoints.length) params.set('waypoints', waypoints.join('|'));
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function openInGoogleMaps(route: Route, mode: GoogleTravelMode = 'walking') {
  Linking.openURL(googleMapsUrl(route, mode)).catch(() =>
    Alert.alert('Could not open Google Maps on this device.'),
  );
}

// --- Weather (Open-Meteo, free and no key required) ---

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather codes, per Open-Meteo's docs.
function weatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Foggy',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Rain showers',
    81: 'Rain showers',
    82: 'Heavy rain showers',
    85: 'Snow showers',
    86: 'Snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with hail',
  };
  return descriptions[code] ?? 'Current conditions';
}

// Current conditions near a point along the route (Fahrenheit, for San José).
async function fetchWeather(point: LatLng): Promise<Weather | null> {
  const params = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    current_weather: 'true',
    temperature_unit: 'fahrenheit',
  });
  const res = await fetch(`${OPEN_METEO_URL}?${params.toString()}`);
  const json = await res.json();
  const current = json.current_weather;
  if (!current) return null;
  return {
    tempF: Math.round(current.temperature),
    description: weatherDescription(current.weathercode),
  };
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });
  // Walk and Bike show ranked alternatives with a full safety overlay; Drive
  // is a single default route with just a corridor-overlap check.
  const [travelMode, setTravelMode] = useState<TravelMode>('walk');
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ResolvedPlace | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [scored, setScored] = useState<ScoredRoute[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [outOfArea, setOutOfArea] = useState(false);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  // Drive's single route, scored just for its corridor overlap.
  const [driveResult, setDriveResult] = useState<ScoredRoute | null>(null);
  // Current conditions near the route, fetched alongside it.
  const [weather, setWeather] = useState<Weather | null>(null);
  // Device location, used to bias results toward what's nearby. State (not a
  // ref) so a search that ran before location arrived re-runs once it does.
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  // Skip the lookup that would otherwise fire right after we set the text ourselves.
  const skipNextLookup = useRef(false);

  const mapRef = useRef<MapView>(null);
  // The map's current view, which decides which crash dots to load.
  const [region, setRegion] = useState<MapRegion>(DEFAULT_REGION);
  const [mapCrashes, setMapCrashes] = useState<Crash[]>([]);
  // The crash dot the user tapped, shown in a details card under the map.
  const [pickedCrash, setPickedCrash] = useState<Crash | null>(null);
  // The map waits for the location lookup to finish so it can open centered
  // on the user instead of jumping there after it has already rendered.
  const [locationChecked, setLocationChecked] = useState(false);

  const active = scored[activeIdx] ?? null;
  // Walk and Bike rank alternatives for safety; Drive doesn't.
  const ranksRoutes = travelMode !== 'drive';
  // The route button stays disabled until there's an address to route to.
  const canRoute = address.trim().length > 0;

  function switchMode(mode: TravelMode) {
    if (mode === travelMode) return;
    setTravelMode(mode);
    setRoutes([]);
    setDriveResult(null);
    setWeather(null);
  }

  // Priority safety corridors near whichever route(s) are showing right now,
  // for the map overlay — Walk/Bike alternatives, or Drive's single route.
  const nearbyCorridors = useMemo(() => {
    const routesShown: Route[] =
      ranksRoutes ? scored : driveResult ? [driveResult] : [];
    if (!routesShown.length) return [];
    const box = routesShown.reduce<BBox>(
      (acc, r) => {
        const b = bboxOf(r.points);
        return [
          Math.min(acc[0], b[0]),
          Math.min(acc[1], b[1]),
          Math.max(acc[2], b[2]),
          Math.max(acc[3], b[3]),
        ];
      },
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    return corridors.filter((c) => bboxIntersect(c.bbox, box, 0.003));
  }, [ranksRoutes, scored, driveResult, corridors]);

  // Ask for location once on mount; it centers the map and biases search
  // results toward what's nearby.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        // A recent cached fix is instant; otherwise get a fresh one, but don't
        // leave the map waiting forever if the GPS never answers.
        const pos =
          (await Location.getLastKnownPositionAsync({
            maxAge: 60_000,
            requiredAccuracy: 200,
          })) ??
          (await Promise.race([
            Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
          ]));
        if (!pos) return;
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setRegion({
          ...DEFAULT_REGION,
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
      } catch {
        // No location available; the map stays on San José and searches
        // fall back to global ranking.
      } finally {
        setLocationChecked(true);
      }
    })();
  }, []);

  // Frame the route being shown whenever it changes.
  useEffect(() => {
    const pts = ranksRoutes ? active?.points : driveResult?.points;
    if (pts?.length) mapRef.current?.animateToRegion(regionForRoute(pts), 400);
  }, [ranksRoutes, active, driveResult]);

  // Load the crash dots for whatever part of the map is in view, once the
  // user stops panning.
  useEffect(() => {
    if (region.latitudeDelta > MAX_CRASH_DELTA) {
      setMapCrashes([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchCrashes(bboxOfRegion(region), MAP_CRASH_LIMIT, controller.signal)
        .then(setMapCrashes)
        .catch(() => {});
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [region]);

  useEffect(() => {
    if (skipNextLookup.current) {
      skipNextLookup.current = false;
      return;
    }

    const query = address.trim();
    if (query.length < 3) {
      setSuggestions([]);
      setLoading(false);
      return;
    }

    // Photon requests are aborted when the text changes; the device-geocoder
    // fallback can't be, so its late answers are ignored via the same signal.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const found = await searchPlaces(query, coords, controller.signal);
        if (!controller.signal.aborted) setSuggestions(found);
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address, coords]);

  function handleSelect(item: Suggestion) {
    Keyboard.dismiss();
    skipNextLookup.current = true;
    setAddress(item.label);
    setSuggestions([]);
    setSelected(item);
  }

  // Load San José's priority safety corridors once.
  useEffect(() => {
    fetchSafetyCorridors()
      .then(setCorridors)
      .catch(() => setCorridors([]));
  }, []);

  // Score every alternative against the Vision Zero safety corridors and the
  // reported injury-crash history, then pick the safest as active.
  useEffect(() => {
    if (!routes.length) {
      setScored([]);
      setActiveIdx(0);
      setOutOfArea(false);
      return;
    }

    let cancelled = false;
    (async () => {
      // One crash fetch covering the bounding box of all alternatives.
      const allBox = routes.reduce<BBox>(
        (acc, r) => {
          const b = bboxOf(r.points);
          return [
            Math.min(acc[0], b[0]),
            Math.min(acc[1], b[1]),
            Math.max(acc[2], b[2]),
            Math.max(acc[3], b[3]),
          ];
        },
        [Infinity, Infinity, -Infinity, -Infinity],
      );
      let allCrashes: Crash[] = [];
      try {
        allCrashes = await fetchCrashes(padBBox(allBox, 0.003));
      } catch {
        allCrashes = [];
      }
      if (cancelled) return;

      const s = routes.map((r) => scoreRoute(r, corridors, allCrashes));
      // Sort so the calmest route displays first, busiest last — but a
      // genuinely clear route (no corridor, no KSI crash nearby) always beats
      // one that merely scores lower on the weighted risk formula, so we
      // never rank a route with visible injury/death markers as "Calmest"
      // over one that has none at all.
      const bySafety = [...s].sort((a, b) => {
        const aClear = isRouteClear(a) ? 0 : 1;
        const bClear = isRouteClear(b) ? 0 : 1;
        if (aClear !== bClear) return aClear - bClear;
        return a.riskScore - b.riskScore;
      });
      bySafety.forEach((r, i) => {
        r.rank = i;
      });

      setScored(bySafety);
      setActiveIdx(0);
      setOutOfArea(
        corridors.length > 0 &&
          allCrashes.length === 0 &&
          s.every((r) => r.corridorMeters === 0),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [routes, corridors]);

  // Resolves the address to coordinates, using the already-picked suggestion
  // if there is one, otherwise geocoding the text and taking the closest match.
  async function resolveDestination(query: string): Promise<ResolvedPlace | null> {
    if (selected) return selected;
    const results = await searchPlaces(query, coords);
    const dest = results[0] ?? null;
    if (dest) {
      skipNextLookup.current = true;
      setAddress(dest.label);
      setSelected(dest);
      setSuggestions([]);
    }
    return dest;
  }

  async function handleRoute() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    if (!coords) {
      Alert.alert('Enable location access to get directions.');
      return;
    }

    setLoading(true);
    try {
      const dest = await resolveDestination(query);
      if (!dest) {
        Alert.alert('No matching address found.');
        return;
      }
      setSuggestions([]);
      const origin = {
        latitude: coords.lat,
        longitude: coords.lon,
      };
      const destination = { latitude: dest.latitude, longitude: dest.longitude };
      const midpoint = {
        latitude: (origin.latitude + destination.latitude) / 2,
        longitude: (origin.longitude + destination.longitude) / 2,
      };
      const [found] = await Promise.all([
        fetchRoutes(origin, destination, GOOGLE_MODE[travelMode]),
        fetchWeather(midpoint)
          .then(setWeather)
          .catch(() => setWeather(null)),
      ]);
      if (!found.length) {
        Alert.alert(
          `Could not find a ${travelMode === 'bike' ? 'bike' : 'walking'} route to that address.`,
        );
        return;
      }
      setRoutes(found);
    } catch {
      Alert.alert('Something went wrong loading directions.');
    } finally {
      setLoading(false);
    }
  }

  // Drive: a single default route, checked only for whether it crosses a
  // Vision Zero safety corridor. No alternatives, no ranking, no in-app map —
  // actual navigation is handed off to the Google Maps app.
  async function handleDriveCheck() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    if (!coords) {
      Alert.alert('Enable location access to check the route.');
      return;
    }

    setLoading(true);
    try {
      const dest = await resolveDestination(query);
      if (!dest) {
        Alert.alert('No matching address found.');
        return;
      }
      setSuggestions([]);
      const origin = { latitude: coords.lat, longitude: coords.lon };
      const destination = { latitude: dest.latitude, longitude: dest.longitude };
      const found = await fetchRoutes(origin, destination, 'driving', false);
      if (!found.length) {
        Alert.alert('Could not find a driving route to that address.');
        return;
      }
      // No crash data for drive — keep it to just the corridor-overlap check.
      setDriveResult(scoreRoute(found[0], corridors, []));
    } catch {
      Alert.alert('Something went wrong checking the route.');
    } finally {
      setLoading(false);
    }
  }

  if (!fontsLoaded) {
    return <View style={styles.container} />;
  }

  // The route drawn on the map: the chosen walk/bike option, or Drive's route.
  const shownRoute: Route | null = ranksRoutes ? active : driveResult;
  const findRoute = () => (ranksRoutes ? handleRoute() : handleDriveCheck());
  const currentTab = TRAVEL_TABS.find((t) => t.mode === travelMode)!;
  const crashDetails = pickedCrash
    ? [
        [
          pickedCrash.collisionType,
          pickedCrash.involvedWith && `with ${pickedCrash.involvedWith}`,
        ]
          .filter(Boolean)
          .join(' '),
        [pickedCrash.lighting, pickedCrash.weather].filter(Boolean).join(' · '),
        [pickedCrash.hitAndRun && 'Hit and run', pickedCrash.speeding && 'Speeding']
          .filter(Boolean)
          .join(' · '),
      ].filter(Boolean)
    : [];

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollBody}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchBar}>
          <Text style={styles.greeting}>
            Welcome to SafeRoutes San Jose, {USER_NAME}
          </Text>

          <View style={styles.tabRow} accessibilityRole="tablist">
            {TRAVEL_TABS.map(({ mode, label, icon }) => {
              const isActive = travelMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={styles.tabButton}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                  onPress={() => switchMode(mode)}
                >
                  <MaterialIcons
                    name={icon}
                    size={28}
                    color={isActive ? '#007AFF' : '#8E8E93'}
                  />
                  <Text
                    style={[styles.tabButtonText, isActive && styles.tabButtonTextActive]}
                  >
                    {label}
                  </Text>
                  <View
                    style={[styles.tabIndicator, isActive && styles.tabIndicatorActive]}
                  />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={address}
              onChangeText={(text) => {
                setSelected(null);
                setRoutes([]);
                setDriveResult(null);
                setWeather(null);
                setAddress(text);
              }}
              placeholder="enter address here"
              placeholderTextColor="#8E8E93"
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
              clearButtonMode="while-editing"
              selectTextOnFocus
              onSubmitEditing={findRoute}
            />
          </View>

          {suggestions.length > 0 && (
            <View style={styles.suggestions}>
              {suggestions.map((item) => (
                <Pressable
                  key={item.id}
                  style={styles.suggestionRow}
                  onPress={() => handleSelect(item)}
                >
                  <Text style={styles.suggestionText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <View style={[styles.controls, styles.controlsAboveMap]}>
          <View style={[styles.modeRow, styles.modeRowAboveMap]}>
            <Pressable
              disabled={!canRoute}
              style={({ pressed }) => [
                styles.modeButton,
                canRoute ? styles.modeButtonActive : styles.modeButtonDisabled,
                pressed && styles.modeButtonPressed,
              ]}
              onPress={findRoute}
            >
              <View style={styles.modeButtonContent}>
                <MaterialIcons
                  name={currentTab.icon}
                  size={26}
                  color={canRoute ? '#fff' : styles.modeButtonTextDisabled.color}
                />
                <Text
                  style={[
                    styles.modeButtonText,
                    !canRoute && styles.modeButtonTextDisabled,
                  ]}
                >
                  {ranksRoutes ? 'Find safe route' : 'Check for safety corridors'}
                </Text>
              </View>
            </Pressable>
          </View>

          {loading && <ActivityIndicator style={styles.spinner} />}
        </View>

        <View style={styles.mapWrap}>
          {!locationChecked ? (
            <ActivityIndicator style={styles.map} />
          ) : (
            <MapView
              ref={mapRef}
              style={styles.map}
              // `region` holds the user's location here if it was found.
              initialRegion={region}
              showsUserLocation
              showsMyLocationButton
              onRegionChangeComplete={(r) => setRegion(r)}
              onPress={(e) => {
                // iOS also reports marker taps here; only a tap on empty map
                // should close the details card.
                if (e.nativeEvent.action !== 'marker-press') setPickedCrash(null);
              }}
            >
              {nearbyCorridors.map((c, i) => (
                <Polyline
                  key={`corridor-${i}`}
                  coordinates={c.points}
                  strokeColor="rgba(255,159,10,0.5)"
                  strokeWidth={7}
                />
              ))}
              {ranksRoutes &&
                scored.map((r, i) =>
                  i === activeIdx ? null : (
                    <Polyline
                      key={`alt-${i}`}
                      coordinates={r.points}
                      strokeColor={altColor(r.level)}
                      strokeWidth={3}
                      lineDashPattern={[6, 6]}
                    />
                  ),
                )}
              {shownRoute && (
                <Polyline
                  coordinates={shownRoute.points}
                  strokeColor="#007AFF"
                  strokeWidth={5}
                />
              )}
              {shownRoute && (
                <Marker
                  coordinate={shownRoute.points[0]}
                  title="Start"
                  pinColor="#34C759"
                />
              )}
              {shownRoute && (
                <Marker
                  coordinate={shownRoute.points[shownRoute.points.length - 1]}
                  title={selected?.label ?? 'Destination'}
                />
              )}
              {mapCrashes.map((c) => (
                <Marker
                  key={`crash-${c.id}`}
                  coordinate={c.at}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={false}
                  onPress={() => setPickedCrash(c)}
                >
                  <View style={styles.crashHit}>
                    <View style={[styles.crashDot, { backgroundColor: crashColor(c) }]} />
                  </View>
                </Marker>
              ))}
            </MapView>
          )}

          {locationChecked && region.latitudeDelta > MAX_CRASH_DELTA && (
            <View style={styles.mapBadge}>
              <Text style={styles.mapBadgeText}>Zoom in to see crash locations</Text>
            </View>
          )}
        </View>

        {pickedCrash && (
          <View style={styles.crashCard}>
            <View style={styles.crashCardHeader}>
              <View
                style={[styles.safetyDot, { backgroundColor: crashColor(pickedCrash) }]}
              />
              <Text style={styles.crashCardTitle}>{crashTitle(pickedCrash)}</Text>
              <Pressable hitSlop={10} onPress={() => setPickedCrash(null)}>
                <MaterialIcons name="close" size={20} color="#8E8E93" />
              </Pressable>
            </View>
            {pickedCrash.dateMs !== null && (
              <Text style={styles.crashCardMeta}>
                {formatCrashDate(pickedCrash.dateMs)}
              </Text>
            )}
            {pickedCrash.streets ? (
              <Text style={styles.crashCardMeta}>Near {pickedCrash.streets}</Text>
            ) : null}
            {pickedCrash.narrative ? (
              <Text style={styles.crashCardBody}>{pickedCrash.narrative}</Text>
            ) : null}
            {crashDetails.map((line) => (
              <Text key={line} style={styles.crashCardMeta}>
                {line}
              </Text>
            ))}
          </View>
        )}

        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#FF3B30' }]} />
            <Text style={styles.legendText}>Death or severe injury</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#FF9500' }]} />
            <Text style={styles.legendText}>Moderate injury</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#34C759' }]} />
            <Text style={styles.legendText}>Minor injury</Text>
          </View>
        </View>
        <Text style={styles.legendNote}>
          {mapCrashes.length >= MAP_CRASH_LIMIT
            ? `Showing the ${MAP_CRASH_LIMIT} most recent crashes in view. Zoom in to see more. `
            : ''}
          Tap a dot for details. City of San José crash data, last five years.
        </Text>

        <View style={styles.controls}>
          {selected && !shownRoute && (
            <Text style={styles.coords}>
              {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
            </Text>
          )}

          {ranksRoutes && scored.length > 0 && (
            <View style={styles.routeChips}>
              {scored.map((r, i) => (
                <Pressable
                  key={`route-${i}`}
                  style={[
                    styles.routeChip,
                    i === activeIdx && styles.routeChipActive,
                  ]}
                  onPress={() => setActiveIdx(i)}
                >
                  <View style={styles.routeChipTop}>
                    <View
                      style={[
                        styles.safetyDot,
                        { backgroundColor: safetyColor(dotLevel(r, scored)) },
                      ]}
                    />
                    <Text style={styles.routeChipText}>
                      {routeName(r, scored.length)} ·{' '}
                      {formatDuration(r.seconds)} · {formatDistance(r.meters)}
                    </Text>
                  </View>
                  <Text style={styles.routeChipSub}>
                    {Math.round(r.corridorRatio * 100)}% on busy main roads
                    {r.crashCount
                      ? ` · ${r.crashCount} injury crash${
                          r.crashCount === 1 ? '' : 'es'
                        } nearby${
                          r.ksiCount ? ` (${r.ksiCount} death/severe)` : ''
                        }`
                      : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        {ranksRoutes && active && (
          <View style={styles.mapSection}>
            <Text style={styles.routeMeta}>
              {formatDistance(active.meters)} ·{' '}
              {formatDuration(active.seconds)} {travelMode === 'bike' ? 'ride' : 'walk'}
            </Text>

            {weather && (
              <Text style={styles.weatherText}>
                {weather.tempF}°F · {weather.description}
              </Text>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.gmapsButton,
                pressed && styles.modeButtonPressed,
              ]}
              onPress={() => openInGoogleMaps(active, GOOGLE_MODE[travelMode])}
            >
              <Text style={styles.gmapsButtonText}>Open in Google Maps</Text>
            </Pressable>
            <Text style={styles.gmapsHint}>
              For voice navigation and live re-routing along this route.
            </Text>

            <View style={styles.safetyBox}>
              {outOfArea ? (
                <Text style={styles.safetyMuted}>
                  No San José street data along this route.
                </Text>
              ) : (
                <>
                  <View style={styles.safetyRow}>
                    <View
                      style={[
                        styles.safetyDot,
                        { backgroundColor: safetyColor(dotLevel(active, scored)) },
                      ]}
                    />
                    <Text style={styles.safetyText}>
                      {active.corridorMeters >= 30
                        ? `Uses busy main roads for ${formatDistance(
                            active.corridorMeters,
                          )} (${Math.round(active.corridorRatio * 100)}%)`
                        : 'Mostly on calmer streets'}
                    </Text>
                  </View>
                  <Text style={styles.safetyText}>
                    {active.crashCount === 0
                      ? 'No reported injury crashes along this route'
                      : `${active.crashCount} reported injury crash${
                          active.crashCount === 1 ? '' : 'es'
                        } within ${formatDistance(NEAR_CRASH_M)}` +
                        (active.ksiCount > 0
                          ? `, ${active.ksiCount} with a death or severe injury`
                          : '') +
                        ' (City of San José data)'}
                  </Text>
                </>
              )}
              <Text style={styles.safetyMuted}>
                Blue = this route · dashed = other options · amber line = busy
                main road · City of San José data
              </Text>
            </View>
          </View>
        )}

        {travelMode === 'drive' && driveResult && (
          <View style={styles.mapSection}>
            <Text style={styles.routeMeta}>
              {formatDistance(driveResult.meters)} ·{' '}
              {formatDuration(driveResult.seconds)} drive
            </Text>

            <View style={styles.safetyBox}>
              {driveResult.corridorMeters > 0 ? (
                <Text style={styles.cautionText}>
                  ⚠️ Caution: your route overlaps with a Vision Zero safety
                  corridor for {formatDistance(driveResult.corridorMeters)} (
                  {Math.round(driveResult.corridorRatio * 100)}% of the drive).
                </Text>
              ) : (
                <Text style={styles.safetyText}>
                  No Vision Zero safety corridors along this route.
                </Text>
              )}
              <Text style={styles.safetyMuted}>
                City of San José Vision Zero data.
              </Text>
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.gmapsButton,
                pressed && styles.modeButtonPressed,
              ]}
              onPress={() => openInGoogleMaps(driveResult, 'driving')}
            >
              <Text style={styles.gmapsButtonText}>Open in Google Maps</Text>
            </Pressable>
            <Text style={styles.gmapsHint}>
              Opens Google's own default driving route for turn-by-turn
              navigation.
            </Text>
          </View>
        )}
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}

// The status bar is translucent, so inset the top of the screen by hand.
const TOP_INSET = Platform.OS === 'ios' ? 60 : (RNStatusBar.currentHeight ?? 24) + 12;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  searchBar: {
    paddingTop: TOP_INSET + 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  greeting: {
    fontSize: 26,
    lineHeight: 34,
    color: '#000',
    marginBottom: 28,
    fontFamily: HEADING_FONT,
    letterSpacing: -0.3,
  },
  tabRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 6,
  },
  tabButtonText: {
    marginTop: 2,
    fontSize: 13,
    fontFamily: FONT.medium,
    color: '#8E8E93',
  },
  tabButtonTextActive: {
    fontFamily: FONT.semibold,
    color: '#007AFF',
  },
  // Reserves the indicator's space on both tabs so switching doesn't shift layout.
  tabIndicator: {
    marginTop: 6,
    width: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'transparent',
  },
  tabIndicatorActive: {
    backgroundColor: '#007AFF',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    fontFamily: FONT.regular,
    backgroundColor: '#F2F2F7',
    color: '#000',
  },
  controls: {
    paddingHorizontal: 16,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 20,
  },
  controlsAboveMap: {
    marginBottom: 12,
  },
  modeRowAboveMap: {
    marginTop: 0,
  },
  modeButton: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    backgroundColor: '#8E8E93',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    backgroundColor: '#007AFF',
  },
  modeButtonDisabled: {
    backgroundColor: '#E5E5EA',
  },
  modeButtonPressed: {
    opacity: 0.6,
  },
  modeButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: FONT.semibold,
  },
  modeButtonTextDisabled: {
    color: '#B0B0B5',
  },
  spinner: {
    marginTop: 8,
  },
  suggestions: {
    marginTop: 8,
    maxHeight: 220,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  suggestionRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  suggestionText: {
    fontSize: 15,
    fontFamily: FONT.regular,
    color: '#000',
  },
  coords: {
    marginTop: 8,
    fontSize: 13,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  routeChips: {
    flexDirection: 'column',
    gap: 8,
    marginTop: 28,
  },
  routeChip: {
    width: '100%',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#fff',
  },
  routeChipActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  routeChipTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  routeChipText: {
    fontSize: 17,
    fontFamily: FONT.bold,
    color: '#000',
  },
  routeChipSub: {
    marginTop: 4,
    fontSize: 13,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  scrollBody: {
    paddingBottom: 32,
  },
  mapSection: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
    paddingTop: 12,
  },
  mapWrap: {
    marginHorizontal: 16,
    height: 320,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#E5E5EA',
  },
  map: {
    flex: 1,
  },
  mapBadge: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  mapBadgeText: {
    fontSize: 13,
    fontFamily: FONT.medium,
    color: '#fff',
  },
  // Transparent padding around each dot so it's easier to tap.
  crashHit: {
    padding: 6,
  },
  crashDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#fff',
  },
  crashCard: {
    marginHorizontal: 16,
    marginTop: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#fff',
  },
  crashCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  crashCardTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: FONT.bold,
    color: '#000',
  },
  crashCardMeta: {
    marginTop: 2,
    fontSize: 13,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  crashCardBody: {
    marginVertical: 6,
    fontSize: 14,
    fontFamily: FONT.regular,
    color: '#000',
  },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 14,
    rowGap: 4,
    paddingHorizontal: 16,
    marginTop: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  legendText: {
    fontSize: 12,
    fontFamily: FONT.regular,
    color: '#000',
  },
  legendNote: {
    paddingHorizontal: 16,
    marginTop: 4,
    fontSize: 11,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  routeMeta: {
    paddingHorizontal: 16,
    paddingTop: 10,
    fontSize: 14,
    fontFamily: FONT.semibold,
    color: '#000',
    backgroundColor: '#fff',
  },
  weatherText: {
    paddingHorizontal: 16,
    paddingTop: 4,
    fontSize: 13,
    fontFamily: FONT.regular,
    color: '#8E8E93',
    backgroundColor: '#fff',
  },
  safetyBox: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
    backgroundColor: '#fff',
  },
  safetyRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  safetyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  safetyText: {
    flex: 1,
    fontSize: 13,
    fontFamily: FONT.regular,
    color: '#000',
  },
  cautionText: {
    fontSize: 14,
    fontFamily: FONT.bold,
    color: '#B4270E',
  },
  safetyMuted: {
    marginTop: 4,
    fontSize: 11,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  gmapsButton: {
    marginHorizontal: 16,
    marginTop: 14,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#1A73E8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gmapsButtonText: {
    color: '#fff',
    fontSize: 17,
    fontFamily: FONT.bold,
  },
  gmapsHint: {
    marginHorizontal: 16,
    marginTop: 6,
    fontSize: 12,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
});

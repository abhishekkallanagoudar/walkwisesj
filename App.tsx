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

type Suggestion = {
  id: string;
  label: string;
};

// A suggestion once its place_id has been resolved to coordinates.
type ResolvedPlace = Suggestion & {
  latitude: number;
  longitude: number;
};

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

type TravelMode = 'walk' | 'drive';

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

// Google's Maps Platform key, for the Places and Directions REST calls below.
const GOOGLE_MAPS_API_KEY = 'AIzaSyAc8qFjfPukR5HiGuCf4A3MG-EgzEkJt8c';

const PLACES_AUTOCOMPLETE_URL =
  'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

async function queryGooglePlaces(
  query: string,
  bias: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const params = new URLSearchParams({
    input: query,
    key: GOOGLE_MAPS_API_KEY,
    // No `types` restriction: walkers search for businesses ("Starbucks") as
    // often as street addresses, and `types=address` filters out anything
    // that isn't a precise address, which drops POI/business names entirely.
  });
  if (bias) {
    // Bias (not restrict) ranking toward the user's location.
    params.set('location', `${bias.lat},${bias.lon}`);
    params.set('radius', '20000');
  }
  const res = await fetch(`${PLACES_AUTOCOMPLETE_URL}?${params.toString()}`, {
    signal,
  });
  const json = await res.json();
  if (json.status !== 'OK') return [];
  const predictions: Suggestion[] = (json.predictions ?? []).map((p: any) => ({
    id: p.place_id,
    label: p.description,
  }));
  return predictions.slice(0, 6);
}

// Autocomplete predictions don't carry coordinates; resolve them only for
// the one place actually chosen, via a Place Details lookup.
async function resolvePlace(place: Suggestion): Promise<ResolvedPlace | null> {
  const params = new URLSearchParams({
    place_id: place.id,
    key: GOOGLE_MAPS_API_KEY,
    fields: 'geometry',
  });
  const res = await fetch(`${PLACE_DETAILS_URL}?${params.toString()}`);
  const json = await res.json();
  const loc = json.result?.geometry?.location;
  if (json.status !== 'OK' || !loc) return null;
  return { ...place, latitude: loc.lat, longitude: loc.lng };
}

const DIRECTIONS_URL = 'https://maps.googleapis.com/maps/api/directions/json';

// Google encodes route geometry as a polyline string; this is its standard
// decoding algorithm (see Google's Encoded Polyline Algorithm Format docs).
function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat * 1e-5, longitude: lng * 1e-5 });
  }
  return points;
}

// Directions steps come as HTML (e.g. "Turn <b>right</b> onto Main St").
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

// Ask Google Directions for one or more routes, each with per-maneuver
// steps, so we can both rank them for safety and show turn-by-turn
// directions. Walk asks for alternatives to rank; Drive just needs the one
// default route to check for corridor overlap.
async function fetchRoutes(
  from: LatLng,
  to: LatLng,
  mode: 'walking' | 'driving' = 'walking',
  alternatives = true,
): Promise<Route[]> {
  const params = new URLSearchParams({
    origin: `${from.latitude},${from.longitude}`,
    destination: `${to.latitude},${to.longitude}`,
    mode,
    alternatives: alternatives ? 'true' : 'false',
    key: GOOGLE_MAPS_API_KEY,
  });
  const res = await fetch(`${DIRECTIONS_URL}?${params.toString()}`);
  const json = await res.json();
  const rs = json.routes;
  if (json.status !== 'OK' || !Array.isArray(rs) || rs.length === 0) return [];
  return rs.map((r: any) => {
    const legs = (r.legs ?? []) as any[];
    return {
      points: decodePolyline(r.overview_polyline?.points ?? ''),
      meters: legs.reduce((sum, l) => sum + (l.distance?.value ?? 0), 0),
      seconds: legs.reduce((sum, l) => sum + (l.duration?.value ?? 0), 0),
      steps: legs
        .flatMap((leg) => (leg.steps ?? []) as any[])
        .map((s) => ({
          instruction: stripHtml(s.html_instructions ?? ''),
          meters: s.distance?.value ?? 0,
        }))
        .filter((s: Step) => s.instruction),
    };
  });
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
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

// Where the map starts before the device location arrives: downtown San José.
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

function googleMapsUrl(route: Route, mode: 'walking' | 'driving' = 'walking'): string {
  const pts = route.points;
  const at = (p: LatLng) => `${p.latitude},${p.longitude}`;
  const params = new URLSearchParams({
    api: '1',
    origin: at(pts[0]),
    destination: at(pts[pts.length - 1]),
    travelmode: mode,
  });
  // Walking only: Google Maps has no way to accept a full custom path, so we
  // pin a handful of points from this route as waypoints, keeping Google
  // close to the calmest (or busier) line we picked instead of letting it
  // choose its own route. Driving intentionally skips this — it's just
  // Google's own default route, not one we ranked or chose.
  if (mode === 'walking') {
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

function openInGoogleMaps(route: Route, mode: 'walking' | 'driving' = 'walking') {
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
  // Walk shows ranked alternatives with a full safety overlay; Drive is a
  // single default route with just a corridor-overlap check.
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
  const centeredOnUser = useRef(false);

  const active = scored[activeIdx] ?? null;
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
  // for the map overlay — Walk's alternatives, or Drive's single route.
  const nearbyCorridors = useMemo(() => {
    const routesShown: Route[] =
      travelMode === 'walk' ? scored : driveResult ? [driveResult] : [];
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
  }, [travelMode, scored, driveResult, corridors]);

  // Ask for location once on mount so nearby results can be prioritized.
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      try {
        const pos = await Location.getLastKnownPositionAsync();
        const use = pos ?? (await Location.getCurrentPositionAsync({}));
        setCoords({
          lat: use.coords.latitude,
          lon: use.coords.longitude,
        });
      } catch {
        // No location available; searches just fall back to global ranking.
      }
    })();
  }, []);

  // Move the map to the user the first time their location arrives, unless a
  // route is already being shown.
  useEffect(() => {
    if (!coords || centeredOnUser.current) return;
    centeredOnUser.current = true;
    if (scored.length || driveResult) return;
    mapRef.current?.animateToRegion(
      { ...DEFAULT_REGION, latitude: coords.lat, longitude: coords.lon },
      400,
    );
  }, [coords, scored, driveResult]);

  // Frame the route being shown whenever it changes.
  useEffect(() => {
    const pts = travelMode === 'walk' ? active?.points : driveResult?.points;
    if (pts?.length) mapRef.current?.animateToRegion(regionForRoute(pts), 400);
  }, [travelMode, active, driveResult]);

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

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        setSuggestions(await queryGooglePlaces(query, coords, controller.signal));
      } catch {
        if (!controller.signal.aborted) setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address, coords]);

  // Tapping a suggestion only gives us a place_id; resolve it to coordinates.
  async function handleSelect(item: Suggestion) {
    skipNextLookup.current = true;
    setAddress(item.label);
    setSuggestions([]);
    setSelected(await resolvePlace(item));
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
  // if there is one, otherwise looking up and resolving the top match.
  async function resolveDestination(query: string): Promise<ResolvedPlace | null> {
    if (selected) return selected;
    const results = await queryGooglePlaces(query, coords);
    const first = results[0] ?? null;
    const dest = first ? await resolvePlace(first) : null;
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
        fetchRoutes(origin, destination),
        fetchWeather(midpoint)
          .then(setWeather)
          .catch(() => setWeather(null)),
      ]);
      if (!found.length) {
        Alert.alert('Could not find a walking route to that address.');
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

  // The route drawn on the map: the chosen walking option, or Drive's route.
  const shownRoute: Route | null =
    travelMode === 'walk' ? active : driveResult;
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

          <View style={styles.tabRow}>
            <Pressable
              style={[styles.tabButton, travelMode === 'walk' && styles.tabButtonActive]}
              onPress={() => switchMode('walk')}
            >
              <MaterialIcons
                name="directions-walk"
                size={20}
                color={travelMode === 'walk' ? '#007AFF' : '#8E8E93'}
              />
              <Text
                style={[
                  styles.tabButtonText,
                  travelMode === 'walk' && styles.tabButtonTextActive,
                ]}
              >
                Walk
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tabButton, travelMode === 'drive' && styles.tabButtonActive]}
              onPress={() => switchMode('drive')}
            >
              <MaterialIcons
                name="directions-car"
                size={20}
                color={travelMode === 'drive' ? '#007AFF' : '#8E8E93'}
              />
              <Text
                style={[
                  styles.tabButtonText,
                  travelMode === 'drive' && styles.tabButtonTextActive,
                ]}
              >
                Drive
              </Text>
            </Pressable>
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
              onSubmitEditing={() =>
                travelMode === 'walk' ? handleRoute() : handleDriveCheck()
              }
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

        <View style={styles.mapWrap}>
          <MapView
            ref={mapRef}
            style={styles.map}
            initialRegion={DEFAULT_REGION}
            showsUserLocation
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
            {travelMode === 'walk' &&
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

          {region.latitudeDelta > MAX_CRASH_DELTA && (
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
          <View style={styles.modeRow}>
            <Pressable
              disabled={!canRoute}
              style={({ pressed }) => [
                styles.modeButton,
                canRoute ? styles.modeButtonActive : styles.modeButtonDisabled,
                pressed && styles.modeButtonPressed,
              ]}
              onPress={() => (travelMode === 'walk' ? handleRoute() : handleDriveCheck())}
            >
              <View style={styles.modeButtonContent}>
                <MaterialIcons
                  name={travelMode === 'walk' ? 'directions-walk' : 'directions-car'}
                  size={26}
                  color={canRoute ? '#fff' : styles.modeButtonTextDisabled.color}
                />
                <Text
                  style={[
                    styles.modeButtonText,
                    !canRoute && styles.modeButtonTextDisabled,
                  ]}
                >
                  {travelMode === 'walk' ? 'Find safe route' : 'Check for safety corridors'}
                </Text>
              </View>
            </Pressable>
          </View>

          {loading && <ActivityIndicator style={styles.spinner} />}

          {selected && !shownRoute && (
            <Text style={styles.coords}>
              {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
            </Text>
          )}

          {travelMode === 'walk' && scored.length > 0 && (
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

        {travelMode === 'walk' && active && (
          <View style={styles.mapSection}>
            <Text style={styles.routeMeta}>
              {formatDistance(active.meters)} ·{' '}
              {formatDuration(active.seconds)} walk
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
              onPress={() => openInGoogleMaps(active)}
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
                        } within ${NEAR_CRASH_M} m` +
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
    gap: 8,
    marginBottom: 20,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    backgroundColor: '#F2F2F7',
  },
  tabButtonActive: {
    borderColor: '#007AFF',
    backgroundColor: '#EAF3FF',
  },
  tabButtonText: {
    fontSize: 15,
    fontFamily: FONT.semibold,
    color: '#8E8E93',
  },
  tabButtonTextActive: {
    color: '#007AFF',
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

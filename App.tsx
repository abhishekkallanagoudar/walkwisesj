import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { MaterialIcons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import {
  useFonts,
  Fraunces_700Bold,
  Fraunces_900Black,
} from '@expo-google-fonts/fraunces';
import { Poppins_600SemiBold, Poppins_700Bold } from '@expo-google-fonts/poppins';

// Swap this to change the welcome heading typeface. Loaded names:
// 'Fraunces_700Bold', 'Fraunces_900Black', 'Poppins_600SemiBold',
// 'Poppins_700Bold'.
const HEADING_FONT = 'Fraunces_900Black';

// Show corridor-proximity alerts as a real banner even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

type LatLng = { latitude: number; longitude: number };

type Suggestion = {
  id: string;
  label: string;
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

type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

type Corridor = {
  name: string;
  points: LatLng[];
  bbox: BBox;
};

type CrashSeverity = 'fatal' | 'severe' | 'moderate' | 'minor';

type Crash = {
  at: LatLng;
  severity: CrashSeverity;
  weight: number; // fatal 8 / severe 4 / moderate 2 / minor 1
  ksi: boolean; // killed or severely injured
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

// Photon is a free, no-key geocoder built on OpenStreetMap data.
const PHOTON_URL = 'https://photon.komoot.io/api/';

function formatAddress(props: Record<string, any>): string {
  const line1 =
    props.name ?? [props.housenumber, props.street].filter(Boolean).join(' ');
  const parts = [
    line1,
    props.city ?? props.county,
    props.state,
    props.postcode,
    props.country,
  ].filter(Boolean);
  return parts.join(', ');
}

// Rough metres between two lat/lon points; plenty accurate at city scale.
function roughMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (a.lat - b.lat) * 110540;
  const dLon = (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

async function queryPhoton(
  query: string,
  bias: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  // Over-fetch so there's a pool to re-rank by real distance below.
  const params = new URLSearchParams({ q: query, limit: '15', lang: 'en' });
  if (bias) {
    params.set('lat', String(bias.lat));
    params.set('lon', String(bias.lon));
    // Pull ranking strongly toward the user's location.
    params.set('location_bias_scale', '0.6');
    params.set('zoom', '12');
  }
  const res = await fetch(`${PHOTON_URL}?${params.toString()}`, { signal });
  const json = await res.json();
  const all: Suggestion[] = (json.features ?? []).map((f: any, i: number) => ({
    // Suffix with the index so Photon returning the same OSM object twice
    // can't produce duplicate React keys.
    id: `${f.properties.osm_type ?? 'x'}${f.properties.osm_id ?? 'n'}-${i}`,
    label: formatAddress(f.properties),
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
  }));
  // Photon's location bias only nudges its ranking; when we know where the user
  // is, sort the text matches so the genuinely closest ones come first.
  const ordered = bias
    ? [...all].sort(
        (p, q) =>
          roughMeters(bias, { lat: p.latitude, lon: p.longitude }) -
          roughMeters(bias, { lat: q.latitude, lon: q.longitude }),
      )
    : all;
  return ordered.slice(0, 6);
}

// FOSSGIS runs a free, no-key OSRM server for the walking profile.
const OSRM_FOOT =
  'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

// Compass word for an OSRM bearing (0 = north, clockwise).
function compass(bearing?: number): string {
  if (bearing == null) return 'straight ahead';
  const dirs = [
    'north', 'northeast', 'east', 'southeast',
    'south', 'southwest', 'west', 'northwest',
  ];
  return dirs[Math.round(bearing / 45) % 8];
}

// Turn one OSRM maneuver into a short spoken-style instruction.
function describeStep(step: any): string {
  const m = step.maneuver ?? {};
  const type: string = m.type ?? '';
  const mod: string = m.modifier ?? '';
  const road: string = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';
  switch (type) {
    case 'depart':
      return `Head ${compass(m.bearing_after)}${on}`;
    case 'arrive':
      return 'Arrive at your destination';
    case 'turn':
      return `Turn ${mod || 'ahead'}${onto}`;
    case 'end of road':
      return `Turn ${mod || 'straight'}${onto}`;
    case 'fork':
      return `Keep ${mod || 'straight'}${onto}`;
    case 'merge':
      return `Merge${mod ? ` ${mod}` : ''}${onto}`;
    case 'continue':
      return `Continue ${mod || 'straight'}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'roundabout':
    case 'rotary':
      return `Take the roundabout${m.exit ? `, exit ${m.exit}` : ''}${onto}`;
    default:
      return `${mod ? `Bear ${mod}` : 'Continue'}${onto}`;
  }
}

// Ask OSRM for up to three distinct walking routes, each with per-maneuver
// steps, so we can both rank them for safety and show turn-by-turn directions.
async function fetchRoutes(from: LatLng, to: LatLng): Promise<Route[]> {
  const coordPair =
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const res = await fetch(
    `${OSRM_FOOT}/${coordPair}` +
      '?alternatives=3&overview=full&geometries=geojson&steps=true',
  );
  const json = await res.json();
  const rs = json.routes;
  if (!Array.isArray(rs) || rs.length === 0) return [];
  return rs.map((r: any) => ({
    points: r.geometry.coordinates.map(([lon, lat]: [number, number]) => ({
      latitude: lat,
      longitude: lon,
    })),
    meters: r.distance,
    seconds: r.duration,
    steps: ((r.legs ?? []) as any[])
      .flatMap((leg) => (leg.steps ?? []) as any[])
      .map((s) => ({ instruction: describeStep(s), meters: s.distance ?? 0 }))
      .filter((s: Step) => s.instruction),
  }));
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
// While actively walking a route, alert once the walker comes within this many
// metres of a safety corridor (wider than ON_CORRIDOR_M, which just scores it,
// so the alert gives some warning before actually stepping onto it).
const ALERT_CORRIDOR_M = 60;

// "Crash Locations Last Five Years" — every reported injury crash, not just the
// killed-or-severely-injured ones. NOTE: San José only logs crashes inside its
// own city limits, so county expressways (e.g. Lawrence Expwy) and neighbouring
// cities have little or no data here regardless of their real crash history.
const CRASH_WHERE =
  'FATALINJURIES>0 OR SEVEREINJURIES>0 OR MODERATEINJURIES>0 OR MINORINJURIES>0';

function crashesUrl(box: BBox): string {
  const geometry = box.join(',');
  return (
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
    '/MapServer/553/query?where=' +
    encodeURIComponent(CRASH_WHERE) +
    `&geometry=${geometry}` +
    '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326' +
    '&outFields=FATALINJURIES,SEVEREINJURIES,MODERATEINJURIES,MINORINJURIES' +
    '&resultRecordCount=2000&returnGeometry=true&f=geojson'
  );
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

// Closest distance from a point (e.g. the walker's live location) to any
// segment of a corridor.
function distanceToCorridor(p: LatLng, corridor: Corridor): number {
  let min = Infinity;
  for (let i = 0; i < corridor.points.length - 1; i++) {
    const d = pointToSegMeters(p, corridor.points[i], corridor.points[i + 1]);
    if (d < min) min = d;
  }
  return min;
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
function regionForRoute(pts: LatLng[]) {
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
        name: f.properties?.SAFETYPRIORITYSTREET ?? 'Safety corridor',
        points,
        bbox: bboxOf(points),
      });
    }
  }
  return out;
}

async function fetchCrashes(box: BBox): Promise<Crash[]> {
  const res = await fetch(crashesUrl(box));
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
      at: { latitude: c[1], longitude: c[0] },
      severity,
      weight: fatal ? 8 : severe ? 4 : moderate ? 2 : 1,
      ksi: fatal || severe,
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

// Rank-based name for a route among its alternatives (0 = safest).
function routeName(rank: number, total: number): string {
  if (total < 2) return 'Your route';
  if (rank <= 0) return 'Calmest';
  if (rank >= total - 1) return 'Busier streets';
  return 'Middle route';
}

// Calm (green) -> moderate (amber) -> busy (soft coral, deliberately not a
// harsh red so the app stays reassuring for everyday pedestrians).
function safetyColor(level: SafetyLevel): string {
  return level === 'low' ? '#34C759' : level === 'medium' ? '#FF9F0A' : '#FF7043';
}

// The dot shown next to each ranked alternative. `level` is the route's honest
// absolute rating; here we also spread the colours apart when the alternatives
// genuinely differ, so "Calmest" and "Busier streets" don't look identical.
// A truly dangerous route is never painted green.
function dotLevel(r: ScoredRoute, all: ScoredRoute[]): SafetyLevel {
  if (r.level === 'high' || all.length < 2) return r.level;
  const scores = all.map((x) => x.riskScore);
  const spread = Math.max(...scores) - Math.min(...scores);
  if (spread < 50) return r.level; // alternatives are basically equivalent
  if (r.rank === 0) return r.level === 'medium' ? 'low' : r.level;
  if (r.rank === all.length - 1) return r.level === 'low' ? 'medium' : r.level;
  return r.level;
}

// Translucent variant for the un-selected alternative routes.
function altColor(level: SafetyLevel): string {
  return level === 'low'
    ? 'rgba(52,199,89,0.75)'
    : level === 'medium'
      ? 'rgba(255,159,10,0.75)'
      : 'rgba(255,112,67,0.8)';
}

// Google Maps has no way to accept a full custom path, so we pin a handful of
// points from this route as waypoints. That keeps Google close to the calmest
// (or busier) line we picked instead of letting it choose its own route.
function googleMapsUrl(route: Route): string {
  const pts = route.points;
  const at = (p: LatLng) => `${p.latitude},${p.longitude}`;
  const inner = pts.slice(1, -1);
  const want = Math.min(8, inner.length); // consumer Google Maps caps at ~9
  const waypoints: string[] = [];
  for (let i = 1; i <= want; i++) {
    const p = inner[Math.floor((i * inner.length) / (want + 1))];
    if (p) waypoints.push(at(p));
  }
  const params = new URLSearchParams({
    api: '1',
    origin: at(pts[0]),
    destination: at(pts[pts.length - 1]),
    travelmode: 'walking',
  });
  if (waypoints.length) params.set('waypoints', waypoints.join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function openInGoogleMaps(route: Route) {
  Linking.openURL(googleMapsUrl(route)).catch(() =>
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
    Fraunces_700Bold,
    Fraunces_900Black,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [scored, setScored] = useState<ScoredRoute[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [outOfArea, setOutOfArea] = useState(false);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  // Current conditions near the route, fetched alongside it.
  const [weather, setWeather] = useState<Weather | null>(null);
  // Which route (if any) is open in the full-screen map + directions view.
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  // Device location, used to bias results toward what's nearby. State (not a
  // ref) so a search that ran before location arrived re-runs once it does.
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(
    null,
  );
  // Skip the lookup that would otherwise fire right after we set the text ourselves.
  const skipNextLookup = useRef(false);

  const active = scored[activeIdx] ?? null;
  const detail = detailIdx !== null ? scored[detailIdx] ?? null : null;
  // The route button stays disabled until there's an address to route to.
  const canRoute = address.trim().length > 0;

  // Priority safety corridors near any of the shown routes, for the overlay.
  const nearbyCorridors = useMemo(() => {
    if (!scored.length) return [];
    const box = scored.reduce<BBox>(
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
  }, [scored, corridors]);

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

  // Ask for notification permission once on mount, so corridor alerts (below)
  // don't need to interrupt with a permission prompt mid-walk.
  useEffect(() => {
    Notifications.requestPermissionsAsync().catch(() => {});
  }, []);

  // Corridors already alerted on during the current route detail view, so a
  // moving fix doesn't fire the same corridor's notification repeatedly.
  const alertedCorridors = useRef<Set<number>>(new Set());

  // While the route detail screen is open, watch live location and notify the
  // first time the walker comes near a safety corridor. Foreground only: this
  // stops the moment the screen closes or the app is backgrounded.
  useEffect(() => {
    if (detailIdx === null || nearbyCorridors.length === 0) return;

    alertedCorridors.current = new Set();
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 15 },
        (pos) => {
          const here: LatLng = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          };
          nearbyCorridors.forEach((c, i) => {
            if (alertedCorridors.current.has(i)) return;
            if (distanceToCorridor(here, c) <= ALERT_CORRIDOR_M) {
              alertedCorridors.current.add(i);
              Notifications.scheduleNotificationAsync({
                content: {
                  title: 'Busy street ahead',
                  body: `${c.name} is a high-injury safety corridor — stay alert.`,
                },
                trigger: null,
              }).catch(() => {});
            }
          });
        },
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [detailIdx, nearbyCorridors]);

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
        setSuggestions(await queryPhoton(query, coords, controller.signal));
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

  function handleSelect(item: Suggestion) {
    skipNextLookup.current = true;
    setAddress(item.label);
    setSelected(item);
    setSuggestions([]);
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
      setDetailIdx(null);
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
      const bySafety = [...s].sort((a, b) => a.riskScore - b.riskScore);
      bySafety.forEach((r, i) => {
        r.rank = i;
      });

      setScored(s);
      setActiveIdx(s.indexOf(bySafety[0]));
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

  // Resolve the address if needed, then fetch and show the walking routes.
  async function handleRoute() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    if (!coords) {
      Alert.alert('Enable location access to get directions.');
      return;
    }

    let dest = selected;
    setLoading(true);
    try {
      if (!dest) {
        const results = await queryPhoton(query, coords);
        dest = results[0] ?? null;
        if (dest) handleSelect(dest);
      }
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

  if (!fontsLoaded) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Text style={styles.greeting}>Welcome to Walkwise San Jose!!</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={(text) => {
              setSelected(null);
              setRoutes([]);
              setDetailIdx(null);
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
            onSubmitEditing={() => handleRoute()}
          />
        </View>

        <View style={styles.modeRow}>
          <Pressable
            disabled={!canRoute}
            style={({ pressed }) => [
              styles.modeButton,
              canRoute ? styles.modeButtonActive : styles.modeButtonDisabled,
              pressed && styles.modeButtonPressed,
            ]}
            onPress={() => handleRoute()}
          >
            <View style={styles.modeButtonContent}>
              <MaterialIcons
                name="directions-walk"
                size={26}
                color={canRoute ? '#fff' : styles.modeButtonTextDisabled.color}
              />
              <Text
                style={[
                  styles.modeButtonText,
                  !canRoute && styles.modeButtonTextDisabled,
                ]}
              >
                Find safe route
              </Text>
            </View>
          </Pressable>
        </View>

        {loading && <ActivityIndicator style={styles.spinner} />}

        {suggestions.length > 0 && (
          <View style={styles.suggestions}>
            <FlatList
              data={suggestions}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={styles.suggestionRow}
                  onPress={() => handleSelect(item)}
                >
                  <Text style={styles.suggestionText}>{item.label}</Text>
                </Pressable>
              )}
            />
          </View>
        )}

        {selected && !active && (
          <Text style={styles.coords}>
            {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
          </Text>
        )}

        {scored.length > 0 && (
          <View style={styles.routeChips}>
            {scored.map((r, i) => (
              <Pressable
                key={`route-${i}`}
                style={[
                  styles.routeChip,
                  i === activeIdx && styles.routeChipActive,
                ]}
                onPress={() => {
                  setActiveIdx(i);
                  setDetailIdx(i);
                }}
              >
                <View style={styles.routeChipTop}>
                  <View
                    style={[
                      styles.safetyDot,
                      { backgroundColor: safetyColor(dotLevel(r, scored)) },
                    ]}
                  />
                  <Text style={styles.routeChipText}>
                    {routeName(r.rank, scored.length)} ·{' '}
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
                <Text style={styles.routeChipCta}>View map &amp; navigate ›</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      <Modal
        visible={detail !== null}
        animationType="slide"
        onRequestClose={() => setDetailIdx(null)}
      >
        {detail && (
          <View style={styles.detailScreen}>
            <View style={styles.detailHeader}>
              <Pressable
                onPress={() => setDetailIdx(null)}
                hitSlop={12}
                style={({ pressed }) => pressed && styles.modeButtonPressed}
              >
                <Text style={styles.detailBack}>‹ Back</Text>
              </Pressable>
              <Text style={styles.detailTitle} numberOfLines={1}>
                {routeName(detail.rank, scored.length)}
              </Text>
            </View>

            <ScrollView contentContainerStyle={styles.detailBody}>
              <MapView
                style={styles.detailMap}
                initialRegion={regionForRoute(detail.points)}
              >
                {nearbyCorridors.map((c, i) => (
                  <Polyline
                    key={`corridor-${i}`}
                    coordinates={c.points}
                    strokeColor="rgba(255,159,10,0.5)"
                    strokeWidth={7}
                  />
                ))}
                {detail.crashes.map((c, i) => (
                  <Circle
                    key={`crash-${i}`}
                    center={c.at}
                    radius={
                      c.severity === 'fatal'
                        ? 24
                        : c.severity === 'severe'
                          ? 19
                          : c.severity === 'moderate'
                            ? 14
                            : 10
                    }
                    strokeColor="rgba(0,0,0,0)"
                    fillColor={
                      c.ksi
                        ? 'rgba(255,90,70,0.85)'
                        : c.severity === 'moderate'
                          ? 'rgba(255,150,50,0.8)'
                          : 'rgba(255,190,80,0.7)'
                    }
                  />
                ))}
                {scored.map((r, i) =>
                  i === detailIdx ? null : (
                    <Polyline
                      key={`alt-${i}`}
                      coordinates={r.points}
                      strokeColor={altColor(r.level)}
                      strokeWidth={3}
                      lineDashPattern={[6, 6]}
                    />
                  ),
                )}
                <Polyline
                  coordinates={detail.points}
                  strokeColor="#007AFF"
                  strokeWidth={5}
                />
                <Marker
                  coordinate={detail.points[0]}
                  title="Start"
                  pinColor="#34C759"
                />
                <Marker
                  coordinate={detail.points[detail.points.length - 1]}
                  title={selected?.label ?? 'Destination'}
                />
              </MapView>

              <Text style={styles.routeMeta}>
                {formatDistance(detail.meters)} ·{' '}
                {formatDuration(detail.seconds)} walk
              </Text>

              {weather && (
                <Text style={styles.weatherText}>
                  {weather.tempF}°F · {weather.description}
                </Text>
              )}

              {detail.steps.length > 0 && (
                <View style={styles.steps}>
                  <Text style={styles.stepsTitle}>Turn-by-turn</Text>
                  {detail.steps.map((s, i) => (
                    <View key={`step-${i}`} style={styles.stepRow}>
                      <Text style={styles.stepIndex}>{i + 1}</Text>
                      <Text style={styles.stepText}>{s.instruction}</Text>
                      {s.meters >= 1 && (
                        <Text style={styles.stepDist}>
                          {formatDistance(s.meters)}
                        </Text>
                      )}
                    </View>
                  ))}
                  <Text style={styles.stepsSource}>
                    Directions from OpenStreetMap · verify against signs and
                    crossings
                  </Text>
                </View>
              )}

              <Pressable
                style={({ pressed }) => [
                  styles.gmapsButton,
                  pressed && styles.modeButtonPressed,
                ]}
                onPress={() => openInGoogleMaps(detail)}
              >
                <Text style={styles.gmapsButtonText}>
                  Open in Google Maps
                </Text>
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
                          { backgroundColor: safetyColor(dotLevel(detail, scored)) },
                        ]}
                      />
                      <Text style={styles.safetyText}>
                        {detail.corridorMeters >= 30
                          ? `Uses busy main roads for ${formatDistance(
                              detail.corridorMeters,
                            )} (${Math.round(detail.corridorRatio * 100)}%)`
                          : 'Mostly on calmer streets'}
                      </Text>
                    </View>
                    <Text style={styles.safetyText}>
                      {detail.crashCount === 0
                        ? 'No reported injury crashes along this route'
                        : `${detail.crashCount} reported injury crash${
                            detail.crashCount === 1 ? '' : 'es'
                          } within ${NEAR_CRASH_M} m` +
                          (detail.ksiCount > 0
                            ? `, ${detail.ksiCount} with a death or severe injury`
                            : '') +
                          ' (City of San José data)'}
                    </Text>
                  </>
                )}
                <Text style={styles.safetyMuted}>
                  Blue = this route · dashed = other options · amber line = busy
                  main road · dot = injury crash (red = death or severe) · City
                  of San José data
                </Text>
              </View>
            </ScrollView>
          </View>
        )}
      </Modal>
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
    paddingTop: TOP_INSET + 48,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  greeting: {
    fontSize: 26,
    color: '#000',
    marginBottom: 72,
    fontFamily: HEADING_FONT,
    letterSpacing: 0.2,
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
    backgroundColor: '#F2F2F7',
    color: '#000',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 32,
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
    fontWeight: '600',
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
    color: '#000',
  },
  coords: {
    marginTop: 8,
    fontSize: 13,
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
    fontWeight: '700',
    color: '#000',
  },
  routeChipSub: {
    marginTop: 4,
    fontSize: 13,
    color: '#8E8E93',
  },
  routeChipCta: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  detailScreen: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: TOP_INSET,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  detailBack: {
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  detailTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: '#000',
  },
  detailBody: {
    paddingBottom: 32,
  },
  detailMap: {
    width: '100%',
    height: 300,
  },
  routeMeta: {
    paddingHorizontal: 10,
    paddingTop: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
    backgroundColor: '#fff',
  },
  weatherText: {
    paddingHorizontal: 10,
    paddingTop: 4,
    fontSize: 13,
    color: '#8E8E93',
    backgroundColor: '#fff',
  },
  safetyBox: {
    paddingHorizontal: 10,
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
    color: '#000',
  },
  safetyMuted: {
    marginTop: 4,
    fontSize: 11,
    color: '#8E8E93',
  },
  gmapsButton: {
    marginHorizontal: 10,
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
    fontWeight: '700',
  },
  gmapsHint: {
    marginHorizontal: 10,
    marginTop: 6,
    fontSize: 12,
    color: '#8E8E93',
  },
  steps: {
    marginHorizontal: 10,
    marginTop: 12,
  },
  stepsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
    marginBottom: 4,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  stepIndex: {
    width: 22,
    fontSize: 14,
    fontWeight: '700',
    color: '#8E8E93',
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    color: '#000',
  },
  stepDist: {
    marginLeft: 8,
    fontSize: 13,
    color: '#8E8E93',
  },
  stepsSource: {
    marginTop: 8,
    fontSize: 11,
    color: '#8E8E93',
  },
});

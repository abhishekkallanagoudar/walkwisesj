import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { MaterialIcons } from '@expo/vector-icons';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import * as Speech from 'expo-speech';
import { useKeepAwake } from 'expo-keep-awake';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

// App-wide typefaces. Custom fonts ignore fontWeight on Android, so each
// weight is its own family.
const FONT = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};
const HEADING_FONT = FONT.bold;

// Every color drawn on the map, in one place, so the map key always matches.
// No two kinds of thing share a color.
const MAP_COLORS = {
  selectedRoute: '#007AFF',
  otherRoute: 'rgba(142,142,147,0.85)',
  // Vision Zero priority safety corridors: a wide translucent red band.
  highRiskZone: 'rgba(215,0,21,0.45)',
  start: '#34C759',
  destination: '#FF3B30',
  // Past crashes, by the worst injury: red, orange, yellow.
  crashSerious: '#FF3B30',
  crashModerate: '#FF9500',
  crashMinor: '#FFCC00',
  // Ring around the crash whose details are open.
  crashPicked: '#007AFF',
  noCrosswalk: '#AF52DE',
};

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
  // OSRM maneuver, e.g. type 'turn' + modifier 'left'; picks the arrow icon.
  type: string;
  modifier: string;
};

type Route = {
  points: LatLng[];
  meters: number;
  seconds: number;
  steps: Step[];
  // Points a safer detour was forced through, in order (none for OSRM's own).
  via?: LatLng[];
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
  highRisk: boolean; // fatal or severe; shown only as "High risk"
  // Who was involved: walking (pedestrian), bike (bike or scooter rider) or
  // drive (vehicles only). Each mode's routes are scored on its own crashes.
  mode: TravelMode;
  kind: string; // e.g. "Car and pedestrian"
  // Details shown when a crash dot is tapped.
  dateMs: number | null; // San Jose local time, stored as if it were UTC
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

// Current conditions near a route, from Open-Meteo.
type Weather = {
  tempF: number;
  description: string;
  isDay: boolean; // false between sunset and sunrise
};

// A route plus its safety assessment against the San Jose datasets.
type ScoredRoute = Route & {
  crashes: Crash[];
  corridorMeters: number;
  corridorRatio: number;
  segOnCorridor: boolean[]; // per route segment, whether it runs along a corridor
  crashCount: number;
  highRiskCount: number;
  // Share of the route's length (0 to 1) within reach of a past crash.
  crashShare: number;
  // Where the route crosses a major road without a crosswalk or signal. Only
  // checked for Walk; crossingsChecked says whether it was.
  unsafeCrossings: LatLng[];
  crossingsChecked: boolean;
  riskScore: number; // lower = safer
  // Which of the two offered routes this is. They can be the same route.
  role: 'fastest' | 'safest' | null;
};

// Every data source is a free public server, so any of them can be slow or
// down. Requests give up after a while instead of leaving a spinner forever,
// and an error page from the server counts as a failure, not as "no data".
const TIMEOUT_MS = 15_000;

async function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const json = await res.json();
    // ArcGIS reports query errors as a 200 with an "error" object.
    if (json && typeof json === 'object' && 'error' in json && !('features' in json)) {
      throw new Error(`Server error from ${url}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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

// The dataset stores street names in capitals ("SANTA CLARA ST").
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
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

// "300 ft" reads aloud as "300 feet"; same for miles.
function spokenDistance(m: number): string {
  return formatDistance(m).replace(' ft', ' feet').replace(' mi', ' miles');
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// Local metre-per-degree scale around San Jose, good enough for city distances.
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320 * Math.cos((37.3 * Math.PI) / 180);

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

function fromXY(x: number, y: number): LatLng {
  return { latitude: y / M_PER_DEG_LAT, longitude: x / M_PER_DEG_LON };
}

function nearestSeg(p: LatLng, pts: LatLng[]): number {
  let best = 0;
  let bestM = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const m = pointToSegMeters(p, pts[i], pts[i + 1]);
    if (m < bestM) {
      bestM = m;
      best = i;
    }
  }
  return best;
}

// Where the map starts if the device location isn't available: downtown San Jose.
const DEFAULT_REGION: MapRegion = {
  latitude: 37.3382,
  longitude: -121.8863,
  latitudeDelta: 0.03,
  longitudeDelta: 0.03,
};

function bboxOfRegion(r: MapRegion): BBox {
  return [
    r.longitude - r.longitudeDelta / 2,
    r.latitude - r.latitudeDelta / 2,
    r.longitude + r.longitudeDelta / 2,
    r.latitude + r.latitudeDelta / 2,
  ];
}

// Running distance along the route to each point, in segMeters' local scale.
function cumulativeMeters(pts: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + segMeters(pts[i - 1], pts[i]));
  }
  return out;
}

type RouteSnap = {
  at: LatLng; // closest point on the route
  along: number; // metres along the route to `at`
  off: number; // metres from the user to `at`
  seg: number; // index of the segment `at` lies on
};

// Closest point to p on route segments [from, to).
function snapToRoute(
  p: LatLng,
  pts: LatLng[],
  cum: number[],
  from: number,
  to: number,
): RouteSnap {
  const P = toXY(p);
  let best: RouteSnap = { at: pts[0], along: 0, off: Infinity, seg: 0 };
  const end = Math.min(pts.length - 1, to);
  for (let i = Math.max(0, from); i < end; i++) {
    const A = toXY(pts[i]);
    const B = toXY(pts[i + 1]);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
    if (off < best.off) {
      best = {
        at: {
          latitude: pts[i].latitude + t * (pts[i + 1].latitude - pts[i].latitude),
          longitude: pts[i].longitude + t * (pts[i + 1].longitude - pts[i].longitude),
        },
        along: cum[i] + t * Math.sqrt(len2),
        off,
        seg: i,
      };
    }
  }
  return best;
}

// Compass bearing from a to b, in degrees clockwise from north.
function bearingDeg(a: LatLng, b: LatLng): number {
  const A = toXY(a);
  const B = toXY(b);
  return ((Math.atan2(B.x - A.x, B.y - A.y) * 180) / Math.PI + 360) % 360;
}

// Search is keyless: Photon (komoot's free OpenStreetMap search, built for
// search-as-you-type) first, then the phone's own geocoder if Photon is down
// or finds nothing.
const PHOTON_URL = 'https://photon.komoot.io/api/';
// Santa Clara County, roughly. The safety data only covers San Jose, so
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
  const json = await fetchJson(`${PHOTON_URL}?${params.toString()}`, signal);
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

// The public server is shared and sometimes busy or rate-limited, so a
// failed request is tried again after a short wait, up to `retries` times.
// OSRM answers "no route" with HTTP 400 and a JSON body, so that's read and
// returned; a timeout, a dropped connection, HTTP 429 or a server error is a
// real failure.
async function fetchOsrm(url: string, retries: number): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} from OSRM`);
      return await res.json();
    } catch (e) {
      if (attempt >= retries) throw e;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

// Runs fn over items with at most `limit` running at once, results in order.
// The public routing server rate-limits bursts: a dozen requests at once
// gets HTTP 429, and a few such bursts get the connection refused for a
// while, which then fails the next search too.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
  via: LatLng[] = [],
  retries = 0,
): Promise<Route[]> {
  const coords = [from, ...via, to].map((p) => `${p.longitude},${p.latitude}`).join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    // OSRM only offers alternatives between two points.
    alternatives: alternatives && !via.length ? 'true' : 'false',
  });
  const json = await fetchOsrm(`${OSRM_URL[mode]}/${coords}?${params.toString()}`, retries);
  const rs = json.routes;
  if (json.code !== 'Ok' || !Array.isArray(rs) || rs.length === 0) return [];
  return rs.map((r: any) => ({
    points: ((r.geometry?.coordinates ?? []) as number[][]).map(([lon, lat]) => ({
      latitude: lat,
      longitude: lon,
    })),
    meters: r.distance ?? 0,
    seconds: r.duration ?? 0,
    // A route through via points comes back as one leg per stretch. Drop the
    // "arrive" at each via point, and treat the next leg's "depart" as a quiet
    // street-name step, so navigation doesn't announce arriving mid-route.
    steps: ((r.legs ?? []) as any[])
      .flatMap((leg, li, legs) =>
        ((leg.steps ?? []) as any[])
          .filter((s) => !(li < legs.length - 1 && s.maneuver?.type === 'arrive'))
          .map((s) =>
            li > 0 && s.maneuver?.type === 'depart'
              ? { ...s, maneuver: { ...s.maneuver, type: 'new name', modifier: '' } }
              : s,
          ),
      )
      .map((s) => ({
        instruction: stepInstruction(s),
        meters: s.distance ?? 0,
        type: s.maneuver?.type ?? '',
        modifier: s.maneuver?.modifier ?? '',
      })),
  }));
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
  // Only Drive hands off to Google Maps, and it uses Google's own default
  // route. Walk and Bike navigate in-app instead (NavigationView), since
  // Google can only follow a custom path by turning it into stops.
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function openInGoogleMaps(route: Route, mode: GoogleTravelMode = 'walking') {
  Linking.openURL(googleMapsUrl(route, mode)).catch(() =>
    Alert.alert('Could not open Google Maps on this device.'),
  );
}

// San Jose only records crashes inside its own city limits, so a street just
// over the line in Santa Clara or an unincorporated county pocket shows no
// crashes whatever its real history. The ten City Council districts together
// cover exactly the city, so they tell us which parts of a route the data
// actually covers. Simplified to ~30 m, about 50 KB.
const CITY_DISTRICTS_URL =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
  '/MapServer/120/query?where=1%3D1&outFields=DISTRICT&outSR=4326' +
  '&maxAllowableOffset=0.0003&geometryPrecision=5&f=geojson';

// One polygon: its outer ring then any holes, as [lon, lat] pairs.
type CityPolygon = number[][][];

async function fetchCityLimits(): Promise<CityPolygon[]> {
  const json = await fetchJson(CITY_DISTRICTS_URL);
  const out: CityPolygon[] = [];
  for (const f of json.features ?? []) {
    const g = f.geometry;
    if (g?.type === 'Polygon') out.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') out.push(...g.coordinates);
  }
  return out;
}

// Even-odd ray casting over every ring, so holes count as outside.
function inPolygon(p: LatLng, poly: CityPolygon): boolean {
  const x = p.longitude;
  const y = p.latitude;
  let inside = false;
  for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function inCity(p: LatLng, city: CityPolygon[]): boolean {
  return city.some((poly) => inPolygon(p, poly));
}

// Share of a route's length (0 to 1) that lies inside the city, judged by
// each segment's midpoint.
function cityShare(pts: LatLng[], city: CityPolygon[]): number {
  let total = 0;
  let inside = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = segMeters(pts[i], pts[i + 1]);
    const mid = {
      latitude: (pts[i].latitude + pts[i + 1].latitude) / 2,
      longitude: (pts[i].longitude + pts[i + 1].longitude) / 2,
    };
    total += len;
    if (inCity(mid, city)) inside += len;
  }
  return total > 0 ? inside / total : 1;
}

// County expressways (Lawrence, Capitol, Almaden, San Tomas…) run through the
// city but are run by Santa Clara County, so their crashes aren't in the
// city's records either. They're found by name in the route's directions.
function countyExpressways(route: Route): { names: string[]; meters: number } {
  const names = new Set<string>();
  let meters = 0;
  for (const s of route.steps) {
    const m = s.instruction.match(/(?:onto|on) (.*\b(?:Expressway|Expwy)\b.*)$/i);
    if (!m) continue;
    names.add(m[1]);
    meters += s.meters;
  }
  return { names: [...names], meters };
}

// A crash within this many metres of the route counts as "along" it.
const NEAR_CRASH_M = 40;

// "Crash Locations Last Five Years" — every reported injury crash, not just the
// killed-or-severely-injured ones. NOTE: San Jose only logs crashes inside its
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
  'VEHICLEPARTYCATEGORY',
  'LIGHTING',
  'WEATHER',
  'HITANDRUNFLAG',
  'SPEEDINGFLAG',
].join(',');

// What the vehicle hit, for crashes involving someone walking or on a bike.
// Wheelchairs, skateboards and kick scooters count as walking; e-bikes and
// motorized scooters ride with bikes.
const WALK_INVOLVED = ['Pedestrian', 'Wheelchair', 'Skateboard', 'Scooter Non-Motorized'];
const BIKE_INVOLVED = ['Bike', 'Electric Bike', 'Scooter Motorized'];

// Narrow the query to a mode's crashes on the server, so the map's record
// limit isn't used up by crashes of other kinds. Drive is most of the data,
// so it's filtered after loading instead (see crashMode). A crash between a
// bike and a pedestrian matches both and counts as walking.
const MODE_WHERE: Record<TravelMode, string> = {
  walk:
    "(VEHICLEPARTYCATEGORY LIKE '%Pedestrian%' OR COLLISIONTYPE = 'Vehicle/Pedestrian'" +
    ` OR VEHICLEINVOLVEDWITH IN (${WALK_INVOLVED.map((v) => `'${v}'`).join(',')}))`,
  bike:
    "(VEHICLEPARTYCATEGORY LIKE '%Bicycle%' OR COLLISIONTYPE = 'Vehicle/Bike'" +
    ` OR VEHICLEINVOLVEDWITH IN (${BIKE_INVOLVED.map((v) => `'${v}'`).join(',')}))`,
  drive: '',
};

// Newest first, so when a busy area hits the record limit the recent crashes
// are the ones kept.
function crashesUrl(box: BBox, limit: number, mode: TravelMode): string {
  const geometry = box.join(',');
  const where = MODE_WHERE[mode]
    ? `(${CRASH_WHERE}) AND ${MODE_WHERE[mode]}`
    : CRASH_WHERE;
  return (
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
    '/MapServer/553/query?where=' +
    encodeURIComponent(where) +
    `&geometry=${geometry}` +
    '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326' +
    `&outFields=${CRASH_FIELDS}` +
    '&orderByFields=CRASHDATETIME%20DESC' +
    `&resultRecordCount=${limit}&returnGeometry=true&f=geojson`
  );
}

// Which travel mode a crash belongs to, from the parties involved
// ("Pedestrian, Driver") and what the vehicle hit.
function crashMode(p: any): TravelMode {
  const parties: string = p.VEHICLEPARTYCATEGORY ?? '';
  const involved: string = p.VEHICLEINVOLVEDWITH ?? '';
  const type: string = p.COLLISIONTYPE ?? '';
  if (
    parties.includes('Pedestrian') ||
    type === 'Vehicle/Pedestrian' ||
    WALK_INVOLVED.includes(involved)
  ) {
    return 'walk';
  }
  if (
    parties.includes('Bicycle') ||
    type === 'Vehicle/Bike' ||
    BIKE_INVOLVED.includes(involved)
  ) {
    return 'bike';
  }
  return 'drive';
}

const WALKER_NAME: Record<string, string> = {
  Wheelchair: 'wheelchair user',
  Skateboard: 'skateboarder',
  'Scooter Non-Motorized': 'scooter rider',
};
const RIDER_NAME: Record<string, string> = {
  'Electric Bike': 'e-bike',
  'Scooter Motorized': 'e-scooter',
};
const DRIVE_HIT: Record<string, string> = {
  'Other Vehicle': 'Car and car',
  'Motor Vehicle On Other Roadway': 'Car and car',
  'Parked Vehicle': 'Car and parked car',
  'Fixed Object': 'Car and object',
  'Other Object': 'Car and object',
  Motorcycle: 'Car and motorcycle',
  Train: 'Car and train',
  'Light Rail Vehicle': 'Car and light rail',
  Animal: 'Car and animal',
  'Non-Collision': 'Single car',
};

// Short label for who was involved, e.g. "Car and pedestrian".
function crashKind(p: any, mode: TravelMode): string {
  const parties: string = p.VEHICLEPARTYCATEGORY ?? '';
  const involved: string = p.VEHICLEINVOLVEDWITH ?? '';
  const hasCar = parties === '' || parties.includes('Driver');
  if (mode === 'walk') {
    const walker = WALKER_NAME[involved] ?? 'pedestrian';
    if (hasCar) return `Car and ${walker}`;
    return parties.includes('Bicycle') ? `Bicycle and ${walker}` : `${walker} crash`;
  }
  if (mode === 'bike') {
    const rider = RIDER_NAME[involved] ?? 'bicycle';
    return hasCar ? `Car and ${rider}` : `${rider[0].toUpperCase()}${rider.slice(1)} crash`;
  }
  return DRIVE_HIT[involved] ?? 'Car crash';
}

// One party from a police narrative ("33 year-old male drugged pedestrian"),
// reduced to just its role ("pedestrian"). Ages, genders and impairment are
// left out so the card stays factual without being blunt about real people.
function crashParty(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(\d+|unspecified) year-old\b/g, '')
    .replace(/\b(unspecified|male|female|drunk|tipsy|drugged|fatigued|impaired|hit-and-run)\b/g, '')
    .replace(/\brider in an? (\w+)/, '$1 rider')
    .replace(/^\s*in an?\b/, ' ')
    .replace(/\bemergency driver\b/, 'emergency vehicle driver')
    .replace(/\s+/g, ' ')
    .trim();
}

function withArticle(party: string): string {
  if (/^\d/.test(party)) return party; // "2 parked cars"
  return `${/^[aeiou]/.test(party) ? 'an' : 'a'} ${party}`;
}

function listParties(parties: string[]): string {
  return parties.length > 1
    ? `${parties.slice(0, -1).join(', ')} and ${parties[parties.length - 1]}`
    : parties[0];
}

// Turns "32 year-old male drunk truck driver vs 35 year-old female pedestrian
// vs 44 year-old male pedestrian with fatality" into "A truck driver collided
// with 2 pedestrians." The outcome is dropped too; the app only shows a risk
// level.
function gentleNarrative(narrative: string): string {
  const parties = narrative
    .replace(/\s+with\s+(fatalit|serious injur)[\s\S]*$/i, '')
    .split(/\s+vs\.?\s+/i)
    .map(crashParty)
    .filter(Boolean);
  if (!parties.length) return '';
  // Group repeats: three "pedestrian" parties become "3 pedestrians".
  const counts = new Map<string, number>();
  for (const p of parties.slice(1)) counts.set(p, (counts.get(p) ?? 0) + 1);
  const others = [...counts].map(([p, n]) =>
    n > 1 ? `${n} ${p.replace(/y$/, 'ie')}s` : withArticle(p),
  );
  const first = withArticle(parties[0]);
  const sentence = others.length
    ? `${first} collided with ${listParties(others)}.`
    : `Involved ${first}.`;
  return sentence[0].toUpperCase() + sentence.slice(1);
}

async function fetchCrashes(
  box: BBox,
  mode: TravelMode,
  limit = 2000,
  signal?: AbortSignal,
): Promise<Crash[]> {
  const json = await fetchJson(crashesUrl(box, limit, mode), signal);
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
    const crashModeOf = crashMode(p);
    if (crashModeOf !== mode) continue;
    out.push({
      id: Number(p.OBJECTID ?? out.length),
      at: { latitude: c[1], longitude: c[0] },
      severity,
      weight: fatal ? 8 : severe ? 4 : moderate ? 2 : 1,
      highRisk: fatal || severe,
      mode: crashModeOf,
      kind: crashKind(p, crashModeOf),
      dateMs: typeof p.CRASHDATETIME === 'number' ? p.CRASHDATETIME : null,
      streets: [p.INTASTREETNAME, p.INTBSTREETNAME]
        .filter(Boolean)
        .map(titleCase)
        .join(' & '),
      narrative: gentleNarrative(p.NARRATIVE ?? ''),
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

// Whether the city has any injury crashes on record in this box, of any kind.
// None at all means the area is outside San Jose's data, not that it's safe.
async function hasAnyCrashes(box: BBox): Promise<boolean> {
  const json = await fetchJson(
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
      '/MapServer/553/query?where=' +
      encodeURIComponent(CRASH_WHERE) +
      `&geometry=${box.join(',')}` +
      '&geometryType=esriGeometryEnvelope&inSR=4326&returnCountOnly=true&f=json',
  );
  return Number(json.count ?? 0) > 0;
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

// Crash dots only load once the map is zoomed in at least this far, so a
// city-wide view doesn't try to draw thousands of markers.
const MAX_CRASH_DELTA = 0.06;
const MAP_CRASH_LIMIT = 500;

// Crashes are shown by the worst injury: fatal or serious (red), moderate
// (orange) or minor (yellow). The map key lists these same three.
const CRASH_SEVERITY_KEY = [
  { label: 'Fatal or serious injury', color: MAP_COLORS.crashSerious },
  { label: 'Moderate injury', color: MAP_COLORS.crashModerate },
  { label: 'Minor injury', color: MAP_COLORS.crashMinor },
];

function severityIndex(c: Crash): number {
  return c.highRisk ? 0 : c.severity === 'moderate' ? 1 : 2;
}

function crashColor(c: Crash): string {
  return CRASH_SEVERITY_KEY[severityIndex(c)].color;
}

// e.g. "Fatal or serious injury · Car and pedestrian"
function crashTitle(c: Crash): string {
  return `${CRASH_SEVERITY_KEY[severityIndex(c)].label} · ${c.kind}`;
}

// What to call a mode's crashes in route summaries.
const CRASH_NOUN: Record<TravelMode, string> = {
  walk: 'pedestrian',
  bike: 'bike',
  drive: 'car',
};

// --- Crossing busy roads only at crosswalks (Walk) ---
//
// Major roads (tertiary and up) and pedestrian crossings (marked crosswalks
// and traffic signals) come from OpenStreetMap, bundled with the app in
// data/crossings.json. A route "crosses" a major road where it goes
// from one side of the road to the other; that crossing is safe if a
// crosswalk or signal is close by. Quiet residential streets aren't checked:
// every intersection there is a legal crosswalk, and most aren't painted.

type CrossingData = {
  roads: number[][]; // each road as flat [lon, lat, lon, lat, ...]
  crossings: number[]; // flat [lon, lat, lon, lat, ...]
};

type XY = { x: number; y: number };

type CrossingIndex = {
  segs: Map<string, [XY, XY][]>; // road segments by grid cell
  points: Map<string, XY[]>; // crossings by grid cell
};

// A crosswalk or signal within this distance of where the route crosses the
// road counts (signal nodes sit in the middle of an intersection, about this
// far from the painted crosswalks).
const CROSSWALK_NEAR_M = 25;
// How far along the route to look on each side of the road.
const SIDE_LOOK_M = 20;
// Ignore points this close to the road line when deciding which side they're on.
const SIDE_MIN_M = 3;
// Crossings closer together than this are one crossing.
const SAME_CROSSING_M = 30;
const CELL_M = 100;

const cellOf = (p: XY) => `${Math.floor(p.x / CELL_M)},${Math.floor(p.y / CELL_M)}`;

function add<T>(map: Map<string, T[]>, key: string, v: T) {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
}

// Cells a box from a to b (plus a margin) touches.
function cellsAround(a: XY, b: XY, marginM: number): string[] {
  const out: string[] = [];
  const x0 = Math.floor((Math.min(a.x, b.x) - marginM) / CELL_M);
  const x1 = Math.floor((Math.max(a.x, b.x) + marginM) / CELL_M);
  const y0 = Math.floor((Math.min(a.y, b.y) - marginM) / CELL_M);
  const y1 = Math.floor((Math.max(a.y, b.y) + marginM) / CELL_M);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
  return out;
}

function buildCrossingIndex(data: CrossingData): CrossingIndex {
  const segs = new Map<string, [XY, XY][]>();
  const points = new Map<string, XY[]>();
  for (const road of data.roads) {
    for (let i = 0; i + 3 < road.length; i += 2) {
      const a = toXY({ longitude: road[i], latitude: road[i + 1] });
      const b = toXY({ longitude: road[i + 2], latitude: road[i + 3] });
      const seg: [XY, XY] = [a, b];
      for (const cell of cellsAround(a, b, 0)) add(segs, cell, seg);
    }
  }
  for (let i = 0; i + 1 < data.crossings.length; i += 2) {
    const p = toXY({ longitude: data.crossings[i], latitude: data.crossings[i + 1] });
    add(points, cellOf(p), p);
  }
  return { segs, points };
}

let bundled: CrossingIndex | null | undefined;

// The San Jose data shipped with the app, indexed on first use. Null if the
// bundled file has no data, so crossings show as not checked rather than
// all clear.
function bundledCrossingIndex(): CrossingIndex | null {
  if (bundled === undefined) {
    const data: CrossingData = require('./assets/crossings.json');
    bundled = data.roads.length ? buildCrossingIndex(data) : null;
  }
  return bundled;
}

const cross = (a: XY, b: XY) => a.x * b.y - a.y * b.x;
const sub = (a: XY, b: XY) => ({ x: a.x - b.x, y: a.y - b.y });

function nearestCrossing(p: XY, index: CrossingIndex, maxM: number): XY | null {
  let best: XY | null = null;
  let bestM = maxM;
  for (const cell of cellsAround(p, p, maxM)) {
    for (const q of index.points.get(cell) ?? []) {
      const m = Math.hypot(q.x - p.x, q.y - p.y);
      if (m <= bestM) {
        bestM = m;
        best = q;
      }
    }
  }
  return best;
}

type RoadCrossing = { at: LatLng; hasCrosswalk: boolean };

// Every place the route crosses a major road, and whether there's a crosswalk.
function findCrossings(pts: LatLng[], index: CrossingIndex): RoadCrossing[] {
  const xy = pts.map(toXY);
  const cum = cumulativeMeters(pts);
  const total = cum[cum.length - 1] ?? 0;

  // Position along the route at a given distance from the start.
  let seg = 0;
  const at = (along: number): XY => {
    const d = Math.max(0, Math.min(total, along));
    while (seg > 0 && cum[seg] > d) seg--;
    while (seg < xy.length - 2 && cum[seg + 1] < d) seg++;
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? (d - cum[seg]) / len : 0;
    return {
      x: xy[seg].x + t * (xy[seg + 1].x - xy[seg].x),
      y: xy[seg].y + t * (xy[seg + 1].y - xy[seg].y),
    };
  };

  const found: XY[] = [];
  const out: RoadCrossing[] = [];
  for (let i = 0; i < xy.length - 1; i++) {
    const A = xy[i];
    const r = sub(xy[i + 1], A);
    const seen = new Set<[XY, XY]>();
    for (const cell of cellsAround(A, xy[i + 1], 0)) {
      for (const road of index.segs.get(cell) ?? []) {
        if (seen.has(road)) continue;
        seen.add(road);
        const [C, D] = road;
        const s = sub(D, C);
        const denom = cross(r, s);
        if (Math.abs(denom) < 1e-9) continue; // parallel
        const CA = sub(C, A);
        const t = cross(CA, s) / denom;
        const u = cross(CA, r) / denom;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        const P = { x: A.x + t * r.x, y: A.y + t * r.y };
        if (found.some((f) => Math.hypot(f.x - P.x, f.y - P.y) < SAME_CROSSING_M)) continue;
        // Only a real crossing if the route is on opposite sides of the road
        // a little before and after; walking along it or just touching it
        // at a corner isn't one.
        const along = cum[i] + t * Math.hypot(r.x, r.y);
        const sLen = Math.hypot(s.x, s.y);
        const before = cross(s, sub(at(along - SIDE_LOOK_M), C)) / sLen;
        const after = cross(s, sub(at(along + SIDE_LOOK_M), C)) / sLen;
        if (before * after >= 0 || Math.abs(before) < SIDE_MIN_M || Math.abs(after) < SIDE_MIN_M) {
          continue;
        }
        found.push(P);
        out.push({
          at: fromXY(P.x, P.y),
          hasCrosswalk: nearestCrossing(P, index, CROSSWALK_NEAR_M) !== null,
        });
      }
    }
  }
  return out;
}

// Whether walking straight from a to b would cross a major road.
function crossesMajorRoad(a: LatLng, b: LatLng, index: CrossingIndex): boolean {
  const A = toXY(a);
  const B = toXY(b);
  const r = sub(B, A);
  for (const cell of cellsAround(A, B, 0)) {
    for (const [C, D] of index.segs.get(cell) ?? []) {
      const s = sub(D, C);
      const denom = cross(r, s);
      if (Math.abs(denom) < 1e-9) continue; // parallel
      const CA = sub(C, A);
      const t = cross(CA, s) / denom;
      const u = cross(CA, r) / denom;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
    }
  }
  return false;
}

// The closest crosswalk or signal to an unsafe crossing, to route through
// instead. Null if there's none within reach.
function crosswalkNear(p: LatLng, index: CrossingIndex, maxM = 300): LatLng | null {
  const q = nearestCrossing(toXY(p), index, maxM);
  return q ? fromXY(q.x, q.y) : null;
}

// --- San Jose Vision Zero priority safety corridors (high-injury streets) ---

const SAFETY_CORRIDORS_URL =
  'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
  '/MapServer/514/query?where=1%3D1&outFields=SAFETYPRIORITYSTREET&outSR=4326&f=geojson';

// A route point within this many metres of a corridor counts as "on" it.
const ON_CORRIDOR_M = 25;
// The first and last stretch of a route don't count toward busy-road or
// crash-site overlap: a trip that starts or ends on a busy street can't
// always avoid it, so it shouldn't mark every route there as unsafe. Busy
// road in that stretch still adds to the risk score, so a way in from a
// quieter side wins when there is one.
const ENDPOINT_GRACE_M = 50;

// Draw every corridor in view only when zoomed in at least this far (degrees
// of latitude), so a city-wide view isn't flooded with lines.
const CORRIDOR_MAX_VIEW_DELTA = 0.15;

async function fetchSafetyCorridors(): Promise<Corridor[]> {
  const json = await fetchJson(SAFETY_CORRIDORS_URL);
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

function onAnyCorridor(p: LatLng, corridors: Corridor[]): boolean {
  return corridors.some(
    (c) =>
      bboxIntersect(c.bbox, [p.longitude, p.latitude, p.longitude, p.latitude], 0.001) &&
      c.points.some(
        (q, j) => j > 0 && pointToSegMeters(p, c.points[j - 1], q) <= ON_CORRIDOR_M,
      ),
  );
}

// OSRM ends a route on whichever path is nearest the destination, which for a
// shop on a busy street is often that street's sidewalk, even when a parking
// lot or footway behind it leads in from a quiet side street. These are the
// other paths near the destination that aren't on a busy road, to route to as
// well; scoring then picks the better way in. A path across a major road from
// the destination isn't a way in: the route would end there and leave the
// last stretch as an unmarked crossing the route never shows.
const ENTRANCE_MAX_M = 60;
const ENTRANCE_TRIES = 2;

async function quietEntrances(
  dest: LatLng,
  mode: GoogleTravelMode,
  corridors: Corridor[],
): Promise<LatLng[]> {
  const url = OSRM_URL[mode].replace('/route/v1/', '/nearest/v1/');
  const json = await fetchOsrm(`${url}/${dest.longitude},${dest.latitude}?number=8`, 0);
  const roads = bundledCrossingIndex();
  const out: LatLng[] = [];
  // The first waypoint is where OSRM's own route already ends.
  for (const w of ((json.waypoints ?? []) as any[]).slice(1)) {
    const [lon, lat] = w.location ?? [];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const p: LatLng = { latitude: lat, longitude: lon };
    if (segMeters(p, dest) > ENTRANCE_MAX_M || onAnyCorridor(p, corridors)) continue;
    if (roads && crossesMajorRoad(p, dest, roads)) continue;
    if (out.some((q) => segMeters(q, p) < 15)) continue;
    out.push(p);
    if (out.length >= ENTRANCE_TRIES) break;
  }
  return out;
}

// Rate one route: metres on Vision Zero priority safety corridors, the
// severity-weighted injury crashes alongside it (fatal 8 / severe 4 / moderate 2
// / minor 1), and, for Walk, major-road crossings without a crosswalk. Lower
// riskScore = safer.
function scoreRoute(
  route: Route,
  corridors: Corridor[],
  allCrashes: Crash[],
  crossings: CrossingIndex | null = null,
): ScoredRoute {
  const box = bboxOf(route.points);
  const nearCorridors = corridors.filter((c) =>
    bboxIntersect(c.bbox, box, 0.003),
  );
  const crashes = crashesNearRoute(route.points, allCrashes);

  const routeLen = route.points.reduce(
    (sum, p, i) => (i ? sum + segMeters(route.points[i - 1], p) : 0),
    0,
  );
  let total = 0;
  let onCorridor = 0;
  let endCorridor = 0;
  let nearCrash = 0;
  const segOnCorridor: boolean[] = [];
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const segLen = segMeters(a, b);
    const midAlong = total + segLen / 2;
    total += segLen;
    const atEnd = midAlong < ENDPOINT_GRACE_M || midAlong > routeLen - ENDPOINT_GRACE_M;
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
    if (atEnd) {
      if (near) endCorridor += segLen;
      segOnCorridor.push(false);
      continue;
    }
    if (near) onCorridor += segLen;
    segOnCorridor.push(near);
    // Crash overlap is measured in 10 m pieces, so one long straight segment
    // past a single crash doesn't count in full.
    if (crashes.some((c) => pointToSegMeters(c.at, a, b) <= NEAR_CRASH_M)) {
      const pieces = Math.max(1, Math.ceil(segLen / 10));
      for (let k = 0; k < pieces; k++) {
        const t = (k + 0.5) / pieces;
        const p = {
          latitude: a.latitude + t * (b.latitude - a.latitude),
          longitude: a.longitude + t * (b.longitude - a.longitude),
        };
        if (crashes.some((c) => segMeters(c.at, p) <= NEAR_CRASH_M)) nearCrash += segLen / pieces;
      }
    }
  }

  const corridorRatio = total > 0 ? onCorridor / total : 0;
  const crashShare = total > 0 ? nearCrash / total : 0;
  const crashCount = crashes.length;
  const highRiskCount = crashes.filter((c) => c.highRisk).length;
  const crashWeight = crashes.reduce((sum, c) => sum + c.weight, 0);
  const unsafeCrossings = crossings
    ? findCrossings(route.points, crossings)
        .filter((x) => !x.hasCrosswalk)
        .map((x) => x.at)
    : [];

  // Total exposure over the whole trip, not a rate per km: a longer detour
  // past the same crashes is no safer, so it mustn't score as if it were.
  // Busy-road distance dominates (10 m of corridor counts about as much as a
  // severe crash, and a busy road crossed without a crosswalk as much as 10 m
  // along one); crashes and any fatal or severe ones separate routes whose
  // busy-road use is close.
  const riskScore =
    (onCorridor + endCorridor) * 10 +
    crashWeight * 5 +
    highRiskCount * 25 +
    unsafeCrossings.length * 100;

  return {
    ...route,
    crashes,
    corridorMeters: onCorridor,
    corridorRatio,
    segOnCorridor,
    crashCount,
    highRiskCount,
    crashShare,
    unsafeCrossings,
    crossingsChecked: crossings !== null,
    riskScore,
    role: null,
  };
}

// The goal for the safest route: no high-risk zones, no past crashes, and no
// busy road crossed without a crosswalk.
function isRouteClear(r: ScoredRoute): boolean {
  return r.corridorMeters === 0 && r.crashCount === 0 && r.unsafeCrossings.length === 0;
}

// A route counts as safe only if at most 1% of its length is near past crash
// sites and at most 1% is in high-risk zones.
const SAFE_MAX_SHARE = 0.01;

function isSafeEnough(r: ScoredRoute): boolean {
  return r.crashShare <= SAFE_MAX_SHARE && r.corridorRatio <= SAFE_MAX_SHARE;
}

// Safest first. A route that's clear of every hazard always beats one that
// merely scores lower on the weighted risk formula. Next, fewer busy-road
// crossings without a crosswalk always wins: walking along a busy road's
// sidewalk is safer than crossing it mid-block, so no amount of avoided
// busy road makes up for an unmarked crossing. Equal risk goes to the
// shorter route, so the order is never a tie.
function compareSafety(a: ScoredRoute, b: ScoredRoute): number {
  const aClear = isRouteClear(a) ? 0 : 1;
  const bClear = isRouteClear(b) ? 0 : 1;
  if (aClear !== bClear) return aClear - bClear;
  return (
    a.unsafeCrossings.length - b.unsafeCrossings.length ||
    a.riskScore - b.riskScore ||
    a.meters - b.meters ||
    a.seconds - b.seconds
  );
}

function pickSafest(pool: ScoredRoute[]): ScoredRoute {
  return [...pool].sort(compareSafety)[0];
}

// The fastest route is the shortest one; equal lengths go to the safer.
function pickFastest(pool: ScoredRoute[]): ScoredRoute {
  return [...pool].sort((a, b) => a.meters - b.meters || compareSafety(a, b))[0];
}

// The routes offered, safest first: [safest, fastest]. The fastest is left
// out when it doesn't save at least a minute as shown on the cards, since
// then the safest route is also the fastest.
function rankRoutes(pool: ScoredRoute[]): ScoredRoute[] {
  const safest: ScoredRoute = { ...pickSafest(pool), role: 'safest' };
  const fastest: ScoredRoute = { ...pickFastest(pool), role: 'fastest' };
  if (Math.round(fastest.seconds / 60) >= Math.round(safest.seconds / 60)) return [safest];
  return [safest, fastest];
}

// --- Safer detours ---
// OSRM can't be told to avoid places. To steer around a danger spot, ask for
// a route through a point off to its side (usually a parallel street), and
// keep the result if it scores safer.

// How far to the side of a danger spot to aim a detour.
const DETOUR_OFFSET_M: Record<'walk' | 'bike', number> = { walk: 250, bike: 400 };
// A detour may take up to twice as long as the fastest route, and at most 25
// extra minutes, so the safest option stays one people would actually take.
const DETOUR_MAX_RATIO = 2;
const DETOUR_MAX_EXTRA_S = 25 * 60;
// Each round tries both sides of the worst spots on the current safest route;
// if a round finds nothing safer, the next aims twice as far out. The search
// stops early once the safest route has no danger spots left.
const DETOUR_ROUNDS = 3;
const DETOUR_SPOTS = 3;
// Detour requests sent to the routing server at once (see mapLimit), and in
// total per search. The server refuses connections after roughly a dozen
// requests in half a minute, and a search already makes about four before
// detours, so the detour search has to fit in what's left.
const DETOUR_CONCURRENCY = 2;
const DETOUR_MAX_REQUESTS = 8;
// Danger spots closer together than this are treated as one.
const SPOT_MERGE_M = 150;

type DangerSpot = { at: LatLng; weight: number; seg: number };


// Where a route meets danger: every crash beside it, and each stretch along a
// safety corridor (100 m counts like one severe crash). Nearby spots are
// merged; heaviest first. Unmarked crossings are fixed separately, by routing
// through the nearest crosswalk.
function dangerSpots(r: ScoredRoute): DangerSpot[] {
  const pts = r.points;
  const raw: DangerSpot[] = [];
  for (const c of r.crashes) {
    raw.push({ at: c.at, weight: c.weight, seg: nearestSeg(c.at, pts) });
  }
  let runStart = -1;
  let runM = 0;
  for (let i = 0; i <= r.segOnCorridor.length; i++) {
    if (i < r.segOnCorridor.length && r.segOnCorridor[i]) {
      if (runStart < 0) runStart = i;
      runM += segMeters(pts[i], pts[i + 1]);
    } else if (runStart >= 0) {
      const mid = Math.floor((runStart + i) / 2);
      raw.push({ at: pts[mid], weight: runM / 25, seg: mid });
      runStart = -1;
      runM = 0;
    }
  }
  raw.sort((a, b) => b.weight - a.weight);
  const merged: DangerSpot[] = [];
  for (const spot of raw) {
    const near = merged.find((m) => segMeters(m.at, spot.at) < SPOT_MERGE_M);
    if (near) near.weight += spot.weight;
    else merged.push({ ...spot });
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

// Points offsetM to the left and right of a spot, across the route's general
// direction there (measured over a few points, since single segments at a
// corner point every which way).
function sidePoints(spot: DangerSpot, pts: LatLng[], offsetM: number): LatLng[] {
  const a = toXY(pts[Math.max(0, spot.seg - 5)]);
  const b = toXY(pts[Math.min(pts.length - 1, spot.seg + 6)]);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const P = toXY(spot.at);
  return [1, -1].map((side) =>
    fromXY(P.x + side * nx * offsetM, P.y + side * ny * offsetM),
  );
}

// A route's detour points plus one more, in the order the route reaches them,
// so a new fix keeps the earlier ones.
function withVia(r: Route, v: LatLng): LatLng[] {
  const order = (p: LatLng) => nearestSeg(p, r.points);
  return [...(r.via ?? []), v].sort((a, b) => order(a) - order(b));
}

// A route forced through a point can run up a dead end and straight back.
function hasBacktrack(pts: LatLng[]): boolean {
  for (let i = 0; i < pts.length; i++) {
    let walked = 0;
    for (let j = i + 1; j < Math.min(pts.length, i + 300); j++) {
      walked += segMeters(pts[j - 1], pts[j]);
      if (walked > 40 && segMeters(pts[i], pts[j]) < 5) return true;
    }
  }
  return false;
}

// Share of a's points (sampled) that lie on b.
function overlapShare(a: LatLng[], b: LatLng[]): number {
  const step = Math.max(1, Math.floor(a.length / 40));
  let sampled = 0;
  let on = 0;
  for (let i = 0; i < a.length; i += step) {
    sampled++;
    for (let j = 0; j < b.length - 1; j++) {
      if (pointToSegMeters(a[i], b[j], b[j + 1]) <= 20) {
        on++;
        break;
      }
    }
  }
  return sampled ? on / sampled : 0;
}

function sameRoute(a: Route, b: Route): boolean {
  return overlapShare(a.points, b.points) > 0.9 && overlapShare(b.points, a.points) > 0.9;
}

// The two options are named for what they're for, and colored to match:
// green (or a warning color) for the safest route, grey (or red) for the fastest. A safest route that isn't
// safe enough is only a safer alternative.
function routeName(r: ScoredRoute): string {
  if (r.role !== 'safest') return 'Fastest';
  return isSafeEnough(r) ? 'Safest' : 'Safer alternative';
}

// The safest route's dot also shows how safe it is, by the larger of its
// shares near crash sites and on busy roads: green up to 1%, yellow up to 5%,
// red beyond. The fastest route's dot is red if it runs into any hazard (busy
// main roads, crash sites or a crossing without a crosswalk), grey otherwise.
const CAUTION_MAX_SHARE = 0.05;

function routeColor(r: ScoredRoute, alpha = 1): string {
  if (r.role !== 'safest') {
    return remainingHazards(r).length
      ? `rgba(255,59,48,${alpha})`
      : `rgba(142,142,147,${alpha})`;
  }
  const worst = Math.max(r.crashShare, r.corridorRatio);
  if (worst <= SAFE_MAX_SHARE) return `rgba(52,199,89,${alpha})`;
  if (worst <= CAUTION_MAX_SHARE) return `rgba(255,204,0,${alpha})`;
  return `rgba(255,59,48,${alpha})`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a route still runs into, e.g. ["0.1 mi of high-risk zones",
// "2 crash sites", "1 busy-road crossing without a crosswalk"]. Empty means
// it avoids everything checked.
function remainingHazards(r: ScoredRoute): string[] {
  const out: string[] = [];
  if (r.corridorMeters > 0) out.push(`${formatDistance(r.corridorMeters)} of high-risk zones`);
  if (r.crashCount > 0) out.push(plural(r.crashCount, 'crash site'));
  if (r.unsafeCrossings.length > 0) {
    out.push(plural(r.unsafeCrossings.length, 'busy-road crossing') + ' without a crosswalk');
  }
  return out;
}

// One line for the safest route: what it avoids, or what it couldn't.
function safestSummary(r: ScoredRoute): string {
  const left = remainingHazards(r);
  const avoided = r.crossingsChecked
    ? 'high-risk zones, crash sites and crossings without a crosswalk'
    : 'high-risk zones and crash sites';
  if (!left.length) return `Avoids all ${avoided}.`;
  return `No route within reach avoids everything. Still passes ${joinAnd(left)}.`;
}

// --- Explaining the pick ---

// One sentence comparing the shown route with another option, e.g. "Compared
// with the fastest route, this one passes 4 fewer past pedestrian crashes
// and 0.3 mi less of high-risk zones, and takes 3 min longer."
function comparePhrase(r: ScoredRoute, other: ScoredRoute, mode: TravelMode): string[] {
  const parts: string[] = [];
  const crashDiff = other.crashCount - r.crashCount;
  if (crashDiff !== 0) {
    const n = Math.abs(crashDiff);
    const crashes = `${CRASH_NOUN[mode]} crash${n === 1 ? '' : 'es'}`;
    parts.push(`${n} ${crashDiff > 0 ? 'fewer' : 'more'} past ${crashes}`);
  }
  const roadDiff = other.corridorMeters - r.corridorMeters;
  if (Math.abs(roadDiff) >= 50) {
    parts.push(`${formatDistance(Math.abs(roadDiff))} ${roadDiff > 0 ? 'less' : 'more'} of high-risk zones`);
  }
  const xDiff = other.unsafeCrossings.length - r.unsafeCrossings.length;
  if (xDiff !== 0) {
    parts.push(
      `${Math.abs(xDiff)} ${xDiff > 0 ? 'fewer' : 'more'} busy-road crossing${Math.abs(xDiff) === 1 ? '' : 's'} without a crosswalk`,
    );
  }
  return parts;
}

function joinAnd(parts: string[]): string {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

function explainRoute(
  r: ScoredRoute,
  all: ScoredRoute[],
  mode: TravelMode,
): string {
  const fastest = all.find((x) => x.role === 'fastest');
  const safest = all.find((x) => x.role === 'safest') ?? all[0];
  if (!fastest) {
    return `The ${routeName(safest).toLowerCase()} route is also the fastest, so it is the only option shown.`;
  }
  const other = r.role === 'safest' ? fastest : safest;
  const name = r.role === 'safest' ? 'the fastest route' : 'the safest route';
  const parts = comparePhrase(r, other, mode);
  const extra = Math.round((r.seconds - other.seconds) / 60);
  const time =
    extra > 0 ? `takes ${extra} min longer` : extra < 0 ? `saves ${-extra} min` : 'takes about the same time';
  if (!parts.length) return `Compared with ${name}, this one ${time}.`;
  return `Compared with ${name}, this one passes ${joinAnd(parts)}, and ${time}.`;
}

// Crashes along a route that happened in the dark or at dusk.
function afterDarkCount(r: ScoredRoute): number {
  return r.crashes.filter((c) => /^(dark|dusk)/i.test(c.lighting)).length;
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

// Current conditions near a point along the route (Fahrenheit, for San Jose).
async function fetchWeather(point: LatLng): Promise<Weather | null> {
  const params = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
    current_weather: 'true',
    temperature_unit: 'fahrenheit',
  });
  const json = await fetchJson(`${OPEN_METEO_URL}?${params.toString()}`);
  const current = json.current_weather;
  if (!current) return null;
  return {
    tempF: Math.round(current.temperature),
    description: weatherDescription(current.weathercode),
    isDay: current.is_day !== 0,
  };
}

// --- Turn-by-turn navigation (Walk and Bike) ---

type IconName = ComponentProps<typeof MaterialIcons>['name'];

// Further than this from the route (or than the GPS accuracy, if worse) for
// two fixes in a row counts as off route.
const OFF_ROUTE_M = 30;
// Within this many metres of the destination counts as arrived.
const ARRIVE_M = 20;

// Voice prompts give a heads-up `prealert` metres before a turn and announce
// the turn itself at `now` metres. Bikes cover ground faster, so they hear it
// earlier and see more of the map.
const NAV_PROFILE: Record<
  'walk' | 'bike',
  { prealert: number; now: number; zoom: number; altitude: number }
> = {
  walk: { prealert: 60, now: 15, zoom: 18, altitude: 300 },
  bike: { prealert: 150, now: 30, zoom: 17, altitude: 600 },
};


function maneuverIcon(step: Step): IconName {
  if (step.type === 'arrive') return 'place';
  if (step.type === 'roundabout' || step.type === 'rotary') {
    return step.modifier.includes('left') ? 'roundabout-left' : 'roundabout-right';
  }
  switch (step.modifier) {
    case 'left':
      return 'turn-left';
    case 'right':
      return 'turn-right';
    case 'slight left':
      return 'turn-slight-left';
    case 'slight right':
      return 'turn-slight-right';
    case 'sharp left':
      return 'turn-sharp-left';
    case 'sharp right':
      return 'turn-sharp-right';
    case 'uturn':
      return 'u-turn-left';
    default:
      return 'straight';
  }
}

// Full-screen guidance along one route: a map that follows the user, the next
// turn up top, voice prompts, and an off-route warning. Going off route points
// the user back to the chosen line rather than rerouting, since a fresh route
// from OSRM would be the fastest one, not the safest.
function NavigationView({
  route,
  mode,
  crashes,
  destinationLabel,
  onEnd,
}: {
  route: Route;
  mode: 'walk' | 'bike';
  crashes: Crash[];
  destinationLabel: string;
  onEnd: () => void;
}) {
  useKeepAwake();
  const profile = NAV_PROFILE[mode];
  const pts = route.points;
  const destination = pts[pts.length - 1];
  const mapRef = useRef<MapView>(null);
  const cum = useMemo(() => cumulativeMeters(pts), [pts]);
  const total = cum[cum.length - 1];
  // Where along the route each step's maneuver happens. OSRM's step lengths
  // tile the route end to end, so sum them and scale to our own measure.
  const maneuverAt = useMemo(() => {
    const sum = route.steps.reduce((acc, st) => acc + st.meters, 0);
    const scale = sum > 0 ? total / sum : 1;
    let acc = 0;
    return route.steps.map((st) => {
      const at = acc * scale;
      acc += st.meters;
      return at;
    });
  }, [route.steps, total]);

  const [pos, setPos] = useState<LatLng | null>(null);
  const [snap, setSnap] = useState<RouteSnap | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [arrived, setArrived] = useState(false);
  // Stops when the user drags the map; "Re-center" turns it back on.
  const [following, setFollowing] = useState(true);
  const [muted, setMuted] = useState(false);
  // Map orientation: the direction of travel up (default), or north up.
  const [northUp, setNorthUp] = useState(false);
  // Tilted 3D view (default) or flat top-down 2D.
  const [threeD, setThreeD] = useState(true);
  // Which way the map is turned, in degrees from north, for the compass.
  const [mapHeading, setMapHeading] = useState(0);
  const lastSeg = useRef(0);
  const offFixes = useRef(0);
  const heading = useRef(pts.length > 1 ? bearingDeg(pts[0], pts[1]) : 0);
  // Keys of voice prompts already spoken, so each plays once.
  const spoken = useRef(new Set<string>());

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 2,
        timeInterval: 1000,
      },
      (loc) => {
        const p = { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
        // Search near the last known spot first, so a route that doubles back
        // on itself doesn't skip ahead; fall back to the whole route.
        let s = snapToRoute(p, pts, cum, lastSeg.current - 5, lastSeg.current + 40);
        if (s.off > OFF_ROUTE_M) {
          const anywhere = snapToRoute(p, pts, cum, 0, pts.length);
          if (anywhere.off < s.off) s = anywhere;
        }
        const off = s.off > Math.max(OFF_ROUTE_M, loc.coords.accuracy ?? 0);
        offFixes.current = off ? offFixes.current + 1 : 0;
        if (!off) {
          lastSeg.current = s.seg;
          heading.current = bearingDeg(pts[s.seg], pts[s.seg + 1]);
        } else if ((loc.coords.heading ?? -1) >= 0) {
          heading.current = loc.coords.heading!;
        }
        setPos(p);
        setSnap(s);
        setOffRoute(offFixes.current >= 2);
      },
    )
      .then((s) => {
        if (cancelled) s.remove();
        else sub = s;
      })
      .catch(() => Alert.alert('Location access is needed for navigation.'));
    return () => {
      cancelled = true;
      sub?.remove();
      Speech.stop();
    };
  }, [pts, cum]);

  const progress = snap?.along ?? 0;
  const remaining = Math.max(0, total - progress);
  // The next maneuver still ahead (step 0 is "Start", already behind us).
  const nextIdx = maneuverAt.findIndex((at, i) => i > 0 && at > progress + 3);
  const next = nextIdx >= 0 ? route.steps[nextIdx] : null;
  const toNext = nextIdx >= 0 ? maneuverAt[nextIdx] - progress : 0;

  // Voice prompts, each spoken once: the start, a heads-up before every turn,
  // the turn itself, going off route, and arriving.
  useEffect(() => {
    if (!pos || !snap || arrived) return;
    const say = (key: string, text: string) => {
      if (spoken.current.has(key)) return;
      spoken.current.add(key);
      if (!muted) Speech.speak(text, { language: 'en-US' });
    };
    if (
      segMeters(pos, destination) <= ARRIVE_M ||
      (!offRoute && remaining <= ARRIVE_M)
    ) {
      setArrived(true);
      say('arrive', 'You have arrived at your destination.');
      return;
    }
    if (offRoute) {
      say('off', "You're off route. Head back to the blue line.");
      return;
    }
    spoken.current.delete('off');
    say('start', route.steps[0]?.instruction ?? 'Start');
    // OSRM marks plain street-name changes as steps; show them, don't speak them.
    if (!next || next.type === 'new name') return;
    if (toNext <= profile.now && next.type !== 'arrive') {
      spoken.current.add(`pre-${nextIdx}`);
      say(`now-${nextIdx}`, next.instruction);
    } else if (toNext <= profile.prealert) {
      say(`pre-${nextIdx}`, `In ${spokenDistance(toNext)}, ${lowerFirst(next.instruction)}`);
    }
  }, [pos, snap, offRoute, arrived, muted]);

  const cameraHeading = () => (northUp ? 0 : heading.current);
  const cameraPitch = threeD ? 45 : 0;

  function followCamera(p: LatLng) {
    setMapHeading(cameraHeading());
    mapRef.current?.animateCamera(
      {
        center: p,
        heading: cameraHeading(),
        pitch: cameraPitch,
        zoom: profile.zoom, // Google Maps (Android)
        altitude: profile.altitude, // Apple Maps (iOS)
      },
      { duration: 800 },
    );
  }

  useEffect(() => {
    if (pos && following) followCamera(pos);
  }, [pos, following, northUp, threeD]);

  // While the user is looking around, the compass and 2D/3D buttons only turn
  // or tilt the map where it is.
  useEffect(() => {
    if (following) return;
    if (northUp) setMapHeading(0);
    mapRef.current?.animateCamera(
      northUp ? { heading: 0, pitch: cameraPitch } : { pitch: cameraPitch },
      { duration: 400 },
    );
  }, [northUp, threeD]);

  // Grey behind the user, blue ahead.
  const walked = snap ? [...pts.slice(0, snap.seg + 1), snap.at] : [];
  const ahead = snap ? [snap.at, ...pts.slice(snap.seg + 1)] : pts;

  let icon: IconName;
  let headline: string;
  let detail: string;
  if (arrived) {
    icon = 'place';
    headline = "You've arrived";
    detail = destinationLabel;
  } else if (!snap) {
    icon = 'my-location';
    headline = 'Finding your location…';
    detail = route.steps[0]?.instruction ?? '';
  } else if (offRoute) {
    icon = 'wrong-location';
    headline = 'Off route';
    detail = `Head back to the blue line · ${formatDistance(snap.off)} away`;
  } else if (next) {
    icon = maneuverIcon(next);
    headline = formatDistance(toNext);
    detail = next.instruction;
  } else {
    icon = 'straight';
    headline = formatDistance(remaining);
    detail = 'Continue to your destination';
  }

  const secondsLeft = total > 0 ? (route.seconds * remaining) / total : 0;
  const arriveAt = new Date(Date.now() + secondsLeft * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <View style={styles.navScreen}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialCamera={{
          center: pts[0],
          heading: heading.current,
          pitch: cameraPitch,
          zoom: profile.zoom,
          altitude: profile.altitude,
        }}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        onPanDrag={() => setFollowing(false)}
        // Keep the compass true if the map was turned by hand.
        onRegionChangeComplete={() => {
          mapRef.current
            ?.getCamera()
            .then((c) => setMapHeading(c.heading ?? 0))
            .catch(() => {});
        }}
      >
        {walked.length > 1 && (
          <Polyline coordinates={walked} strokeColor="#8E8E93" strokeWidth={6} />
        )}
        <Polyline coordinates={ahead} strokeColor="#007AFF" strokeWidth={7} />
        <Marker coordinate={destination} title={destinationLabel} />
        {crashes.map((c) => (
          <Marker
            key={`nav-crash-${c.id}`}
            coordinate={c.at}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={[styles.crashDot, { backgroundColor: crashColor(c) }]} />
          </Marker>
        ))}
      </MapView>

      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={detail ? `${headline}. ${detail}` : headline}
        style={[
          styles.navBanner,
          offRoute && !arrived && styles.navBannerOff,
          arrived && styles.navBannerArrived,
        ]}
      >
        <MaterialIcons name={icon} size={44} color="#fff" />
        <View style={styles.navBannerText}>
          <Text style={styles.navHeadline}>{headline}</Text>
          {detail ? (
            <Text style={styles.navDetail} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.navBottom}>
        <View style={styles.navControlsRow}>
          {!following ? (
            <Pressable
              style={styles.navRecenter}
              accessibilityRole="button"
              onPress={() => {
                setFollowing(true);
                if (pos) followCamera(pos);
              }}
            >
              <MaterialIcons name="navigation" size={18} color="#007AFF" />
              <Text style={styles.navRecenterText}>Re-center</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <View style={styles.navMapButtons}>
            <Pressable
              style={[styles.navMapButton, northUp && styles.navMapButtonOn]}
              accessibilityRole="button"
              accessibilityState={{ selected: northUp }}
              accessibilityLabel={
                northUp
                  ? 'Compass, north up. Switch to direction of travel up'
                  : 'Compass. Switch to north up'
              }
              onPress={() => setNorthUp(!northUp)}
            >
              {/* The needle turns against the map, so it always points north. */}
              <View style={{ alignItems: 'center', transform: [{ rotate: `${-mapHeading}deg` }] }}>
                <Text style={styles.compassN}>N</Text>
                <MaterialIcons name="navigation" size={20} color="#FF3B30" />
              </View>
            </Pressable>
            <Pressable
              style={styles.navMapButton}
              accessibilityRole="button"
              accessibilityLabel={threeD ? 'Switch to flat 2D map' : 'Switch to tilted 3D map'}
              onPress={() => setThreeD(!threeD)}
            >
              <Text style={styles.navMapButtonText}>{threeD ? '2D' : '3D'}</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.navFooter}>
          <View style={styles.navFooterText}>
            <Text style={styles.navEta}>
              {arrived ? 'Arrived' : formatDuration(secondsLeft)}
            </Text>
            {!arrived && (
              <Text style={styles.navEtaSub}>
                {formatDistance(remaining)} · arrive {arriveAt}
              </Text>
            )}
          </View>
          <Pressable
            hitSlop={8}
            style={styles.navIconButton}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Unmute voice' : 'Mute voice'}
            onPress={() => {
              if (!muted) Speech.stop();
              setMuted(!muted);
            }}
          >
            <MaterialIcons
              name={muted ? 'volume-off' : 'volume-up'}
              size={24}
              color="#3A3A3C"
            />
          </Pressable>
          <Pressable
            style={[styles.navEndButton, arrived && styles.navDoneButton]}
            accessibilityRole="button"
            accessibilityLabel={arrived ? 'Done' : 'End navigation'}
            onPress={onEnd}
          >
            <Text style={styles.navEndText}>{arrived ? 'Done' : 'End'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

// The results under the map, laid out as cards: the two route options, a
// details card for the selected route, and a map key.

type Tone = 'good' | 'warn' | 'danger' | 'neutral';

const TONE_COLOR: Record<Tone, string> = {
  good: '#1E8E3E',
  warn: '#B25000',
  danger: '#C9182B',
  neutral: '#3A3A3C',
};

const pct = (share: number) => `${Math.round(share * 100)}%`;

function SectionTitle({ children }: { children: string }) {
  return (
    <Text style={cardStyles.sectionTitle} accessibilityRole="header">
      {children}
    </Text>
  );
}

// One small figure in a route card, e.g. "8%" over "Crash sites".
// A danger stat is tinted red with a warning icon, so the riskiest thing on a
// route stands out from the ordinary warnings beside it.
function Stat({ value, label, tone }: { value: string; label: string; tone: Tone }) {
  const danger = tone === 'danger';
  return (
    <View style={[cardStyles.stat, danger && cardStyles.statDanger]}>
      <View style={cardStyles.statValueRow}>
        {danger && <MaterialIcons name="warning" size={15} color={TONE_COLOR.danger} />}
        <Text style={[cardStyles.statValue, { color: TONE_COLOR[tone] }]}>{value}</Text>
      </View>
      <Text style={[cardStyles.statLabel, danger && { color: TONE_COLOR.danger }]}>{label}</Text>
    </View>
  );
}

function RouteOptionCard({
  route,
  selected,
  sameAsFastest,
  crashDataFailed,
  onPress,
}: {
  route: ScoredRoute;
  selected: boolean;
  sameAsFastest: boolean;
  crashDataFailed: boolean;
  onPress: () => void;
}) {
  const safest = route.role === 'safest';
  const safeEnough = safest && isSafeEnough(route);
  const unsafe = route.unsafeCrossings.length;
  const left = remainingHazards(route).length;
  return (
    <Pressable
      style={[cardStyles.card, cardStyles.optionCard, selected && cardStyles.optionSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityHint="Shows this route on the map"
      onPress={onPress}
    >
      <View style={cardStyles.optionHeader}>
        <View style={[cardStyles.roleDot, { backgroundColor: routeColor(route) }]} />
        <View style={cardStyles.optionTitleWrap}>
          <Text style={cardStyles.optionTitle}>
            {safeEnough && sameAsFastest ? 'Safest and fastest' : routeName(route)}
          </Text>
        </View>
        <View style={cardStyles.optionTime}>
          <Text style={cardStyles.optionMinutes}>{formatDuration(route.seconds)}</Text>
          <Text style={cardStyles.optionDistance}>{formatDistance(route.meters)}</Text>
        </View>
      </View>

      <View style={cardStyles.statRow}>
        <Stat
          value={crashDataFailed ? '—' : pct(route.crashShare)}
          label="Near crash sites"
          tone={crashDataFailed ? 'neutral' : route.crashShare > 0 ? 'warn' : 'good'}
        />
        <Stat
          value={pct(route.corridorRatio)}
          label="In high-risk zones"
          tone={route.corridorMeters > 0 ? 'warn' : 'good'}
        />
        {route.crossingsChecked && (
          <Stat
            value={unsafe === 0 ? 'All safe' : `${unsafe}`}
            label={unsafe === 0 ? 'Crossings' : `No crosswalk`}
            tone={unsafe === 0 ? 'good' : 'danger'}
          />
        )}
      </View>

      {safeEnough && !crashDataFailed && (
        <View style={cardStyles.summaryRow}>
          <MaterialIcons
            name={left ? 'error-outline' : 'check-circle'}
            size={16}
            color={TONE_COLOR[left ? 'warn' : 'good']}
          />
          <Text style={[cardStyles.summaryText, { color: TONE_COLOR[left ? 'warn' : 'good'] }]}>
            {safestSummary(route)}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

// Shown above the options when even the safest route isn't safe enough.
function NoSafeRouteBanner() {
  return (
    <View style={cardStyles.noSafeBanner} accessibilityRole="alert">
      <MaterialIcons name="warning" size={22} color="#8A4B00" />
      <View style={{ flex: 1 }}>
        <Text style={cardStyles.noSafeTitle}>
          There are no routes that avoid high-risk zones and past crash sites
        </Text>
      </View>
    </View>
  );
}

// A highlighted note: a warning, a tip or an explanation.
function Callout({
  icon,
  tone,
  children,
}: {
  icon: IconName;
  tone: 'warn' | 'info' | 'night';
  children: ReactNode;
}) {
  const palette = {
    warn: { bg: '#FFF4E5', fg: '#8A4B00' },
    info: { bg: '#EEF4FF', fg: '#1C3D7A' },
    night: { bg: '#EFEFF4', fg: '#2C2C2E' },
  }[tone];
  return (
    <View style={[cardStyles.callout, { backgroundColor: palette.bg }]}>
      <MaterialIcons name={icon} size={18} color={palette.fg} />
      <Text style={[cardStyles.calloutText, { color: palette.fg }]}>{children}</Text>
    </View>
  );
}

// A labeled fact about the selected route, e.g. "Busy main roads · None".
function FactRow({
  icon,
  label,
  value,
  tone,
  last,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone: Tone;
  last?: boolean;
}) {
  return (
    <View style={[cardStyles.factRow, !last && cardStyles.factDivider]}>
      <MaterialIcons name={icon} size={20} color="#8E8E93" />
      <Text style={cardStyles.factLabel}>{label}</Text>
      <Text style={[cardStyles.factValue, { color: TONE_COLOR[tone] }]}>{value}</Text>
    </View>
  );
}

// The selected route's heading, with distance, time and current weather.
function DetailsHeader({
  title,
  meters,
  seconds,
  verb,
  weather,
}: {
  title: string;
  meters: number;
  seconds: number;
  verb: string;
  weather: Weather | null;
}) {
  return (
    <View style={cardStyles.detailsHeader}>
      <View style={{ flex: 1 }}>
        <Text style={cardStyles.detailsTitle}>{title}</Text>
        <Text style={cardStyles.detailsSub}>
          {formatDistance(meters)} · {formatDuration(seconds)} {verb}
        </Text>
      </View>
      {weather && (
        <View style={cardStyles.weatherChip}>
          <MaterialIcons
            name={weather.isDay ? 'wb-sunny' : 'nightlight-round'}
            size={14}
            color="#3A3A3C"
          />
          <Text style={cardStyles.weatherText}>
            {weather.tempF}°F · {weather.description}
          </Text>
        </View>
      )}
    </View>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <View style={cardStyles.card}>{children}</View>;
}

function KeyItem({ swatch, label }: { swatch: ReactNode; label: string }) {
  return (
    <View style={cardStyles.keyItem}>
      <View style={cardStyles.keySwatch}>{swatch}</View>
      <Text style={cardStyles.keyText}>{label}</Text>
    </View>
  );
}

function KeyGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={cardStyles.keyGroup}>
      <Text style={cardStyles.keyGroupTitle}>{title}</Text>
      <View style={cardStyles.keyGrid}>{children}</View>
    </View>
  );
}

const crashDot = (color: string, ring?: string) => (
  <View
    style={[
      cardStyles.keyDot,
      { backgroundColor: color },
      ring ? { width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: ring } : null,
    ]}
  />
);

// What every line, pin and dot on the map means, and where the data comes
// from. Colors come from MAP_COLORS, the same ones the map is drawn with.
function MapKey({
  crashNoun,
  showCrossings,
  note,
}: {
  crashNoun: string;
  showCrossings: boolean;
  note: string;
}) {
  return (
    <View style={[cardStyles.card, cardStyles.keyCard]}>
      <KeyGroup title="Routes">
        <KeyItem
          swatch={<View style={[cardStyles.keyLine, { backgroundColor: MAP_COLORS.selectedRoute }]} />}
          label="Selected route"
        />
        <KeyItem
          swatch={
            <View style={cardStyles.keyDashed}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={[cardStyles.keyDash, { backgroundColor: MAP_COLORS.otherRoute }]} />
              ))}
            </View>
          }
          label="Other option"
        />
        <KeyItem
          swatch={<View style={[cardStyles.keyLine, { height: 8, backgroundColor: MAP_COLORS.highRiskZone }]} />}
          label="High-risk unsafe zone"
        />
      </KeyGroup>

      <KeyGroup title="Places">
        <KeyItem
          swatch={<MaterialIcons name="place" size={20} color={MAP_COLORS.start} />}
          label="Start"
        />
        <KeyItem
          swatch={<MaterialIcons name="place" size={20} color={MAP_COLORS.destination} />}
          label="Destination"
        />
        <KeyItem swatch={<View style={cardStyles.keyYou} />} label="You" />
      </KeyGroup>

      <KeyGroup title={`Past ${crashNoun} crashes`}>
        {CRASH_SEVERITY_KEY.map((k) => (
          <KeyItem key={k.label} swatch={crashDot(k.color)} label={k.label} />
        ))}
        <KeyItem
          swatch={crashDot(MAP_COLORS.crashSerious, MAP_COLORS.crashPicked)}
          label="Crash you tapped"
        />
      </KeyGroup>

      {showCrossings && (
        <KeyGroup title="Crossings">
          <KeyItem
            swatch={
              <View style={[cardStyles.keyXing, { backgroundColor: MAP_COLORS.noCrosswalk }]}>
                <MaterialIcons name="priority-high" size={10} color="#fff" />
              </View>
            }
            label="Crosses a busy road with no crosswalk"
          />
        </KeyGroup>
      )}

      <Text style={cardStyles.keyNote}>{note}</Text>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  sectionTitle: {
    marginTop: 24,
    marginBottom: 10,
    fontSize: 13,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#8E8E93',
    fontFamily: FONT.semibold,
  },
  card: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E5EA',
    marginBottom: 10,
  },
  optionCard: {
    borderWidth: 1.5,
  },
  optionSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#F3F8FF',
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  roleDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 6,
    marginRight: 10,
  },
  optionTitleWrap: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 18,
    color: '#1C1C1E',
    fontFamily: FONT.bold,
  },
  noSafeBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#FFF4E5',
  },
  noSafeTitle: {
    fontSize: 16,
    color: '#8A4B00',
    fontFamily: FONT.bold,
  },
  optionTime: {
    alignItems: 'flex-end',
    marginLeft: 12,
  },
  optionMinutes: {
    fontSize: 20,
    color: '#1C1C1E',
    fontFamily: FONT.bold,
  },
  optionDistance: {
    fontSize: 13,
    color: '#8E8E93',
    fontFamily: FONT.medium,
  },
  statRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 14,
  },
  stat: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#F2F2F7',
  },
  statDanger: {
    backgroundColor: '#FFEBEC',
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    fontSize: 16,
    fontFamily: FONT.bold,
  },
  statLabel: {
    marginTop: 2,
    fontSize: 11,
    color: '#6C6C70',
    fontFamily: FONT.medium,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 12,
  },
  summaryText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT.semibold,
  },
  callout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    marginBottom: 10,
  },
  calloutText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT.medium,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
  },
  factDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  factLabel: {
    flex: 1,
    fontSize: 15,
    color: '#1C1C1E',
    fontFamily: FONT.regular,
  },
  factValue: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  detailsHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 12,
  },
  detailsTitle: {
    fontSize: 18,
    color: '#1C1C1E',
    fontFamily: FONT.bold,
  },
  detailsSub: {
    marginTop: 2,
    fontSize: 14,
    color: '#6C6C70',
    fontFamily: FONT.medium,
  },
  weatherChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: '#F2F2F7',
    maxWidth: '50%',
  },
  weatherText: {
    flexShrink: 1,
    fontSize: 12,
    color: '#3A3A3C',
    fontFamily: FONT.medium,
  },
  keyCard: {
    backgroundColor: '#F9F9FB',
  },
  keyGroup: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  keyGroupTitle: {
    marginBottom: 8,
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: '#8E8E93',
    fontFamily: FONT.semibold,
  },
  keyGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: 10,
  },
  keyItem: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 6,
  },
  keySwatch: {
    width: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyLine: {
    width: 24,
    height: 4,
    borderRadius: 2,
  },
  keyDashed: {
    width: 24,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  keyDash: {
    width: 6,
    height: 3,
    borderRadius: 1,
  },
  keyDot: {
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#fff',
    // A faint outline so the yellow dot shows on the light card.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 1,
    shadowOffset: { width: 0, height: 0 },
    elevation: 1,
  },
  keyYou: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    borderColor: '#fff',
    backgroundColor: '#007AFF',
    shadowColor: '#007AFF',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  keyXing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 17,
    color: '#3A3A3C',
    fontFamily: FONT.regular,
  },
  keyNote: {
    marginTop: 12,
    fontSize: 12,
    lineHeight: 17,
    color: '#8E8E93',
    fontFamily: FONT.regular,
  },
});

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  // Walk and Bike show ranked alternatives with a full safety overlay; Drive
  // is a single default route with just a corridor-overlap check.
  const [travelMode, setTravelMode] = useState<TravelMode>('walk');
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  // While crash data loads and safer detours are tried for Walk/Bike.
  const [findingSafer, setFindingSafer] = useState(false);
  const [selected, setSelected] = useState<ResolvedPlace | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [scored, setScored] = useState<ScoredRoute[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [outOfArea, setOutOfArea] = useState(false);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  // San Jose's city limits, the only area its crash data covers.
  const [cityLimits, setCityLimits] = useState<CityPolygon[]>([]);
  // A failed download must not read as "no crashes here", so it's tracked and
  // shown instead of a safety rating.
  const [crashDataFailed, setCrashDataFailed] = useState(false);
  const [corridorsFailed, setCorridorsFailed] = useState(false);
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
  // The suggestion lookup in flight, so picking a place can stop it from
  // showing suggestions again after they were cleared.
  const lookup = useRef<AbortController | null>(null);

  // The address box sits below the map, where the keyboard would cover it.
  // While it's focused, the page scrolls it up to the top of the screen, and
  // bottom padding the height of the keyboard gives the page room to scroll.
  const scrollRef = useRef<ScrollViewInstance>(null);
  const addressY = useRef(0);
  const addressFocused = useRef(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  function scrollToAddress() {
    scrollRef.current?.scrollTo({
      y: Math.max(0, addressY.current - TOP_INSET),
      animated: true,
    });
  }

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (keyboardHeight > 0 && addressFocused.current) scrollToAddress();
  }, [keyboardHeight]);

  const mapRef = useRef<MapView>(null);
  // The map's current view, which decides which crash dots to load.
  const [region, setRegion] = useState<MapRegion>(DEFAULT_REGION);
  const [mapCrashes, setMapCrashes] = useState<Crash[]>([]);
  // The crash dot the user tapped, shown in a details card under the map.
  const [pickedCrash, setPickedCrash] = useState<Crash | null>(null);
  // The map waits for the location lookup to finish so it can open centered
  // on the user instead of jumping there after it has already rendered.
  const [locationChecked, setLocationChecked] = useState(false);
  // Walk/Bike turn-by-turn guidance along the active route.
  const [navigating, setNavigating] = useState(false);

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

  // Priority safety corridors for the map overlay: every one in view once
  // zoomed in to neighborhood level, plus any near the route(s) shown.
  const nearbyCorridors = useMemo(() => {
    const view = bboxOfRegion(region);
    const inView = (c: Corridor) =>
      region.latitudeDelta <= CORRIDOR_MAX_VIEW_DELTA && bboxIntersect(c.bbox, view);
    const routesShown: Route[] =
      ranksRoutes ? scored : driveResult ? [driveResult] : [];
    if (!routesShown.length) return corridors.filter(inView);
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
    return corridors.filter((c) => inView(c) || bboxIntersect(c.bbox, box, 0.003));
  }, [region, ranksRoutes, scored, driveResult, corridors]);

  // Share of the shown route inside San Jose's city limits. Anything outside
  // has no crash data, so it may look safer than it is.
  const shownCityShare = useMemo(() => {
    const r = ranksRoutes ? active : driveResult;
    return r && cityLimits.length ? cityShare(r.points, cityLimits) : 1;
  }, [ranksRoutes, active, driveResult, cityLimits]);

  // Ask for location on mount; it centers the map and biases search results
  // toward what's nearby. After that, keep following the device so the start
  // of a route is where the user is now, not where they opened the app.
  useEffect(() => {
    let cancelled = false;
    let watch: Location.LocationSubscription | null = null;
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
        if (cancelled) return;
        if (pos) {
          setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          setRegion({
            ...DEFAULT_REGION,
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          });
        }
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 20 },
          (loc) => setCoords({ lat: loc.coords.latitude, lon: loc.coords.longitude }),
        );
        if (cancelled) sub.remove();
        else watch = sub;
      } catch {
        // No location available; the map stays on San Jose and searches
        // fall back to global ranking.
      } finally {
        if (!cancelled) setLocationChecked(true);
      }
    })();
    return () => {
      cancelled = true;
      watch?.remove();
    };
  }, []);

  // Where a route starts: a fresh GPS fix, so it's right even if the user has
  // moved since the last update. Falls back to the latest followed position
  // if the GPS is slow to answer.
  async function currentOrigin(): Promise<LatLng | null> {
    try {
      const pos = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (pos) {
        setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      }
    } catch {
      // Fall through to the last known position.
    }
    return coords ? { latitude: coords.lat, longitude: coords.lon } : null;
  }

  // Frame the route being shown whenever it changes.
  useEffect(() => {
    const pts = ranksRoutes ? active?.points : driveResult?.points;
    if (pts?.length) mapRef.current?.animateToRegion(regionForRoute(pts), 400);
  }, [ranksRoutes, active, driveResult]);

  // Load the crash dots for whatever part of the map is in view, once the
  // user stops panning. Only the current mode's crashes are shown.
  useEffect(() => {
    if (region.latitudeDelta > MAX_CRASH_DELTA) {
      setMapCrashes([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchCrashes(bboxOfRegion(region), travelMode, MAP_CRASH_LIMIT, controller.signal)
        .then(setMapCrashes)
        .catch(() => {});
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [region, travelMode]);

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
    lookup.current = controller;
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

  // Show a picked place in the box and close the suggestions. Setting the
  // text to what it already is doesn't re-run the lookup effect, so only
  // skip the next lookup when the text actually changes.
  function showPlace(place: Suggestion) {
    lookup.current?.abort();
    if (place.label !== address) skipNextLookup.current = true;
    setAddress(place.label);
    setSuggestions([]);
    setSelected(place);
  }

  function handleSelect(item: Suggestion) {
    Keyboard.dismiss();
    showPlace(item);
  }

  // Load San Jose's priority safety corridors and city limits once. If the
  // corridors fail, the next route search tries again.
  function loadCorridors() {
    setCorridorsFailed(false);
    fetchSafetyCorridors()
      .then(setCorridors)
      .catch(() => setCorridorsFailed(true));
  }

  useEffect(() => {
    loadCorridors();
    fetchCityLimits()
      .then(setCityLimits)
      .catch(() => setCityLimits([]));
  }, []);

  // Score every alternative against the Vision Zero safety corridors and the
  // crash history for this mode only (pedestrian crashes for Walk, bike
  // crashes for Bike), try detours around the worst spots, then pick the
  // safest as active.
  useEffect(() => {
    if (!routes.length) {
      setScored([]);
      setActiveIdx(0);
      setOutOfArea(false);
      setFindingSafer(false);
      return;
    }

    let cancelled = false;
    setFindingSafer(true);
    (async () => {
      const offsetM = DETOUR_OFFSET_M[travelMode === 'bike' ? 'bike' : 'walk'];
      // One crash fetch covering all alternatives, wide enough for detours.
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
      const crashBox = padBBox(allBox, 0.003 + (offsetM * 2) / M_PER_DEG_LAT);
      let allCrashes: Crash[] = [];
      let inCityData = true;
      let failed = false;
      try {
        allCrashes = await fetchCrashes(crashBox, travelMode);
        // Without the city limits, an area with no crashes of any kind on
        // record is taken to be outside the city's data.
        if (!allCrashes.length && !cityLimits.length) {
          inCityData = await hasAnyCrashes(crashBox);
        }
      } catch {
        failed = true;
      }
      if (cancelled) return;

      // Crossings are only checked for Walk; bikes cross with traffic.
      const crossings = travelMode === 'walk' ? bundledCrossingIndex() : null;
      const score = (r: Route) => scoreRoute(r, corridors, allCrashes, crossings);
      const pool = routes.map(score);
      const outside = cityLimits.length
        ? pool.every((r) => cityShare(r.points, cityLimits) < 0.02)
        : corridors.length > 0 && !inCityData && pool.every((r) => r.corridorMeters === 0);

      // Work on the current safest route until it avoids everything or the
      // rounds run out. Each round tries routing through the nearest crosswalk
      // for every unmarked crossing, and through points beside the worst
      // crash and busy-road spots. Earlier detour points are kept, so fixes add
      // up. Results that are too slow, double back or repeat are dropped.
      if (!outside && !failed) {
        const origin = routes[0].points[0];
        const dest = routes[0].points[routes[0].points.length - 1];
        const fastest = Math.min(...routes.map((r) => r.seconds));
        const maxSeconds = Math.min(fastest * DETOUR_MAX_RATIO, fastest + DETOUR_MAX_EXTRA_S);
        let reach = offsetM;
        let budget = DETOUR_MAX_REQUESTS;
        for (let round = 0; round < DETOUR_ROUNDS && budget > 0; round++) {
          const best = pickSafest(pool);
          if (isRouteClear(best)) break;
          const tries: LatLng[][] = [];
          if (crossings) {
            // Unmarked crossings are fixed on the current pick and on the
            // lowest-risk route that has any: that route ranks below routes
            // without unmarked crossings, but sent through a crosswalk it may
            // be the safest of all.
            const lowestRisk = [...pool].sort((a, b) => a.riskScore - b.riskScore)[0];
            const bases = lowestRisk !== best && lowestRisk.unsafeCrossings.length
              ? [best, lowestRisk]
              : [best];
            for (const base of bases) {
              for (const x of base.unsafeCrossings.slice(0, DETOUR_SPOTS)) {
                const v = crosswalkNear(x, crossings);
                if (v) tries.push(withVia(base, v));
              }
            }
          }
          for (const spot of dangerSpots(best).slice(0, DETOUR_SPOTS)) {
            for (const v of sidePoints(spot, best.points, reach)) tries.push(withVia(best, v));
          }
          if (!tries.length) break;
          // Crosswalk fixes come first in tries, so they're kept when the
          // budget runs short.
          const batch = tries.slice(0, budget);
          budget -= batch.length;
          let refused = false;
          const found = await mapLimit(batch, DETOUR_CONCURRENCY, (via) =>
            cancelled || refused
              ? Promise.resolve(null)
              : fetchRoutes(origin, dest, GOOGLE_MODE[travelMode], false, via)
                  .then((rs) => (rs[0] ? { ...rs[0], via } : null))
                  .catch(() => {
                    // The server is pushing back: stop asking, so the next
                    // search isn't refused too.
                    refused = true;
                    return null;
                  }),
          );
          if (cancelled) return;
          for (const r of found) {
            if (!r || r.seconds > maxSeconds || hasBacktrack(r.points)) continue;
            if (pool.some((p) => sameRoute(p, r))) continue;
            pool.push(score(r));
          }
          if (refused) break;
          if (pickSafest(pool) === best) reach *= 2;
        }
      }

      setScored(rankRoutes(pool));
      // Select the safest route, the recommendation (listed first).
      setActiveIdx(0);
      setOutOfArea(outside);
      setCrashDataFailed(failed);
      setFindingSafer(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [routes, corridors, cityLimits, travelMode]);

  // Resolves the address to coordinates, using the already-picked suggestion
  // if there is one, otherwise geocoding the text and taking the closest match.
  async function resolveDestination(query: string): Promise<ResolvedPlace | null> {
    if (selected) return selected;
    const results = await searchPlaces(query, coords);
    const dest = results[0] ?? null;
    if (dest) showPlace(dest);
    return dest;
  }

  async function handleRoute() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;
    if (corridorsFailed) loadCorridors();

    setLoading(true);
    try {
      const dest = await resolveDestination(query);
      if (!dest) {
        Alert.alert('No matching address found.');
        return;
      }
      setSuggestions([]);
      const origin = await currentOrigin();
      if (!origin) {
        Alert.alert('Could not find your current location. Check that location access is on.');
        return;
      }
      const destination = { latitude: dest.latitude, longitude: dest.longitude };
      const midpoint = {
        latitude: (origin.latitude + destination.latitude) / 2,
        longitude: (origin.longitude + destination.longitude) / 2,
      };
      const mode = GOOGLE_MODE[travelMode];
      const [found, viaEntrances] = await Promise.all([
        fetchRoutes(origin, destination, mode, true, [], 2),
        // Extra routes are a bonus, so any failure here is ignored.
        quietEntrances(destination, mode, corridors)
          .then((points) =>
            Promise.all(
              points.map((p) =>
                fetchRoutes(origin, p, mode, false)
                  .then((rs) => rs[0] ?? null)
                  .catch(() => null),
              ),
            ),
          )
          .catch((): (Route | null)[] => []),
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
      const extra = viaEntrances.filter(
        (r): r is Route => r !== null && !found.some((f) => sameRoute(f, r)),
      );
      setRoutes([...found, ...extra]);
    } catch {
      Alert.alert(
        "Couldn't load directions",
        'The free routing server may be busy or your connection dropped. Please try again in a moment.',
      );
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
    if (corridorsFailed) loadCorridors();

    setLoading(true);
    try {
      const dest = await resolveDestination(query);
      if (!dest) {
        Alert.alert('No matching address found.');
        return;
      }
      setSuggestions([]);
      const origin = await currentOrigin();
      if (!origin) {
        Alert.alert('Could not find your current location. Check that location access is on.');
        return;
      }
      const destination = { latitude: dest.latitude, longitude: dest.longitude };
      const found = await fetchRoutes(origin, destination, 'driving', false, [], 2);
      if (!found.length) {
        Alert.alert('Could not find a driving route to that address.');
        return;
      }
      // Drive is scored on vehicle-only crashes (car and car, car and object).
      let carCrashes: Crash[] = [];
      let failed = false;
      try {
        carCrashes = await fetchCrashes(padBBox(bboxOf(found[0].points), 0.003), 'drive');
      } catch {
        failed = true;
      }
      setCrashDataFailed(failed);
      // Drive has no ranking effect to fill this in, so check the weather here.
      fetchWeather(found[0].points[Math.floor(found[0].points.length / 2)])
        .then(setWeather)
        .catch(() => setWeather(null));
      setDriveResult(scoreRoute(found[0], corridors, carCrashes));
    } catch {
      Alert.alert(
        "Couldn't check the route",
        'The free routing server may be busy or your connection dropped. Please try again in a moment.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!fontsLoaded) {
    return <View style={styles.container} />;
  }

  if (navigating && active) {
    return (
      <View style={styles.container}>
        <NavigationView
          route={active}
          mode={travelMode === 'bike' ? 'bike' : 'walk'}
          crashes={active.crashes}
          destinationLabel={selected?.label ?? address}
          onEnd={() => setNavigating(false)}
        />
        <StatusBar style="light" />
      </View>
    );
  }

  // The route drawn on the map: the chosen walk/bike option, or Drive's route.
  const shownRoute: ScoredRoute | null = ranksRoutes ? active : driveResult;
  const findRoute = () => (ranksRoutes ? handleRoute() : handleDriveCheck());
  const currentTab = TRAVEL_TABS.find((t) => t.mode === travelMode)!;
  const expressways = shownRoute ? countyExpressways(shownRoute) : { names: [], meters: 0 };
  // Gaps in what was checked, shown above the rating so it isn't trusted blindly.
  const dataWarnings = shownRoute
    ? ([
        crashDataFailed &&
          "Couldn't load the city's crash records, so crashes along this route weren't checked. Try the search again.",
        corridorsFailed &&
          "Couldn't load the city's map of high-risk zones, so they weren't checked.",
        !outOfArea &&
          shownCityShare < 0.9 &&
          `About ${Math.round((1 - shownCityShare) * 100)}% of this route is outside San Jose city limits. ` +
            'The city has no crash records there, so those parts may be riskier than shown.',
        expressways.meters >= 100 &&
          `This route uses ${expressways.names.join(' and ')} for ${formatDistance(expressways.meters)}. ` +
            "County expressways aren't in the city's crash records, so that stretch may be riskier than shown.",
      ].filter(Boolean) as string[])
    : [];
  const whyThisRoute = ranksRoutes && active ? explainRoute(active, scored, travelMode) : null;
  // After sunset, point out crashes along the route that also happened in the dark.
  const darkCrashes =
    weather && !weather.isDay && shownRoute ? afterDarkCount(shownRoute) : 0;
  const warningCallouts = dataWarnings.map((w) => (
    <Callout key={w} icon="info-outline" tone="warn">
      {w}
    </Callout>
  ));
  const darkCallout =
    darkCrashes > 0 ? (
      <Callout icon="nightlight-round" tone="night">
        It's dark out. {darkCrashes} of the crashes along this route happened
        after dark, so stay visible and cross at lit intersections.
      </Callout>
    ) : null;
  const crashDetails = pickedCrash
    ? [
        [
          // "Vehicle/Pedestrian" just repeats the title; types like
          // "Broadside" or "Rear End" add something.
          pickedCrash.collisionType.startsWith('Vehicle/')
            ? ''
            : `${pickedCrash.collisionType} collision`,
        ]
          .filter(Boolean)
          .join(' '),
        [pickedCrash.lighting, pickedCrash.weather].filter(Boolean).join(' · '),
        [pickedCrash.hitAndRun && 'Hit and run', pickedCrash.speeding && 'Speeding']
          .filter(Boolean)
          .join(' · '),
      ].filter(Boolean)
    : [];
  const busyRoadsValue = (r: ScoredRoute) =>
    r.corridorMeters === 0
      ? 'None'
      : `${formatDistance(r.corridorMeters)} (${Math.round(r.corridorRatio * 100)}%)`;
  const crashesValue = (r: ScoredRoute) =>
    crashDataFailed
      ? 'Not checked'
      : r.crashCount === 0
        ? 'None reported'
        : `${r.crashCount} nearby${r.highRiskCount ? ` · ${r.highRiskCount} serious` : ''}`;

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scrollBody,
          keyboardHeight > 0 && { paddingBottom: keyboardHeight + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.searchBar}>
          <View style={styles.titleRow}>
            <View style={styles.logoBadge}>
              <MaterialIcons name="alt-route" size={22} color="#fff" />
            </View>
            <Text style={styles.greeting} accessibilityRole="header">
              WalkWise <Text style={styles.greetingCity}>San Jose</Text>
            </Text>
          </View>
          <Text style={styles.tagline}>
            Find the safest way to walk, bike or drive to your destination, using
            San Jose's real crash data and Vision Zero high-injury streets.
          </Text>

          <View style={styles.headerDivider} />

          <View style={styles.tabRow} accessibilityRole="tablist">
            {TRAVEL_TABS.map(({ mode, label, icon }, i) => {
              const isActive = travelMode === mode;
              return (
                <Pressable
                  key={mode}
                  style={[styles.tabButton, i > 0 && styles.tabButtonDivided]}
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
                  strokeColor={MAP_COLORS.highRiskZone}
                  strokeWidth={10}
                />
              ))}
              {ranksRoutes &&
                scored.map((r, i) =>
                  i === activeIdx ? null : (
                    <Polyline
                      key={`alt-${i}`}
                      coordinates={r.points}
                      strokeColor={MAP_COLORS.otherRoute}
                      strokeWidth={3}
                      lineDashPattern={[6, 6]}
                    />
                  ),
                )}
              {shownRoute && (
                <Polyline
                  coordinates={shownRoute.points}
                  strokeColor={MAP_COLORS.selectedRoute}
                  strokeWidth={5}
                />
              )}
              {shownRoute && (
                <Marker
                  coordinate={shownRoute.points[0]}
                  title="Start"
                  pinColor={MAP_COLORS.start}
                />
              )}
              {shownRoute && (
                <Marker
                  coordinate={shownRoute.points[shownRoute.points.length - 1]}
                  title={selected?.label ?? 'Destination'}
                  pinColor={MAP_COLORS.destination}
                />
              )}
              {shownRoute?.unsafeCrossings.map((x, i) => (
                <Marker
                  key={`xing-${i}`}
                  coordinate={x}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={false}
                  title="No crosswalk here"
                  description="This route crosses a busy road away from a crosswalk or signal."
                >
                  <View
                    style={styles.xingMarker}
                    accessible
                    accessibilityLabel="Busy-road crossing without a crosswalk"
                  >
                    <MaterialIcons name="priority-high" size={14} color="#fff" />
                  </View>
                </Marker>
              ))}
              {mapCrashes.map((c) => {
                const picked = pickedCrash?.id === c.id;
                return (
                  <Marker
                    // Markers don't redraw on their own (tracksViewChanges is
                    // off for speed), so the key changes when one is picked.
                    key={`crash-${c.id}${picked ? '-picked' : ''}`}
                    coordinate={c.at}
                    anchor={{ x: 0.5, y: 0.5 }}
                    tracksViewChanges={false}
                    zIndex={picked ? 10 : 1}
                    onPress={() => setPickedCrash(c)}
                  >
                    <View
                      style={styles.crashHit}
                      accessible
                      accessibilityRole="button"
                      accessibilityState={{ selected: picked }}
                      accessibilityLabel={`${crashTitle(c)}. Show details`}
                    >
                      <View
                        style={[
                          styles.crashDot,
                          picked && styles.crashDotPicked,
                          { backgroundColor: crashColor(c) },
                        ]}
                      />
                    </View>
                  </Marker>
                );
              })}
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
              <Pressable
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close crash details"
                onPress={() => setPickedCrash(null)}
              >
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

        <View
          style={styles.addressSection}
          onLayout={(e) => {
            addressY.current = e.nativeEvent.layout.y;
          }}
        >
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
              placeholder="Where are you going?"
              placeholderTextColor="#8E8E93"
              accessibilityLabel="Destination address"
              // The app shows its own suggestions, so keep the phone's
              // AutoFill from offering saved addresses on top of them.
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
              clearButtonMode="while-editing"
              selectTextOnFocus
              onFocus={() => {
                addressFocused.current = true;
                // Already open (e.g. coming back from another field): scroll now.
                if (keyboardHeight > 0) scrollToAddress();
              }}
              onBlur={() => {
                addressFocused.current = false;
              }}
              onSubmitEditing={findRoute}
            />
          </View>

          {suggestions.length > 0 && (
            <View style={styles.suggestions}>
              {suggestions.map((item) => (
                <Pressable
                  key={item.id}
                  style={styles.suggestionRow}
                  accessibilityRole="button"
                  onPress={() => handleSelect(item)}
                >
                  <Text style={styles.suggestionText}>{item.label}</Text>
                </Pressable>
              ))}
            </View>
          )}

          <View style={styles.modeRow}>
            <Pressable
              disabled={!canRoute}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canRoute }}
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
                  {ranksRoutes ? 'Find safe route' : 'Check route safety'}
                </Text>
              </View>
            </Pressable>
          </View>

          {loading && <ActivityIndicator style={styles.spinner} />}
          {findingSafer && (
            <View style={styles.findingRow}>
              <ActivityIndicator />
              <Text style={styles.findingText}>Looking for safe routes…</Text>
            </View>
          )}
        </View>

        <View style={styles.results}>
          {ranksRoutes && scored.length > 0 && (
            <>
              <SectionTitle>Your options</SectionTitle>
              {!isSafeEnough(scored[0]) && (
                <NoSafeRouteBanner />
              )}
              {scored.map((r, i) => (
                <RouteOptionCard
                  key={r.role ?? i}
                  route={r}
                  selected={i === activeIdx}
                  sameAsFastest={scored.length === 1}
                  crashDataFailed={crashDataFailed}
                  onPress={() => setActiveIdx(i)}
                />
              ))}
            </>
          )}

          {ranksRoutes && active && (
            <>
              <Pressable
                style={({ pressed }) => [
                  styles.gmapsButton,
                  styles.startButton,
                  pressed && styles.modeButtonPressed,
                ]}
                accessibilityRole="button"
                onPress={() => setNavigating(true)}
              >
                <View style={styles.modeButtonContent}>
                  <MaterialIcons name="navigation" size={22} color="#fff" />
                  <Text style={styles.gmapsButtonText}>
                    Start navigation · {routeName(active)}
                  </Text>
                </View>
              </Pressable>
              <Text style={styles.gmapsHint}>
                Turn-by-turn voice directions along this exact route.
              </Text>

              <SectionTitle>About this route</SectionTitle>
              {warningCallouts}
              {whyThisRoute && (
                <Callout icon="lightbulb-outline" tone="info">
                  {whyThisRoute}
                </Callout>
              )}
              {darkCallout}
              <Card>
                <DetailsHeader
                  title={`${routeName(active)} route`}
                  meters={active.meters}
                  seconds={active.seconds}
                  verb={travelMode === 'bike' ? 'ride' : 'walk'}
                  weather={weather}
                />
                {outOfArea ? (
                  <Text style={styles.cardBodyText}>
                    This route is outside San Jose city limits. The city has no
                    crash records there, so this app can't rate it.
                  </Text>
                ) : (
                  <>
                    <FactRow
                      icon="traffic"
                      label="High-risk zones"
                      value={busyRoadsValue(active)}
                      tone={active.corridorMeters > 0 ? 'warn' : 'good'}
                    />
                    <FactRow
                      icon="report-problem"
                      label={`Past ${CRASH_NOUN[travelMode]} crashes`}
                      value={crashesValue(active)}
                      tone={crashDataFailed ? 'neutral' : active.crashCount ? 'warn' : 'good'}
                      last={!active.crossingsChecked}
                    />
                    {active.crossingsChecked && (
                      <FactRow
                        icon="directions-walk"
                        label="Busy-road crossings"
                        value={
                          active.unsafeCrossings.length === 0
                            ? 'All at crosswalks'
                            : `${active.unsafeCrossings.length} without a crosswalk`
                        }
                        tone={active.unsafeCrossings.length ? 'warn' : 'good'}
                        last
                      />
                    )}
                  </>
                )}
              </Card>
            </>
          )}

          {travelMode === 'drive' && driveResult && (
            <>
              <SectionTitle>Your drive</SectionTitle>
              {warningCallouts}
              {darkCallout}
              <Card>
                <DetailsHeader
                  title="Default driving route"
                  meters={driveResult.meters}
                  seconds={driveResult.seconds}
                  verb="drive"
                  weather={weather}
                />
                <FactRow
                  icon="traffic"
                  label="High-risk zones"
                  value={busyRoadsValue(driveResult)}
                  tone={driveResult.corridorMeters > 0 ? 'warn' : 'good'}
                />
                <FactRow
                  icon="report-problem"
                  label="Past car crashes"
                  value={crashesValue(driveResult)}
                  tone={crashDataFailed ? 'neutral' : driveResult.crashCount ? 'warn' : 'good'}
                  last
                />
              </Card>
              <Pressable
                style={({ pressed }) => [styles.gmapsButton, pressed && styles.modeButtonPressed]}
                accessibilityRole="button"
                onPress={() => openInGoogleMaps(driveResult, 'driving')}
              >
                <Text style={styles.gmapsButtonText}>Open in Google Maps</Text>
              </Pressable>
              <Text style={styles.gmapsHint}>
                Opens Google's own default driving route for turn-by-turn
                navigation.
              </Text>
            </>
          )}

          <SectionTitle>Map key</SectionTitle>
          <MapKey
            crashNoun={CRASH_NOUN[travelMode]}
            showCrossings={travelMode === 'walk'}
            note={
              'Crash dots appear when you zoom in; tap one for details. ' +
              (mapCrashes.length >= MAP_CRASH_LIMIT
                ? `Only the ${MAP_CRASH_LIMIT} most recent in view are shown, so zoom in further to see all. `
                : '') +
              'Crashes from the last five years and high-risk zones (Vision Zero safety corridors): City of San Jose. ' +
              (travelMode === 'walk' ? 'Crosswalks: OpenStreetMap.' : '')
            }
          />
        </View>
      </ScrollView>
      <StatusBar style="auto" />
    </View>
  );
}

// The status bar is translucent, so inset the top of the screen by hand.
const TOP_INSET = Platform.OS === 'ios' ? 60 : (RNStatusBar.currentHeight ?? 24) + 12;
// Room for the iPhone home indicator under bottom-pinned controls.
const BOTTOM_INSET = Platform.OS === 'ios' ? 34 : 16;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  searchBar: {
    paddingTop: TOP_INSET + 4,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  greeting: {
    flex: 1,
    fontSize: 26,
    lineHeight: 32,
    color: '#1C1C1E',
    fontFamily: HEADING_FONT,
    letterSpacing: -0.4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  logoBadge: {
    width: 40,
    height: 40,
    borderRadius: 11,
    backgroundColor: '#1A73F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  greetingCity: {
    color: '#1A73F0',
  },
  headerDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#D1D1D6',
    marginTop: 18,
    marginBottom: 4,
  },
  tagline: {
    marginTop: 12,
    fontSize: 15,
    lineHeight: 22,
    color: '#6C6C70',
    fontFamily: FONT.regular,
  },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#D1D1D6',
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 10,
  },
  // A thin line between tabs.
  tabButtonDivided: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: '#E5E5EA',
  },
  tabButtonText: {
    marginTop: 3,
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
    marginTop: 10,
    alignSelf: 'stretch',
    marginHorizontal: 12,
    height: 3,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
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
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
    fontFamily: FONT.regular,
    backgroundColor: '#F2F2F7',
    color: '#000',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  addressSection: {
    paddingHorizontal: 16,
    marginTop: 12,
  },
  modeButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: '#8E8E93',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeButtonActive: {
    backgroundColor: '#1E8E3E',
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
  findingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  findingText: {
    fontSize: 14,
    fontFamily: FONT.regular,
    color: '#636366',
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
  xingMarker: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: MAP_COLORS.noCrosswalk,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  results: {
    paddingHorizontal: 16,
  },
  cardBodyText: {
    fontSize: 14,
    lineHeight: 20,
    color: '#3A3A3C',
    fontFamily: FONT.regular,
  },
  scrollBody: {
    paddingBottom: 32,
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
  // The crash whose details are showing: larger, with a blue ring no crash
  // color uses.
  crashDotPicked: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 4,
    borderColor: MAP_COLORS.crashPicked,
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
  safetyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  gmapsButton: {
    marginTop: 14,
    minHeight: 52,
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
    marginTop: 6,
    textAlign: 'center',
    fontSize: 12,
    fontFamily: FONT.regular,
    color: '#8E8E93',
  },
  startButton: {
    backgroundColor: '#1E8E3E',
  },
  navScreen: {
    flex: 1,
  },
  navBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingTop: TOP_INSET,
    paddingBottom: 18,
    paddingHorizontal: 20,
    backgroundColor: '#0B6E4F',
  },
  navBannerOff: {
    backgroundColor: '#C93400',
  },
  navBannerArrived: {
    backgroundColor: '#007AFF',
  },
  navBannerText: {
    flex: 1,
  },
  navHeadline: {
    color: '#fff',
    fontSize: 30,
    lineHeight: 36,
    fontFamily: FONT.bold,
  },
  navDetail: {
    color: '#fff',
    fontSize: 18,
    lineHeight: 24,
    fontFamily: FONT.semibold,
  },
  navBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  navControlsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  navMapButtons: {
    gap: 10,
  },
  navMapButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  // North up is on.
  navMapButtonOn: {
    borderWidth: 2,
    borderColor: '#007AFF',
  },
  navMapButtonText: {
    fontSize: 15,
    color: '#1C1C1E',
    fontFamily: FONT.bold,
  },
  compassN: {
    fontSize: 9,
    lineHeight: 10,
    color: '#FF3B30',
    fontFamily: FONT.bold,
  },
  navRecenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  navRecenterText: {
    color: '#007AFF',
    fontSize: 15,
    fontFamily: FONT.semibold,
  },
  navFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 16,
    paddingBottom: BOTTOM_INSET,
    paddingHorizontal: 20,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 6,
  },
  navFooterText: {
    flex: 1,
  },
  navEta: {
    fontSize: 24,
    lineHeight: 30,
    color: '#0B6E4F',
    fontFamily: FONT.bold,
  },
  navEtaSub: {
    fontSize: 14,
    color: '#636366',
    fontFamily: FONT.regular,
  },
  navIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F2F2F7',
  },
  navEndButton: {
    minHeight: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FF3B30',
  },
  navDoneButton: {
    backgroundColor: '#007AFF',
  },
  navEndText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: FONT.bold,
  },
});

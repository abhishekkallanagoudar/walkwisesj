import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { MaterialIcons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
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
  // OSRM maneuver, e.g. type 'turn' + modifier 'left'; picks the arrow icon.
  type: string;
  modifier: string;
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
  highRisk: boolean; // fatal or severe; shown only as "High risk"
  // Who was involved: walking (pedestrian), bike (bike or scooter rider) or
  // drive (vehicles only). Each mode's routes are scored on its own crashes.
  mode: TravelMode;
  kind: string; // e.g. "Car and pedestrian"
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
  segOnCorridor: boolean[]; // per route segment, whether it runs along a corridor
  crashCount: number;
  highRiskCount: number;
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
  via: LatLng[] = [],
): Promise<Route[]> {
  const coords = [from, ...via, to].map((p) => `${p.longitude},${p.latitude}`).join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    // OSRM only offers alternatives between two points.
    alternatives: alternatives && !via.length ? 'true' : 'false',
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

// Narratives end with the outcome ("... pedestrian with fatality", "with
// serious injuries"). The app only shows a risk level, so drop that part.
function stripOutcome(narrative: string): string {
  return narrative.replace(/\s+with\s+(fatalit|serious injur)[\s\S]*$/i, '').trim();
}

async function fetchCrashes(
  box: BBox,
  mode: TravelMode,
  limit = 2000,
  signal?: AbortSignal,
): Promise<Crash[]> {
  const res = await fetch(crashesUrl(box, limit, mode), { signal });
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
      narrative: stripOutcome(p.NARRATIVE ?? ''),
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
// None at all means the area is outside San José's data, not that it's safe.
async function hasAnyCrashes(box: BBox): Promise<boolean> {
  const res = await fetch(
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
      '/MapServer/553/query?where=' +
      encodeURIComponent(CRASH_WHERE) +
      `&geometry=${box.join(',')}` +
      '&geometryType=esriGeometryEnvelope&inSR=4326&returnCountOnly=true&f=json',
  );
  const json = await res.json();
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
  const segOnCorridor: boolean[] = [];
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
    segOnCorridor.push(near);
  }

  const corridorRatio = total > 0 ? onCorridor / total : 0;
  const crashes = crashesNearRoute(route.points, allCrashes);
  const km = total / 1000;
  const crashCount = crashes.length;
  const highRiskCount = crashes.filter((c) => c.highRisk).length;
  const crashWeight = crashes.reduce((sum, c) => sum + c.weight, 0);
  const weightedPerKm = km > 0 ? crashWeight / km : 0;

  // Amber on any injury history along the route; red where injuries are frequent
  // (severity-weighted) or anyone was killed or severely hurt.
  const high =
    corridorRatio >= 0.25 || weightedPerKm >= 8 || highRiskCount >= 1;
  const medium =
    corridorRatio >= 0.05 || weightedPerKm >= 3 || crashCount >= 3;
  const level: SafetyLevel = high ? 'high' : medium ? 'medium' : 'low';

  // Corridor exposure dominates the ranking; the weighted crash rate and any KSI
  // only separate routes whose corridor use is close.
  const riskScore =
    corridorRatio * 10000 + weightedPerKm * 5 + highRiskCount * 25;

  return {
    ...route,
    crashes,
    corridorMeters: onCorridor,
    corridorRatio,
    segOnCorridor,
    crashCount,
    highRiskCount,
    weightedPerKm,
    level,
    riskScore,
    rank: 0,
  };
}

// A route only counts as genuinely clear if it neither touches a safety
// corridor nor has a nearby high-risk crash — the two things that actually
// draw alarming amber lines / red dots on the map.
function isRouteClear(r: ScoredRoute): boolean {
  return r.corridorMeters === 0 && r.highRiskCount === 0;
}

// Show at most this many alternatives, one per label, so no two match.
const MAX_ROUTES = 3;

// Safest first. A genuinely clear route (no corridor, no high-risk crash
// nearby) always beats one that merely scores lower on the weighted risk
// formula; equal risk goes to the quicker route, so the order is never a tie.
function compareSafety(a: ScoredRoute, b: ScoredRoute): number {
  const aClear = isRouteClear(a) ? 0 : 1;
  const bClear = isRouteClear(b) ? 0 : 1;
  if (aClear !== bClear) return aClear - bClear;
  return a.riskScore - b.riskScore || a.seconds - b.seconds;
}

// A route showing the same time and distance as a lower-risk one is never
// the better pick, so it's dropped.
function rankRoutes(pool: ScoredRoute[]): ScoredRoute[] {
  const shown: ScoredRoute[] = [];
  for (const r of [...pool].sort(compareSafety)) {
    const looksSame = shown.some(
      (s) =>
        formatDuration(s.seconds) === formatDuration(r.seconds) &&
        formatDistance(s.meters) === formatDistance(r.meters),
    );
    if (!looksSame && shown.length < MAX_ROUTES) shown.push(r);
  }
  shown.forEach((r, i) => {
    r.rank = i;
  });
  return shown;
}

// --- Safer detours ---
// OSRM can't be told to avoid places. To steer around a danger spot, ask for
// a route through a point off to its side (usually a parallel street), and
// keep the result if it scores safer.

// How far to the side of a danger spot to aim a detour.
const DETOUR_OFFSET_M: Record<'walk' | 'bike', number> = { walk: 250, bike: 400 };
// A detour may take at most 60% longer than the quickest route, and never
// more than 15 extra minutes.
const DETOUR_MAX_RATIO = 1.6;
const DETOUR_MAX_EXTRA_S = 15 * 60;
// Each round tries both sides of the worst spots on the current safest route;
// if a round finds nothing safer, the next aims twice as far out.
const DETOUR_ROUNDS = 2;
const DETOUR_SPOTS = 2;
// Danger spots closer together than this are treated as one.
const SPOT_MERGE_M = 150;

type DangerSpot = { at: LatLng; weight: number; seg: number };

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

// Where a route meets danger: medium- and high-risk crashes beside it, and
// each stretch along a safety corridor (100 m counts like one severe crash).
// Nearby spots are merged; heaviest first.
function dangerSpots(r: ScoredRoute): DangerSpot[] {
  const pts = r.points;
  const raw: DangerSpot[] = [];
  for (const c of r.crashes) {
    if (c.weight >= 2) raw.push({ at: c.at, weight: c.weight, seg: nearestSeg(c.at, pts) });
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

// The level a route is labeled and colored with. Alternatives are ranked
// against each other so each gets a different label: of three, the safest is
// Low risk, the next Medium risk, the last High risk. Of two, the second is
// High risk only if it's risky on its own, otherwise Medium risk. A lone
// route just uses its own level.
function routeLevel(r: ScoredRoute, total: number): SafetyLevel {
  if (total < 2) return r.level;
  if (r.rank === 0) return 'low';
  if (total === 2) return r.level === 'high' ? 'high' : 'medium';
  return r.rank >= total - 1 ? 'high' : 'medium';
}

function routeName(r: ScoredRoute, total: number): string {
  const level = routeLevel(r, total);
  return level === 'low' ? 'Low risk' : level === 'medium' ? 'Medium risk' : 'High risk';
}

// Low risk (green) -> medium risk (yellow) -> high risk (red).
function safetyColor(level: SafetyLevel): string {
  return level === 'low' ? '#34C759' : level === 'medium' ? '#FFCC00' : '#FF3B30';
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

// Severity is only ever shown as a risk level: high (fatal or severe) red,
// medium (moderate) orange, low (minor) green.
function crashRisk(c: Crash): 'High' | 'Medium' | 'Low' {
  return c.highRisk ? 'High' : c.severity === 'moderate' ? 'Medium' : 'Low';
}

function crashColor(c: Crash): string {
  const risk = crashRisk(c);
  return risk === 'High' ? '#FF3B30' : risk === 'Medium' ? '#FF9500' : '#34C759';
}

// e.g. "High risk · Car and pedestrian"
function crashTitle(c: Crash): string {
  return `${crashRisk(c)} risk · ${c.kind}`;
}

// What to call a mode's crashes in route summaries.
const CRASH_NOUN: Record<TravelMode, string> = {
  walk: 'pedestrian',
  bike: 'bike',
  drive: 'car',
};

function crashCountText(n: number, mode: TravelMode): string {
  return `${n} ${CRASH_NOUN[mode]} crash${n === 1 ? '' : 'es'}`;
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

// "300 ft" reads aloud as "300 feet"; same for miles.
function spokenDistance(m: number): string {
  return formatDistance(m).replace(' ft', ' feet').replace(' mi', ' miles');
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
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

  function followCamera(p: LatLng) {
    mapRef.current?.animateCamera(
      {
        center: p,
        heading: heading.current,
        pitch: 45,
        zoom: profile.zoom, // Google Maps (Android)
        altitude: profile.altitude, // Apple Maps (iOS)
      },
      { duration: 800 },
    );
  }

  useEffect(() => {
    if (pos && following) followCamera(pos);
  }, [pos, following]);

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
          pitch: 45,
          zoom: profile.zoom,
          altitude: profile.altitude,
        }}
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        onPanDrag={() => setFollowing(false)}
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
        {!following && (
          <Pressable
            style={styles.navRecenter}
            onPress={() => {
              setFollowing(true);
              if (pos) followCamera(pos);
            }}
          >
            <MaterialIcons name="navigation" size={18} color="#007AFF" />
            <Text style={styles.navRecenterText}>Re-center</Text>
          </Pressable>
        )}
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
            onPress={onEnd}
          >
            <Text style={styles.navEndText}>{arrived ? 'Done' : 'End'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

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

  // The address box sits below the map, where the keyboard would cover it.
  // While it's focused, the page scrolls it up to the top of the screen, and
  // bottom padding the height of the keyboard gives the page room to scroll.
  const scrollRef = useRef<ScrollView>(null);
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
      try {
        allCrashes = await fetchCrashes(crashBox, travelMode);
        if (!allCrashes.length) inCityData = await hasAnyCrashes(crashBox);
      } catch {
        allCrashes = [];
      }
      if (cancelled) return;

      const score = (r: Route) => scoreRoute(r, corridors, allCrashes);
      const pool = routes.map(score);
      const outside =
        corridors.length > 0 && !inCityData && pool.every((r) => r.corridorMeters === 0);

      // Try routes through points beside the worst spots on the current safest
      // route, keeping any that aren't too slow, don't double back, and aren't
      // repeats. A second round works on whatever is safest after the first.
      if (!outside) {
        const origin = routes[0].points[0];
        const dest = routes[0].points[routes[0].points.length - 1];
        const fastest = Math.min(...routes.map((r) => r.seconds));
        const maxSeconds = Math.min(fastest * DETOUR_MAX_RATIO, fastest + DETOUR_MAX_EXTRA_S);
        let reach = offsetM;
        for (let round = 0; round < DETOUR_ROUNDS; round++) {
          const best = rankRoutes(pool)[0];
          const vias = dangerSpots(best)
            .slice(0, DETOUR_SPOTS)
            .flatMap((spot) => sidePoints(spot, best.points, reach));
          if (!vias.length) break;
          const found = await Promise.all(
            vias.map((v) =>
              fetchRoutes(origin, dest, GOOGLE_MODE[travelMode], false, [v])
                .then((rs) => rs[0] ?? null)
                .catch(() => null),
            ),
          );
          if (cancelled) return;
          for (const r of found) {
            if (!r || r.seconds > maxSeconds || hasBacktrack(r.points)) continue;
            if (pool.some((p) => sameRoute(p, r))) continue;
            pool.push(score(r));
          }
          if (rankRoutes(pool)[0] === best) reach *= 2;
        }
      }

      setScored(rankRoutes(pool));
      setActiveIdx(0);
      setOutOfArea(outside);
      setFindingSafer(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [routes, corridors, travelMode]);

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
      // Drive is scored on vehicle-only crashes (car and car, car and object).
      let carCrashes: Crash[] = [];
      try {
        carCrashes = await fetchCrashes(padBBox(bboxOf(found[0].points), 0.003), 'drive');
      } catch {
        carCrashes = [];
      }
      setDriveResult(scoreRoute(found[0], corridors, carCrashes));
    } catch {
      Alert.alert('Something went wrong checking the route.');
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
  const shownRoute: Route | null = ranksRoutes ? active : driveResult;
  const findRoute = () => (ranksRoutes ? handleRoute() : handleDriveCheck());
  const currentTab = TRAVEL_TABS.find((t) => t.mode === travelMode)!;
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
                      strokeColor={altColor(routeLevel(r, scored.length))}
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
              placeholder="enter address here"
              placeholderTextColor="#8E8E93"
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
          {findingSafer && (
            <View style={styles.findingRow}>
              <ActivityIndicator />
              <Text style={styles.findingText}>Looking for lower-risk streets…</Text>
            </View>
          )}
        </View>

        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#FF3B30' }]} />
            <Text style={styles.legendText}>High risk</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#FF9500' }]} />
            <Text style={styles.legendText}>Medium risk</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.safetyDot, { backgroundColor: '#34C759' }]} />
            <Text style={styles.legendText}>Low risk</Text>
          </View>
        </View>
        <Text style={styles.legendNote}>
          {mapCrashes.length >= MAP_CRASH_LIMIT
            ? `Showing the ${MAP_CRASH_LIMIT} most recent crashes in view. Zoom in to see more. `
            : ''}
          Showing {CRASH_NOUN[travelMode]} crashes only. Tap a dot for details. City
          of San José crash data, last five years.
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
                        { backgroundColor: safetyColor(routeLevel(r, scored.length)) },
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
                      ? ` · ${crashCountText(r.crashCount, travelMode)} nearby${
                          r.highRiskCount ? ` (${r.highRiskCount} high risk)` : ''
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
                styles.startButton,
                pressed && styles.modeButtonPressed,
              ]}
              onPress={() => setNavigating(true)}
            >
              <View style={styles.modeButtonContent}>
                <MaterialIcons name="navigation" size={22} color="#fff" />
                <Text style={styles.gmapsButtonText}>Start navigation</Text>
              </View>
            </Pressable>
            <Text style={styles.gmapsHint}>
              Turn-by-turn voice directions along this exact route.
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
                        { backgroundColor: safetyColor(routeLevel(active, scored.length)) },
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
                      ? `No reported ${CRASH_NOUN[travelMode]} crashes along this route`
                      : `${crashCountText(active.crashCount, travelMode)} within ${formatDistance(
                          NEAR_CRASH_M,
                        )}` +
                        (active.highRiskCount > 0
                          ? `, ${active.highRiskCount} high risk`
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
              <Text style={styles.safetyText}>
                {driveResult.crashCount === 0
                  ? 'No reported car crashes along this route'
                  : `${crashCountText(driveResult.crashCount, 'drive')} within ${formatDistance(
                      NEAR_CRASH_M,
                    )}` +
                    (driveResult.highRiskCount > 0
                      ? `, ${driveResult.highRiskCount} high risk`
                      : '')}
              </Text>
              <Text style={styles.safetyMuted}>
                City of San José Vision Zero and crash data.
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
// Room for the iPhone home indicator under bottom-pinned controls.
const BOTTOM_INSET = Platform.OS === 'ios' ? 34 : 16;

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
    marginTop: 12,
  },
  addressSection: {
    paddingHorizontal: 16,
    marginTop: 12,
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
  startButton: {
    backgroundColor: '#007AFF',
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
  navRecenter: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: 16,
    marginBottom: 12,
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
    height: 44,
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

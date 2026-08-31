import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';

type LatLng = { latitude: number; longitude: number };

type TravelMode = 'foot' | 'bike';

type Suggestion = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
};

type Route = {
  points: LatLng[];
  meters: number;
  seconds: number;
  mode: TravelMode;
};

type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

type Corridor = {
  name: string;
  points: LatLng[];
  bbox: BBox;
};

type Crash = {
  at: LatLng;
  fatal: boolean;
};

type SafetyLevel = 'low' | 'medium' | 'high';

// A route plus its safety assessment against the San José datasets.
type ScoredRoute = Route & {
  crashes: Crash[];
  corridorMeters: number;
  corridorRatio: number;
  crashCount: number;
  fatalCount: number;
  crashesPerKm: number;
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

async function queryPhoton(
  query: string,
  bias: { lat: number; lon: number } | null,
  signal?: AbortSignal,
): Promise<Suggestion[]> {
  const params = new URLSearchParams({ q: query, limit: '5', lang: 'en' });
  if (bias) {
    params.set('lat', String(bias.lat));
    params.set('lon', String(bias.lon));
    // Pull ranking strongly toward the user's location.
    params.set('location_bias_scale', '0.6');
    params.set('zoom', '12');
  }
  const res = await fetch(`${PHOTON_URL}?${params.toString()}`, { signal });
  const json = await res.json();
  return (json.features ?? []).map((f: any, i: number) => ({
    id: `${f.properties.osm_type ?? 'x'}${f.properties.osm_id ?? i}`,
    label: formatAddress(f.properties),
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
  }));
}

// FOSSGIS runs free, no-key OSRM servers, one per travel profile.
const OSRM_BASE: Record<TravelMode, string> = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike',
};

// Ask OSRM for up to three distinct routes so we can rank them for safety.
async function fetchRoutes(
  from: LatLng,
  to: LatLng,
  mode: TravelMode,
): Promise<Route[]> {
  const coordPair =
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const res = await fetch(
    `${OSRM_BASE[mode]}/${coordPair}?alternatives=3&overview=full&geometries=geojson`,
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
    mode,
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

// "Crash Locations Last Five Years", filtered to killed-or-severely-injured.
// This is the raw data a High Injury Network is built from; San José does not
// publish the derived network itself.
function ksiCrashesUrl(box: BBox): string {
  const geometry = box.join(',');
  return (
    'https://geo.sanjoseca.gov/server/rest/services/OPN/OPN_OpenDataService' +
    '/MapServer/553/query?where=' +
    encodeURIComponent('KSIINJURIES>0') +
    `&geometry=${geometry}` +
    '&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326' +
    '&outFields=FATALINJURIES&returnGeometry=true&f=geojson'
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

async function fetchKsiCrashes(box: BBox): Promise<Crash[]> {
  const res = await fetch(ksiCrashesUrl(box));
  const json = await res.json();
  const out: Crash[] = [];
  for (const f of json.features ?? []) {
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    out.push({
      at: { latitude: c[1], longitude: c[0] },
      fatal: Number(f.properties?.FATALINJURIES ?? 0) > 0,
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

// Rate one route: metres on priority safety corridors, plus the killed/severely
// -injured crashes (the High Injury Network) alongside it. Lower riskScore = safer.
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
  const fatalCount = crashes.filter((c) => c.fatal).length;
  const crashesPerKm = km > 0 ? crashCount / km : 0;

  const high = corridorRatio >= 0.25 || crashesPerKm >= 6 || fatalCount >= 1;
  const medium = corridorRatio >= 0.05 || crashesPerKm >= 2 || crashCount >= 1;
  const level: SafetyLevel = high ? 'high' : medium ? 'medium' : 'low';

  // Corridor exposure dominates the ranking (scaled way up); crashes and any
  // fatality only decide between routes whose corridor use is nearly equal.
  const riskScore =
    corridorRatio * 10000 + crashesPerKm * 5 + fatalCount * 25;

  return {
    ...route,
    crashes,
    corridorMeters: onCorridor,
    corridorRatio,
    crashCount,
    fatalCount,
    crashesPerKm,
    level,
    riskScore,
    rank: 0,
  };
}

// Calm (green) -> moderate (amber) -> busy (soft coral, deliberately not a
// harsh red so the app stays reassuring for everyday pedestrians).
function safetyColor(level: SafetyLevel): string {
  return level === 'low' ? '#34C759' : level === 'medium' ? '#FF9F0A' : '#FF7043';
}

// Translucent variant for the un-selected alternative routes.
function altColor(level: SafetyLevel): string {
  return level === 'low'
    ? 'rgba(52,199,89,0.75)'
    : level === 'medium'
      ? 'rgba(255,159,10,0.75)'
      : 'rgba(255,112,67,0.8)';
}

export default function App() {
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [scored, setScored] = useState<ScoredRoute[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [outOfArea, setOutOfArea] = useState(false);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  // Device location, used to bias results toward what's nearby.
  const coords = useRef<{ lat: number; lon: number } | null>(null);
  const mapRef = useRef<MapView>(null);
  // Skip the lookup that would otherwise fire right after we set the text ourselves.
  const skipNextLookup = useRef(false);

  const active = scored[activeIdx] ?? null;

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

  // Whether the alternatives differ enough in risk to bother labelling one "safest".
  const routesDiffer = useMemo(() => {
    if (scored.length < 2) return false;
    const scores = scored.map((r) => r.riskScore);
    // ~1.5 percentage points of corridor difference, or a big crash gap.
    return Math.max(...scores) - Math.min(...scores) > 150;
  }, [scored]);

  // Ask for location once on mount so nearby results can be prioritized.
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      try {
        const pos = await Location.getLastKnownPositionAsync();
        const use = pos ?? (await Location.getCurrentPositionAsync({}));
        coords.current = {
          lat: use.coords.latitude,
          lon: use.coords.longitude,
        };
      } catch {
        // No location available; searches just fall back to global ranking.
      }
    })();
  }, []);

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
        setSuggestions(
          await queryPhoton(query, coords.current, controller.signal),
        );
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
  }, [address]);

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

  // Fit the map to all alternatives whenever a new set loads.
  useEffect(() => {
    if (scored.length && mapRef.current) {
      mapRef.current.fitToCoordinates(
        scored.flatMap((r) => r.points),
        {
          edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
          animated: true,
        },
      );
    }
  }, [scored]);

  // Score every alternative against the safety corridors and the KSI crash
  // history (the High Injury Network), then pick the safest as active.
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
        allCrashes = await fetchKsiCrashes(padBBox(allBox, 0.003));
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

  // Resolve the address if needed, then show the route for the chosen mode.
  async function handleRoute(mode: TravelMode) {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    if (!coords.current) {
      Alert.alert('Enable location access to get directions.');
      return;
    }

    let dest = selected;
    setLoading(true);
    try {
      if (!dest) {
        const results = await queryPhoton(query, coords.current);
        dest = results[0] ?? null;
        if (dest) handleSelect(dest);
      }
      if (!dest) {
        Alert.alert('No matching address found.');
        return;
      }
      setSuggestions([]);
      const origin = {
        latitude: coords.current.lat,
        longitude: coords.current.lon,
      };
      const found = await fetchRoutes(
        origin,
        { latitude: dest.latitude, longitude: dest.longitude },
        mode,
      );
      if (!found.length) {
        const label = mode === 'foot' ? 'walking' : 'biking';
        Alert.alert(`Could not find a ${label} route to that address.`);
        return;
      }
      setRoutes(found);
    } catch {
      Alert.alert('Something went wrong loading directions.');
    } finally {
      setLoading(false);
    }
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
              setAddress(text);
            }}
            placeholder="enter address here"
            placeholderTextColor="#8E8E93"
            autoCorrect={false}
            autoCapitalize="words"
            returnKeyType="search"
            clearButtonMode="while-editing"
            selectTextOnFocus
            onSubmitEditing={() => handleRoute('foot')}
          />
        </View>

        <View style={styles.modeRow}>
          <Pressable
            style={({ pressed }) => [
              styles.modeButton,
              routes[0]?.mode === 'foot' && styles.modeButtonActive,
              pressed && styles.modeButtonPressed,
            ]}
            onPress={() => handleRoute('foot')}
          >
            <Text style={styles.modeButtonText}>Walk</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.modeButton,
              routes[0]?.mode === 'bike' && styles.modeButtonActive,
              pressed && styles.modeButtonPressed,
            ]}
            onPress={() => handleRoute('bike')}
          >
            <Text style={styles.modeButtonText}>Bike</Text>
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

        {scored.length > 1 && (
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
                      { backgroundColor: safetyColor(r.level) },
                    ]}
                  />
                  <Text style={styles.routeChipText}>
                    {routesDiffer && r.rank === 0
                      ? 'Calmest'
                      : routesDiffer && r.rank === scored.length - 1
                        ? 'Busier streets'
                        : `Route ${i + 1}`}{' '}
                    · {formatDuration(r.seconds)}
                  </Text>
                </View>
                <Text style={styles.routeChipSub}>
                  {Math.round(r.corridorRatio * 100)}% on busy main roads
                  {r.crashCount
                    ? ` · ${r.crashCount} extra-care spot${
                        r.crashCount === 1 ? '' : 's'
                      }`
                    : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {active && (
          <View style={styles.mapCard}>
            <MapView
              ref={mapRef}
              style={styles.map}
              initialRegion={{
                latitude: active.points[0].latitude,
                longitude: active.points[0].longitude,
                latitudeDelta: 0.05,
                longitudeDelta: 0.05,
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
              {active.crashes.map((c, i) => (
                <Circle
                  key={`crash-${i}`}
                  center={c.at}
                  radius={c.fatal ? 22 : 15}
                  strokeColor="rgba(0,0,0,0)"
                  fillColor={
                    c.fatal ? 'rgba(255,120,90,0.85)' : 'rgba(255,179,64,0.75)'
                  }
                />
              ))}
              {scored.map((r, i) =>
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
              <Polyline
                coordinates={active.points}
                strokeColor="#007AFF"
                strokeWidth={5}
              />
              <Marker
                coordinate={active.points[0]}
                title="Start"
                pinColor="#34C759"
              />
              <Marker
                coordinate={active.points[active.points.length - 1]}
                title={selected?.label ?? 'Destination'}
              />
            </MapView>
            <Text style={styles.routeMeta}>
              {formatDistance(active.meters)} · {formatDuration(active.seconds)}{' '}
              {active.mode === 'foot' ? 'walk' : 'bike ride'}
              {scored.length > 1 ? ` · route ${activeIdx + 1} of ${scored.length}` : ''}
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
                        { backgroundColor: safetyColor(active.level) },
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
                      ? 'No extra-care spots flagged along this route'
                      : `${active.crashCount} extra-care spot${
                          active.crashCount === 1 ? '' : 's'
                        } within ${NEAR_CRASH_M} m (City of San José data)`}
                  </Text>
                </>
              )}
              <Text style={styles.safetyMuted}>
                Blue = your route · dashed = other options · amber line = busy
                main road · dot = extra-care spot · City of San José data
              </Text>
            </View>
          </View>
        )}
      </View>
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
    fontWeight: '700',
    color: '#000',
    marginBottom: 12,
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
    marginTop: 8,
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
  modeButtonPressed: {
    opacity: 0.6,
  },
  modeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  routeChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
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
    fontSize: 13,
    color: '#000',
  },
  routeChipSub: {
    marginTop: 2,
    fontSize: 11,
    color: '#8E8E93',
  },
  mapCard: {
    marginTop: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#D1D1D6',
  },
  map: {
    width: '100%',
    height: 260,
  },
  routeMeta: {
    paddingHorizontal: 10,
    paddingTop: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
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
});

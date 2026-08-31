import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
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

type SafetyStats = {
  corridorMeters: number;
  ratio: number;
  crashCount: number;
  fatalCount: number;
  crashesPerKm: number;
  level: 'low' | 'medium' | 'high';
  outOfArea: boolean;
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

async function fetchRoute(
  from: LatLng,
  to: LatLng,
  mode: TravelMode,
): Promise<Route | null> {
  const coordPair =
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const res = await fetch(
    `${OSRM_BASE[mode]}/${coordPair}?overview=full&geometries=geojson`,
  );
  const json = await res.json();
  const r = json.routes?.[0];
  if (!r) return null;
  return {
    points: r.geometry.coordinates.map(([lon, lat]: [number, number]) => ({
      latitude: lat,
      longitude: lon,
    })),
    meters: r.distance,
    seconds: r.duration,
    mode,
  };
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

// How exposed the route is: time on priority safety corridors plus the number
// of killed/severely-injured crashes (the High Injury Network) alongside it.
function analyzeSafety(
  routePts: LatLng[],
  corridors: Corridor[],
  nearCrashes: Crash[],
): SafetyStats {
  let total = 0;
  let onCorridor = 0;
  for (let i = 0; i < routePts.length - 1; i++) {
    const a = routePts[i];
    const b = routePts[i + 1];
    const segLen = segMeters(a, b);
    total += segLen;
    const mid: LatLng = {
      latitude: (a.latitude + b.latitude) / 2,
      longitude: (a.longitude + b.longitude) / 2,
    };
    let near = false;
    for (const c of corridors) {
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
  const ratio = total > 0 ? onCorridor / total : 0;
  const km = total / 1000;
  const crashCount = nearCrashes.length;
  const fatalCount = nearCrashes.filter((c) => c.fatal).length;
  const crashesPerKm = km > 0 ? crashCount / km : 0;

  const high = ratio >= 0.25 || crashesPerKm >= 6 || fatalCount >= 1;
  const medium = ratio >= 0.05 || crashesPerKm >= 2 || crashCount >= 1;
  const level = high ? 'high' : medium ? 'medium' : 'low';

  return {
    corridorMeters: onCorridor,
    ratio,
    crashCount,
    fatalCount,
    crashesPerKm,
    level,
    outOfArea: false,
  };
}

function safetyColor(level: SafetyStats['level']): string {
  return level === 'low' ? '#34C759' : level === 'medium' ? '#FF9500' : '#FF3B30';
}

export default function App() {
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [nearbyCorridors, setNearbyCorridors] = useState<Corridor[]>([]);
  const [nearCrashes, setNearCrashes] = useState<Crash[]>([]);
  const [safety, setSafety] = useState<SafetyStats | null>(null);
  // Device location, used to bias results toward what's nearby.
  const coords = useRef<{ lat: number; lon: number } | null>(null);
  const mapRef = useRef<MapView>(null);
  // Skip the lookup that would otherwise fire right after we set the text ourselves.
  const skipNextLookup = useRef(false);

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

  // Fit the map to the whole route whenever a new one loads.
  useEffect(() => {
    if (route && mapRef.current) {
      mapRef.current.fitToCoordinates(route.points, {
        edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
        animated: true,
      });
    }
  }, [route]);

  // Score the current route against the safety corridors and the KSI crash
  // history (the High Injury Network), which is fetched for the route's area.
  useEffect(() => {
    if (!route) {
      setNearbyCorridors([]);
      setNearCrashes([]);
      setSafety(null);
      return;
    }

    const routeBox = bboxOf(route.points);
    const nearby = corridors.filter((c) =>
      bboxIntersect(c.bbox, routeBox, 0.003),
    );
    setNearbyCorridors(nearby);

    let cancelled = false;
    (async () => {
      let near: Crash[] = [];
      try {
        const all = await fetchKsiCrashes(padBBox(routeBox, 0.003));
        near = crashesNearRoute(route.points, all);
      } catch {
        near = [];
      }
      if (cancelled) return;
      setNearCrashes(near);
      if (!nearby.length && near.length === 0) {
        setSafety({
          corridorMeters: 0,
          ratio: 0,
          crashCount: 0,
          fatalCount: 0,
          crashesPerKm: 0,
          level: 'low',
          outOfArea: true,
        });
      } else {
        setSafety(analyzeSafety(route.points, nearby, near));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [route, corridors]);

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
      const found = await fetchRoute(
        origin,
        { latitude: dest.latitude, longitude: dest.longitude },
        mode,
      );
      if (!found) {
        const label = mode === 'foot' ? 'walking' : 'biking';
        Alert.alert(`Could not find a ${label} route to that address.`);
        return;
      }
      setRoute(found);
    } catch {
      Alert.alert('Something went wrong loading directions.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchBar}>
        <Text style={styles.greeting}>hello, Zeus!!</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={(text) => {
              setSelected(null);
              setRoute(null);
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
              route?.mode === 'foot' && styles.modeButtonActive,
              pressed && styles.modeButtonPressed,
            ]}
            onPress={() => handleRoute('foot')}
          >
            <Text style={styles.modeButtonText}>Walk</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.modeButton,
              route?.mode === 'bike' && styles.modeButtonActive,
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

        {selected && !route && (
          <Text style={styles.coords}>
            {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
          </Text>
        )}

        {route && (
          <View style={styles.mapCard}>
            <MapView
              ref={mapRef}
              style={styles.map}
              initialRegion={{
                latitude: route.points[0].latitude,
                longitude: route.points[0].longitude,
                latitudeDelta: 0.05,
                longitudeDelta: 0.05,
              }}
            >
              {nearbyCorridors.map((c, i) => (
                <Polyline
                  key={`corridor-${i}`}
                  coordinates={c.points}
                  strokeColor="rgba(255,59,48,0.55)"
                  strokeWidth={7}
                />
              ))}
              {nearCrashes.map((c, i) => (
                <Circle
                  key={`crash-${i}`}
                  center={c.at}
                  radius={c.fatal ? 28 : 16}
                  strokeColor="rgba(0,0,0,0)"
                  fillColor={
                    c.fatal ? 'rgba(255,45,85,0.9)' : 'rgba(255,149,0,0.75)'
                  }
                />
              ))}
              <Polyline
                coordinates={route.points}
                strokeColor="#007AFF"
                strokeWidth={4}
              />
              <Marker
                coordinate={route.points[0]}
                title="Start"
                pinColor="#34C759"
              />
              <Marker
                coordinate={route.points[route.points.length - 1]}
                title={selected?.label ?? 'Destination'}
              />
            </MapView>
            <Text style={styles.routeMeta}>
              {formatDistance(route.meters)} · {formatDuration(route.seconds)}{' '}
              {route.mode === 'foot' ? 'walk' : 'bike ride'}
            </Text>

            {safety && (
              <View style={styles.safetyBox}>
                {safety.outOfArea ? (
                  <Text style={styles.safetyMuted}>
                    No San José safety data along this route.
                  </Text>
                ) : (
                  <>
                    <View style={styles.safetyRow}>
                      <View
                        style={[
                          styles.safetyDot,
                          { backgroundColor: safetyColor(safety.level) },
                        ]}
                      />
                      <Text style={styles.safetyText}>
                        {safety.corridorMeters >= 30
                          ? `On priority safety corridors ${formatDistance(
                              safety.corridorMeters,
                            )} (${Math.round(safety.ratio * 100)}%)`
                          : 'Mostly avoids priority safety corridors'}
                      </Text>
                    </View>
                    <Text style={styles.safetyText}>
                      {safety.crashCount === 0
                        ? 'No severe/fatal crashes recorded alongside it'
                        : `${safety.crashCount} killed/severe-injury crash${
                            safety.crashCount === 1 ? '' : 'es'
                          } within ${NEAR_CRASH_M} m (last 5 yrs)${
                            safety.fatalCount
                              ? ` · ${safety.fatalCount} fatal`
                              : ''
                          }`}
                    </Text>
                  </>
                )}
                <Text style={styles.safetyMuted}>
                  Red line = priority safety corridor · dot = KSI crash · City of
                  San José Vision Zero
                </Text>
              </View>
            )}
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
    fontSize: 18,
    fontWeight: '600',
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

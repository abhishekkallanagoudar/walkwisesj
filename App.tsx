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
import MapView, { Marker, Polyline } from 'react-native-maps';

type LatLng = { latitude: number; longitude: number };

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

// FOSSGIS runs a free, no-key OSRM server with a pedestrian profile.
const OSRM_FOOT_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';

async function fetchWalkingRoute(from: LatLng, to: LatLng): Promise<Route | null> {
  const coordPair =
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const res = await fetch(
    `${OSRM_FOOT_URL}/${coordPair}?overview=full&geometries=geojson`,
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

export default function App() {
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
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

  // Fit the map to the whole route whenever a new one loads.
  useEffect(() => {
    if (route && mapRef.current) {
      mapRef.current.fitToCoordinates(route.points, {
        edgePadding: { top: 40, right: 40, bottom: 40, left: 40 },
        animated: true,
      });
    }
  }, [route]);

  // "Go": resolve the address if needed, then show the walking route to it.
  async function handleGo() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    if (!coords.current) {
      Alert.alert('Enable location access to get walking directions.');
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
      const walking = await fetchWalkingRoute(origin, {
        latitude: dest.latitude,
        longitude: dest.longitude,
      });
      if (!walking) {
        Alert.alert('Could not find a walking route to that address.');
        return;
      }
      setRoute(walking);
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
            onSubmitEditing={handleGo}
          />
          <Pressable
            style={({ pressed }) => [
              styles.goButton,
              pressed && styles.goButtonPressed,
            ]}
            onPress={handleGo}
          >
            <Text style={styles.goButtonText}>Go</Text>
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
              <Marker
                coordinate={route.points[0]}
                title="Start"
                pinColor="#34C759"
              />
              <Marker
                coordinate={route.points[route.points.length - 1]}
                title={selected?.label ?? 'Destination'}
              />
              <Polyline
                coordinates={route.points}
                strokeColor="#007AFF"
                strokeWidth={4}
              />
            </MapView>
            <Text style={styles.routeMeta}>
              {formatDistance(route.meters)} · {formatDuration(route.seconds)} walk
            </Text>
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
  goButton: {
    height: 44,
    marginLeft: 8,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  goButtonPressed: {
    opacity: 0.6,
  },
  goButtonText: {
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
    padding: 10,
    fontSize: 14,
    fontWeight: '600',
    color: '#000',
    backgroundColor: '#fff',
  },
});

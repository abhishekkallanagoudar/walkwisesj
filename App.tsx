import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

type Suggestion = {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
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

export default function App() {
  const [address, setAddress] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Suggestion | null>(null);
  // Device location, used to bias results toward what's nearby.
  const coords = useRef<{ lat: number; lon: number } | null>(null);
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

  function openWalkingDirections(dest: Suggestion) {
    const params = new URLSearchParams({
      api: '1',
      destination: `${dest.latitude},${dest.longitude}`,
      travelmode: 'walking',
    });
    if (coords.current) {
      params.set('origin', `${coords.current.lat},${coords.current.lon}`);
    }
    Linking.openURL(
      `https://www.google.com/maps/dir/?${params.toString()}`,
    ).catch(() => Alert.alert('Could not open a maps app for directions.'));
  }

  // "Go": resolve the address if needed, then open walking directions to it.
  async function handleGo() {
    Keyboard.dismiss();
    const query = address.trim();
    if (!query) return;

    let dest = selected;
    if (!dest) {
      setLoading(true);
      try {
        const results = await queryPhoton(query, coords.current);
        dest = results[0] ?? null;
        if (dest) handleSelect(dest);
      } catch {
        dest = null;
      } finally {
        setLoading(false);
      }
    }

    if (!dest) {
      Alert.alert('No matching address found.');
      return;
    }
    setSuggestions([]);
    openWalkingDirections(dest);
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

        {selected && (
          <Text style={styles.coords}>
            {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
          </Text>
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
    paddingTop: TOP_INSET,
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
});

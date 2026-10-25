# WalkWise SJ

Find the safest way to walk, bike or drive in San José, using the city's real
crash data and its Vision Zero high-injury streets.

Map apps pick the fastest route. WalkWise SJ also checks each route against
five years of San José injury crashes, the city's Vision Zero high-injury
street network and busy-road crossings without a crosswalk. Then it shows you
the safest option and what risk is left on it.

## Features

- **Safest route vs. fastest route.** Each trip shows a *Safest* (or *Safer
  alternative*) route next to the *Fastest* one, with the time, distance and
  safety stats for each.
- **Detours around danger.** The app tries reroutes around crash sites and
  high-injury streets, and through the nearest crosswalk wherever a route
  would cross a major road without one.
- **Safety stats on every route.** Shows how much of the route runs near past
  crash sites or on high-injury streets, and how many major-road crossings
  have no crosswalk.
- **Crash map.** Past crashes for your travel mode appear as dots colored by
  injury severity. Tap one to see what happened.
- **Turn-by-turn navigation.** Voice directions follow the exact route you
  picked.
- **Context.** Shows a weather and after-dark warning when it's dark and the
  route passes crashes that happened at night.
- **Drive check.** For driving, checks whether the default route uses
  high-injury streets, then hands off to Google Maps for navigation.

## How the safety scoring works

For each route the app measures:

| Measure | How |
|---|---|
| Near past crash sites | Share of the route within 40 m of an injury crash for your travel mode (pedestrian crashes for Walk, bike crashes for Bike) |
| High-injury streets | Share of the route within 25 m of a Vision Zero priority safety corridor |
| Crossings without a crosswalk | Places the route crosses a major road with no marked crosswalk or signal nearby (Walk only) |

Routes are ranked like this:

1. A route that avoids every hazard always wins.
2. Next, fewer crossings without a crosswalk always wins. Walking along a busy
   street's sidewalk is safer than crossing it mid-block.
3. After that, a weighted risk score decides. Crashes are weighted by severity
   (fatal 8, severe 4, moderate 2, minor 1).

The first and last 50 m of a trip don't count toward the shares, because
someone starting or ending on a busy street can't avoid it.

A detour can take at most twice as long as the fastest route, and at most 25
minutes longer, so the safest option stays one people would actually take.

## Data sources

All data is free and public, so no API keys are needed.

| Data | Source |
|---|---|
| Injury crashes, last five years | [City of San José Open Data](https://data.sanjoseca.gov/) (Crash Locations) |
| Vision Zero priority safety corridors | City of San José Open Data |
| City limits | City of San José Open Data |
| Major roads and crosswalks | [OpenStreetMap](https://www.openstreetmap.org/) contributors, bundled in `assets/crossings.json` |
| Walking, biking and driving routes | [OSRM](https://project-osrm.org/) public servers run by FOSSGIS |
| Address search | [Photon](https://photon.komoot.io/) (OpenStreetMap), with the phone's own geocoder as a fallback |
| Weather and daylight | [Open-Meteo](https://open-meteo.com/) |

The city only records crashes inside San José city limits, so county
expressways and neighboring cities have little or no crash data. The app
warns you when a route leaves the city.

## Built with

- [Expo](https://expo.dev/) and [React Native](https://reactnative.dev/)
- TypeScript
- `react-native-maps` for the map
- `expo-location` for GPS, `expo-speech` for voice directions

## Run it yourself

You need [Node.js](https://nodejs.org/) (version 20 or newer) and the
**Expo Go** app on your phone ([iOS](https://apps.apple.com/app/expo-go/id982107779) /
[Android](https://play.google.com/store/apps/details?id=host.exp.exponent)).

```bash
git clone https://github.com/abhishekkallanagoudar/walkwisesj.git
cd walkwisesj
npm install
npx expo start
```

Scan the QR code with your phone's camera (iOS) or the Expo Go app
(Android). Allow location access when asked, since your location is the
starting point for routes.

To check the code for type errors:

```bash
npm run typecheck
```

## Project structure

| File | What it does |
|---|---|
| `App.tsx` | The whole app: search, routing, safety scoring, map, route cards and navigation |
| `index.ts` | Entry point that starts `App.tsx` |
| `app.json` | App name, icons, permissions and build settings |
| `assets/crossings.json` | San José major roads and crosswalks from OpenStreetMap |
| `assets/*.png` | App icons |

## Limitations

- Routing uses a free, shared public server, which can be slow or briefly
  refuse requests when it's busy. If a search fails, wait a moment and try
  again.
- Crash and high-injury street data only covers San José city limits.
- A past crash near a route doesn't mean it's dangerous today, and a route
  with no recorded crashes isn't guaranteed safe. Always stay alert.

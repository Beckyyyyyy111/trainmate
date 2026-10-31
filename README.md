# PlatformPal — find the right door

Citymapper tells you *which train*. PlatformPal tells you *which door*: by voice, text or photo,
for people who need it most (prams, wheelchairs, luggage, low vision, rush hour).

Track 2 — Multimodal & Human-Centric AI.

## Run

```bash
cp .env.example .env.local   # then paste your Gemini API key into .env.local
npm install
npm run dev                  # http://localhost:5173
```

Without a key the 3D scene, menus and crowding model still work; voice, text understanding and photos need Gemini.
Model IDs are in `src/config.ts`.

## How it works

| Piece | File | Gemini? |
|---|---|---|
| Understand the trip from speech or text (station, destination, needs) | `src/gemini.ts` `parseRequest` | Audio/text → JSON |
| Locate the user on the platform from a photo or camera frame | `locateOnPlatform` | Vision → JSON |
| Rebuild a platform's 3D layout from a walk of photos | `rebuildPlatform` | Multi-image vision → JSON |
| Turn the plan into calm spoken directions (step counts for blind users) | `composeGuidance` | Text |
| Expressive speech output | `speak` | TTS |
| Estimated per-car crowding | `src/engine/crowding.ts` | — |
| Best car + landmark-based directions | `src/engine/recommend.ts` | — |
| Procedural 3D platform + live arriving train | `src/scene.ts` | — |

Crowding is **modelled**, not measured: time of day, where people walk onto the platform, emptier
end cars, and per-train randomness. Station landmark positions in `src/data/network.ts` are
**illustrative** and should be checked on site or rebuilt from photos.

## 3-minute demo script

1. Press **🎤 Speak**: "I'm at Liverpool Street going to Bond Street with a pram."
2. PlatformPal answers out loud and the 3D view highlights the spot; the car bars show the crowding.
3. **📷 Upload photo** of the platform → "You're by the roundel, walk 20 metres towards the front…" and the view drops to eye level.
4. Turn on **High contrast**, ask as a blind user ("I'm blind, at Bond Street, heading to Liverpool Street") → directions with step counts.
5. Drag **Simulated time** to 08:30 vs 14:00 to show crowding changing; press **Next train ⏭** to watch a train arrive.
6. Optional: **🧱 Rebuild platform from photos** with 4–8 photos taken along a platform.

Shortcut: **Ctrl+Space** toggles the microphone.

## Walk-to-the-train demo

Press **🚶 Walk to the train**. You start where you'd walk onto the platform (the lift for step-free
needs, otherwise a street exit or interchange) and get turn-by-turn guidance with spoken cues as you
pass landmarks. ↑/↓ walk, ←/→ turn, drag to look, Shift to hurry. At the green circle the next
train is brought in, the doors open, and stepping forward boards the train; it then leaves with you on it.

Handy URL parameters for rehearsing: `?line=metropolitan`, `?needs=pram`, `?view=walk`,
`?autowalk=1` (follows the guidance hands-free), `?train=here` (a train already in the platform).

## Data and credits

- Elizabeth line Class 345 dimensions, formation and interior layout: TfL *Class 345 Data Sheet ver 3* (FOI-0416-2223).
- Metropolitan line S8 Stock dimensions and formation: TfL *S Stock information sheet, July 2010* (FOI-0158-2021).
- 3D model: This work is based on ["Bombardier S Stock London Underground"](https://sketchfab.com/3d-models/bombardier-s-stock-london-underground-a6718eff2dc843c48fd54376b4c70b06) by [timblewee](https://sketchfab.com/timblewee), licensed under [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). Used for the Metropolitan line train (intermediate cars are derived from the driving car by hiding the cab and stretching to the data-sheet length).
- Individual passengers use the free rigged models from [Renderpeople](https://renderpeople.com/free-3d-people/) (Eric, Carla, Claudia), posed and baked at load time. **Local demo only:** Renderpeople's terms (4.3b) forbid making the model files easily downloadable by third parties, so `public/models/people/` is git-ignored and must not be deployed to a public site.
- Family groups use Innerscene's “Sam, Mina, Eli and Riley” model, adapted from MakeHuman/MPFB assets and released under CC0. The GLB and its licence notice are included in `public/models/`.
- Synthetic low-poly crowd figures are disabled. If the local Renderpeople files are unavailable, individual crowd members are omitted rather than replaced with geometric figures.


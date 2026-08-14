# Streamline.js — User Manual

**Version:** 0.1.95 · **Applies to:** Streamline.js web skin + Decaid middleware

> **Draft note.** This is a first English draft assembled from the shipping code. Screenshot/clip
> placeholders are marked `[VIDEO: …]` and map to the sections of the existing screen recording.

---

## Table of Contents

**Part I — Using Streamline.js**
1. [What Streamline.js is](#1-what-streamlinejs-is)
2. [Requirements and first run](#2-requirements-and-first-run)
3. [The main screen](#3-the-main-screen)
4. [Pulling a shot](#4-pulling-a-shot)
5. [Steam, hot water, and flush](#5-steam-hot-water-and-flush)
6. [Profiles](#6-profiles)
7. [Shot history](#7-shot-history)
8. [Settings](#8-settings)
9. [Troubleshooting](#9-troubleshooting)

**Part II — Using the middleware (Decaid)**
10. [What the middleware does](#10-what-the-middleware-does)
11. [Devices: scan, connect, forget](#11-devices-scan-connect-forget)
12. [Machine control over REST](#12-machine-control-over-rest)
13. [Live data over WebSocket](#13-live-data-over-websocket)
14. [Profiles and the workflow API](#14-profiles-and-the-workflow-api)
15. [Shots, beans, grinders](#15-shots-beans-grinders)
16. [The key–value store](#16-the-keyvalue-store)
17. [Plugins](#17-plugins)
18. [Skins and the web UI server](#18-skins-and-the-web-ui-server)
19. [Appendix](#19-appendix)

---

# Part I — Using Streamline.js

## 1. What Streamline.js is

Streamline.js is a browser-based control skin for the Decent Espresso DE1. It is a full rewrite of
the original TCL Streamline skin as a static web app — plain HTML, CSS and JavaScript, no framework
and no build step for the JavaScript.

It does **not** talk to the espresso machine directly. All Bluetooth work, profile storage, shot
logging and device management happen in a separate middleware process called
**[Decaid](https://github.com/decentespresso/decaid)**.
Streamline.js is the front end; Decaid is the engine.

> Decaid was previously called Streamline‑Bridge, and before that Rea Prime (repo `reaprime`). You
> will still see those names in older docs, in some API paths, and in a few settings labels.

```
┌────────────────┐    REST + WebSocket    ┌──────────────────┐   Bluetooth LE   ┌────────┐
│  Streamline.js │ ─────────────────────► │      Decaid      │ ───────────────► │  DE1   │
│  (browser)     │ ◄───────────────────── │  (:8080)         │ ◄─────────────── │  Scale │
└────────────────┘     live snapshots     └──────────────────┘                  └────────┘
```

Consequence worth remembering: **if the app looks dead, the middleware is usually the thing that is
down** — not the browser and not the machine.

Streamline.js is designed to be used inside the Decent app's web view on the tablet; running it in
an ordinary browser is fully supported but secondary. See §2 for what differs between the two.

---

## 2. Requirements and first run

### Prerequisites

| Item | Requirement |
|---|---|
| Middleware | [Decaid](https://github.com/decentespresso/decaid) running and reachable on port `8080` |
| Host | The Decent app's in‑app web view (primary). A desktop or tablet browser also works |
| Orientation | Landscape. Portrait devices get a "please rotate" prompt |
| Machine | Decent DE1 (GHC and non‑GHC both supported) |
| Scale | Optional but recommended (Decent Scale, Acaia, Felicita, and others Decaid supports) |

### Where Streamline.js runs

**The in‑app web view is the primary way to use Streamline.js.** On the tablet, Decaid hosts the
skin and the Decent app displays it in an embedded web view. That is the intended, supported,
day‑to‑day setup — it is what the app is tuned for, and it is where the machine actually lives.

**A normal browser is the secondary way.** Streamline.js is a static web app, so any modern browser
can load it — useful for development, for checking on the machine from a laptop or phone, and for
testing. Everything works, but treat it as the second path, not the reference one.

Every feature is built to work in both. Where the two differ, the manual says so.

#### What changes between the two

| | In‑app web view (primary) | Browser (secondary) |
|---|---|---|
| Fullscreen | The host OS owns the screen; the fullscreen button is hidden | Fullscreen button available, with a prompt on mobile |
| External links | The host cancels the in‑page load and opens the link in the OS browser | Opens normally |
| Exiting | An **Exit to Decent dashboard** button returns you to the host app | Not applicable |
| Chromium version | Older embedded Chromium — avoid relying on very new browser APIs | Whatever the browser ships |

Streamline.js detects the web view automatically (via the host's `window.__DECENT_HOST__` flag and
the user‑agent) and adapts — you do not configure this.

> **Note for developers:** because the web view is the primary target, it is the one to test
> against. Links must be plain same‑frame navigations — `target="_blank"` and `window.open()` do
> not work there.

### Running it in a browser

Streamline.js is served by Decaid itself (see §18), so on any machine on the network you can open
Decaid's address in a browser and get the same UI.

To serve it yourself for development, from the repository root:

```bash
python3 -m http.server
```

Then open `http://localhost:8000`.

### Pointing at a different host

By default the app talks to `localhost:8080`. If the middleware runs on another machine, set the
hostname once from the browser console before loading the app:

```js
localStorage.setItem('reaHostname', '192.168.1.50')
```

Reload the page afterwards. The port stays `8080`.

### First-run checklist

1. Start the middleware.
2. Open Streamline.js.
3. Go to **Settings → 2. Connections** and scan for your DE1. Connect it.
4. Scan for and connect your scale. Enable scale auto‑connect so it reconnects on its own.
5. Go back to the main screen. The machine status should show as connected and the water tank level
   should be live.
6. Pick a profile (§6), set your dose (§4), and pull a shot.

`[VIDEO: first-run — connecting machine and scale]`

---

## 3. The main screen

The main screen is a single dashboard; there is no navigation to get lost in. Everything below is on
one page.

### Top bar

| Element | What it does |
|---|---|
| **P / F / R** tabs | Switch the favourites strip between **P**rofile favourites, **F** auto‑favourites, and **R**ecipes |
| Favourite slots | Five quick‑access profile buttons. Tap to load that profile immediately |
| **Warmer** | Toggles the cup warmer (only shown if your machine reports the capability) |
| **DYE** | Opens *Describe Your Espresso* — bean/grinder/notes entry for the shot (only shown when enabled) |
| **Settings** | Opens the settings pages (§8) |
| **Sleep** | Puts the DE1 to sleep |
| Fullscreen | Toggles browser fullscreen. Hidden in the in‑app web view, where the host owns the screen |

In the in‑app web view there is also a floating **Exit to Decent dashboard** button. Drag it to
reposition it; long‑press it to hide it.

### Left column — shot settings

Each setting is a value with a **−** and **+** button. Two ways to change a value:

- **Tap** −/+ for one step.
- **Press and hold** −/+ to repeat quickly.
- **Tap the number itself** to open a numeric keypad. The keypad also shows values you used on
  previous shots, so you can jump back to a known-good dose or temperature.

Settings on the left column:

- **Grind** — your grinder setting. Recorded with the shot; it does not command the grinder.
- **Dose in** — dry coffee weight in grams.
- **Drink out** — target beverage weight in grams. Used for stop‑at‑weight when a scale is connected.
- **Temp** — brew (group) temperature in °C.
- **Steam** — steam setting. Tap the *label* to cycle what the number means (temperature / duration /
  flow).
- **Flush** — pre‑shot flush. Tap the label to switch between duration and flow.
- **Hot water** — tap the label to switch between volume, temperature, duration and flow.

The "tap the label to change what you are editing" pattern is used consistently for Steam, Flush and
Hot Water. If a number looks wrong, check which mode the label is in.

### Centre — the live chart

A Plotly chart drawing, in real time:

- **Pressure** (bar)
- **Flow** (ml/s)
- **Group temperature** — actual as a solid line, target as a dashed line
- **Weight / weight flow** when a scale is connected
- Phase markers where the profile steps over

Tap the expand icon to blow the chart up to full screen; the back arrow returns you.

`[VIDEO: live shot with chart]`

### Right column — machine buttons (non‑GHC machines)

If your DE1 has no Group Head Controller, a column of large buttons appears on the right:

**Coffee · Water · Steam · Flush · Stop**

While the machine is busy, the action buttons dim out and **Stop** turns red. On GHC machines this
column is hidden — you use the physical controller instead.

### Bottom — shot summary and history nav

Under the chart: the summary of the shot on screen (pre‑infusion, extraction and total figures), and
left/right arrows to step through previous shots (§7).

---

## 4. Pulling a shot

1. **Choose a profile** — either tap a favourite slot in the header, or open the profile selector
   (§6) and pick one.
2. **Set dose in** and **drink out** to match the basket and the ratio you want.
3. **Set brew temperature** if the profile default isn't what you want.
4. **Flush** the group (Flush button, or the GHC).
5. Lock in the portafilter, put the cup on the scale.
6. **Start** — GHC lever, or the **Coffee** button in the right column.
7. Watch the chart. If a scale is connected and *drink out* is set, the machine stops at weight.
   Otherwise stop manually.
8. When the shot ends, the summary fills in and the shot is written to history.

**Tare:** tap the weight readout on screen to tare the connected scale. Do this after the cup is on
the scale and before you start.

**No scale connected?** If your setup requires a scale for stop‑at‑weight, starting espresso is
blocked until one is connected — both from the Coffee button and from the keyboard shortcut.

`[VIDEO: full shot start-to-finish]`

---

## 5. Steam, hot water, and flush

**Steam.** Set the steam value in the left column (tap the *Steam* label to switch between
temperature, duration and flow). Start steam from the GHC or the **Steam** button. Steam stops on
the duration limit, or when you stop it.

**Hot water.** Tap the *Hot Water* label to choose what you're setting — volume, temperature,
duration or flow — then set the value. Start with the GHC or the **Water** button.

**Flush.** Sets a pre‑shot flush of a given duration and flow. Useful for stabilising group
temperature between shots.

All three respect whatever the machine's own limits are; if a value refuses to go higher, the
firmware is capping it.

---

## 6. Profiles

### Selecting a profile

Open the profile selector from the header. You get:

- A searchable, scrollable list of every profile the middleware knows about.
- A detail panel on the right — author, notes, and the profile's key parameters.
- Buttons to **select**, **edit**, **hide**, **delete**, and **upload** profiles.

Assign a profile to one of the five header favourite slots to reach it in one tap next time.

`[VIDEO: profile selector]`

### Editing a profile

The **EDIT** button opens the in‑browser profile editor. Three tabs:

**Steps.** Step cards, four visible at a time, scrolling horizontally. Per step you can set:

| Field | Meaning |
|---|---|
| Name | Label for the step, shown on the chart |
| Temperature | Target group temperature for this step (−/+) |
| Pump | **Flow** or **Pressure** control |
| Rate | The flow rate or pressure target |
| Transition | **Fast** (step change) or **Smooth** (ramp) |
| Exit condition | What ends the step — time, pressure, flow, weight |
| Message | Text shown on screen during the step |

**Settings.** Target weight, target volume, tank temperature, volume count start, beverage type.

**Review.** Plain‑English summary of every step, the profile settings, and a preview graph with
pressure, flow and temperature scaled onto a shared axis with step boundaries marked.

### How edits are saved

**Original profiles are never modified.** When you save an edit, Streamline.js writes a *copy* into
the middleware's key–value store under the `streamline` namespace. Those copies are merged into the
list every time you open the selector, so your edited version appears alongside the stock ones.

- Saving a profile whose name already exists auto‑suffixes it — `My Profile (2)`.
- The **RESET** button in the selector's right panel deletes your edited copy and puts you back on
  the original parent profile. It asks for confirmation first.

### Profile notes

The profile editor has a full Markdown editor (bold, italics, headings, lists, links, live preview)
for per‑profile notes. Notes autosave per profile.

---

## 7. Shot history

Every shot is stored locally in the browser's IndexedDB *and* on the middleware.

- Use the **←** / **→** arrows below the chart to step through past shots.
- Selecting a past shot replays its full curve on the main chart, so you can compare against what
  you just pulled.
- Each shot carries its metrics: pre‑infusion, extraction and total time/weight/volume summaries.
- History is paginated — it loads more as you go back rather than all at once.

---

## 8. Settings

Settings is an eleven-section list. Numbering below matches the on-screen menu.

### 1. Quick Adjustments
Fast access to steam, water and limit values. *Note: the save buttons in this section are present in
the UI but not yet wired to the backend.*

### 2. Connections
Bluetooth device management.

- **Scan** for DE1 machines and scales.
- **Connect** / **Disconnect** individual devices.
- **Scale auto‑connect** — reconnects your scale automatically on startup. Recommended.
- Machine auto‑connect is not implemented yet.

This is the section to visit whenever devices stop responding.

### 3. Calibration
- **Fan threshold** — temperature at which the machine's fan kicks in. Saveable.
- **Advanced heater phase flow** — DE1 advanced heater setting.
- Reset‑defaults, refill‑kit calibration, voltage/stop‑at‑weight/steam saves, and slow start are
  either not wired up yet or not supported by the firmware API.

### 4. Machine
Machine-level settings and information.

### 5. Maintenance
- **Descaling** — starts the descale routine.
- **Air purge**.
- Transport mode is not available (firmware API does not expose it).

### 6. Skin
- **Light / dark theme** toggle, persisted locally.
- **Skin switcher** — pick which web UI skin the bridge serves; applying reloads the page.
- **Presence‑based auto‑sleep** with a configurable schedule — the machine sleeps when nobody is
  around, on the hours you set.
- **Wake lock** — keeps the tablet screen from sleeping.

### 7. Language
Runtime language switching. Translations are CSV‑backed; changing language does not require a
reload.

### 8. Extensions
**Decent Visualizer** integration — toggle it on and enter your Visualizer credentials to have shots
uploaded automatically.

### 9. Miscellaneous
- **Display size (zoom)** — scales the whole UI. Persisted locally. Useful on very high or very low
  DPI tablets.
- **Smart charging** — charging mode selector, night‑mode schedule, and live charging status.
- Screen saver toggle, units selector and resolution selector exist in the UI but are not yet wired
  to the backend.

### 10. Updates
- Decaid app version and build info.
- Machine firmware version and serial number.
- **DE1 firmware upload** — select a firmware file and push it to the machine.
- Firmware/app "check for update" buttons are present but not yet wired.

> **Firmware uploads are not reversible from the UI.** Do not power off the machine or the tablet
> while a firmware upload is in progress.

### 11. User Manual
Links out to Decent Espresso support, the quickstart, and the skin developer docs.

Also reachable from Settings, depending on build:

- **Talk to Decent** — read and reply to support conversations in‑app.
- **Send Feedback** — file a bug/feature/general report. Markdown description, optional Decent
  account sign‑in so the report is attributed, and an optional system‑info attachment. Submits as a
  GitHub issue through the middleware.
- **Keyboard Shortcuts** — reference list.

`[VIDEO: settings walkthrough]`

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Everything is greyed out / no data | Middleware not running or not reachable | Confirm Decaid is up on `:8080`; check `localStorage.reaHostname` |
| Machine shows disconnected after a network blip | WebSocket reconnected and reset connection state | Wait — auto‑reconnect uses exponential backoff. If it persists, reconnect from Settings → Connections |
| Scale weight jumps or flickers | Normal noise; readings are throttled | If it never settles, disconnect/reconnect the scale |
| Edited profile disappeared | The copy lives in the middleware KV store | Check the middleware is the same instance you saved from |
| Uploading a profile appears to do nothing | Profiles are content‑addressed — an identical profile already exists | Change the content, not just the title |
| Portrait "rotate device" prompt | App is landscape‑only | Rotate, or lock the tablet to landscape |
| Chart stops updating mid‑shot | Snapshot WebSocket dropped | It reconnects automatically; the shot itself is unaffected — the machine keeps running |

---

# Part II — Using the middleware (Decaid)

## 10. What the middleware does

[Decaid](https://github.com/decentespresso/decaid) is a local server that owns everything
Streamline.js cannot do from a browser:

- Bluetooth LE connections to the DE1 and to scales
- Machine state, settings and firmware
- Profile storage, import/export and lineage
- Shot and steam logging, bean and grinder records
- A generic key–value store for skins to persist their own data
- A plugin system
- Hosting the web UI skins themselves

It exposes two interfaces, both on port `8080`:

- **REST** — `http://<host>:8080/api/v1/...` (OpenAPI spec: `rest_v1.yml`)
- **WebSocket** — `ws://<host>:8080/ws/v1/...` (AsyncAPI spec: `websocket_v1.yml`)

Rule of thumb: **REST for commands and configuration, WebSocket for anything that changes many times
a second.**

All examples below use `localhost`; substitute the tablet's IP when calling from another machine.

---

## 11. Devices: scan, connect, forget

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/devices` | List known devices |
| `POST` | `/api/v1/devices/scan` | Start a Bluetooth scan |
| `POST` | `/api/v1/devices/connect` | Connect a device |
| `POST` | `/api/v1/devices/disconnect` | Disconnect a device |
| `POST` | `/api/v1/devices/forget` | Forget a paired device |
| `*` | `/api/v1/devices/wifi` | Wi‑Fi configuration |

```bash
curl -X POST http://localhost:8080/api/v1/devices/scan
curl http://localhost:8080/api/v1/devices
```

There is also a **bidirectional** WebSocket channel, `ws/v1/devices`, which both accepts commands and
emits device state. That is what the app uses so the Connections screen updates live during a scan.

---

## 12. Machine control over REST

### State

```bash
# read current state
curl http://localhost:8080/api/v1/machine/state

# command a new state
curl -X PUT http://localhost:8080/api/v1/machine/state/espresso
curl -X PUT http://localhost:8080/api/v1/machine/state/steam
curl -X PUT http://localhost:8080/api/v1/machine/state/hotWater
curl -X PUT http://localhost:8080/api/v1/machine/state/flush
curl -X PUT http://localhost:8080/api/v1/machine/state/idle
curl -X PUT http://localhost:8080/api/v1/machine/state/sleeping
```

`idle` is the stop command. This is exactly what the Coffee/Water/Steam/Flush/Stop buttons do.

The full state set is: `booting`, `busy`, `idle`, `sleeping`, `heating`, `preheating`, `espresso`,
`hotWater`, `flush`, `steam`, `steamRinse`, `skipStep`, `cleaning`, `descaling`, `calibration`.

### Everything else

| Path | Purpose |
|---|---|
| `/api/v1/machine/info` | Model, serial, firmware version |
| `/api/v1/machine/capabilities` | What this machine supports (GHC? cup warmer? LED strip?) |
| `/api/v1/machine/profile` | Get/set the active profile |
| `/api/v1/machine/shotSettings` | Dose, temperature, steam, hot water, flush settings |
| `/api/v1/machine/settings` | Machine settings |
| `/api/v1/machine/settings/advanced` | Advanced settings (heater phase flow, etc.) |
| `/api/v1/machine/settings/reset` | Reset settings to defaults |
| `/api/v1/machine/calibration` | Calibration values |
| `/api/v1/machine/waterLevels` | Tank level |
| `/api/v1/machine/cupWarmer` | Cup warmer on/off |
| `/api/v1/machine/ledStrip`, `/ledStrip/commit`, `/ledStrip/reset` | LED strip colour control |
| `/api/v1/machine/firmware`, `/firmware/apply` | Upload and apply firmware |
| `/api/v1/machine/heartbeat` | Keep‑alive |

Call `capabilities` before showing hardware‑specific UI. That is how Streamline.js decides whether to
render the Warmer button and the non‑GHC control column.

### Scale

```bash
curl -X POST http://localhost:8080/api/v1/scale/tare
curl -X POST http://localhost:8080/api/v1/scale/timer/start
curl -X POST http://localhost:8080/api/v1/scale/timer/stop
curl -X POST http://localhost:8080/api/v1/scale/timer/reset
```

### Display and presence

| Path | Purpose |
|---|---|
| `/api/v1/display` | Display state |
| `/api/v1/display/brightness` | Screen brightness |
| `/api/v1/presence/settings` | Presence‑detection settings |
| `/api/v1/presence/schedules`, `/schedules/{id}` | Auto‑sleep schedules |

---

## 13. Live data over WebSocket

Connect to `ws://<host>:8080/<channel>`. Every channel emits JSON frames.

| Channel | Contents |
|---|---|
| `ws/v1/machine/snapshot` | **The main feed.** Pressure, flow, temperatures, state, timestamp |
| `ws/v1/machine/shotState` | Shot phase and decision frames, timestamped to match `snapshot` |
| `ws/v1/machine/shotSettings` | Shot settings whenever they change |
| `ws/v1/machine/waterLevels` | Tank level |
| `ws/v1/machine/raw` | Raw machine frames — debugging |
| `ws/v1/scale/snapshot` | Smoothed weight + weight flow, plus scale connection status frames |
| `ws/v1/devices` | Device state; also accepts commands |
| `ws/v1/display` | Display state |
| `ws/v1/sensors/{id}/snapshot` | A specific sensor's readings |
| `ws/v1/plugins/{id}/{endpoint}` | Plugin-provided streams |
| `ws/v1/logs`, `ws/v1/webview/logs` | Middleware and web view logs |
| `ws/v1/update` | App update progress |

Minimal client:

```js
const ws = new WebSocket('ws://localhost:8080/ws/v1/machine/snapshot');
ws.onmessage = (e) => {
  const s = JSON.parse(e.data);
  console.log(s.timestamp, s.pressure, s.flow, s.groupTemperature);
};
```

**Two practical notes:**

1. **Reconnect.** These sockets drop — tablets sleep, Wi‑Fi hiccups. Streamline.js wraps every socket
   in a reconnecting wrapper with exponential backoff. Do the same. And remember that a reconnect
   resets your view of connection status, so re‑query state after reconnecting rather than trusting
   your last cached value.
2. **`shotState` and `snapshot` share a timebase.** Their timestamps line up, so you can correlate a
   phase transition with the exact pressure/flow sample that triggered it.

---

## 14. Profiles and the workflow API

### Profile endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/v1/profiles` | List / upload profiles |
| `GET` / `DELETE` | `/api/v1/profiles/{id}` | Fetch / delete one |
| `PUT` | `/api/v1/profiles/{id}/visibility` | Hide or show a profile |
| `GET` | `/api/v1/profiles/{id}/lineage` | Where this profile came from |
| `POST` | `/api/v1/profiles/{id}/purge` | Hard delete |
| `POST` | `/api/v1/profiles/import` | Import a bundle |
| `GET` | `/api/v1/profiles/export` | Export a bundle |
| `POST` | `/api/v1/profiles/restore/{filename}` | Restore from a backup |
| `GET` | `/api/v1/profiles/defaults` | The bundled default set |

> **Profiles are content‑addressed.** `POST /api/v1/profiles` deduplicates by a hash of the profile
> content. The title is *not* part of that identity. Uploading a profile whose content already exists
> is a silent no‑op, and renaming a profile alone will not create a new one. If you want a distinct
> profile, change its content.

### The workflow API

`/api/v1/workflow` is the wrapper endpoint that ties a profile together with its shot settings, bean
and grinder as a single unit.

**Use the workflow API to change the active profile — not `POST /api/v1/machine/profile` directly.**
Setting the machine profile on its own bypasses the bookkeeping the middleware does around it, and
the shot that follows will be logged with stale or missing associations. Streamline.js routes all
profile changes through the workflow wrapper for exactly this reason.

---

## 15. Shots, beans, grinders

### Shots and steams

| Path | Purpose |
|---|---|
| `GET /api/v1/shots` | List shots |
| `GET /api/v1/shots/ids` | Just the IDs — cheap for syncing |
| `GET /api/v1/shots/latest` | Most recent shot |
| `GET /api/v1/shots/{id}` | One shot with full sample data |
| `GET /api/v1/steams`, `/steams/ids`, `/steams/latest`, `/steams/{id}` | Same shape, for steaming sessions |

Typical sync pattern: pull `/shots/ids`, diff against what you already hold locally, fetch only the
new ones. That is how Streamline.js keeps IndexedDB in step without refetching everything.

### Beans and grinders

| Path | Purpose |
|---|---|
| `/api/v1/beans`, `/api/v1/beans/{id}` | Bean records |
| `/api/v1/beans/{beanId}/batches` | Batches (roast dates) for a bean |
| `/api/v1/bean-batches/{id}` | One batch |
| `/api/v1/grinders`, `/api/v1/grinders/{id}` | Grinder records |

These back the DYE (*Describe Your Espresso*) screen — attaching a bean batch and grinder setting to
a shot so history is searchable later.

---

## 16. The key–value store

A general-purpose namespaced store any skin can use.

```bash
# list a namespace
curl http://localhost:8080/api/v1/store/streamline

# read one key
curl http://localhost:8080/api/v1/store/streamline/<uuid>

# write one key
curl -X PUT http://localhost:8080/api/v1/store/streamline/<uuid> \
     -H 'Content-Type: application/json' \
     -d '{"...":"..."}'
```

Streamline.js uses the `streamline` namespace to hold user-edited profile copies (§6). Pick your own
namespace for your own skin; do not write into someone else's.

---

## 17. Plugins

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/plugins` | List installed plugins |
| `GET`/`PUT` | `/api/v1/plugins/{id}/settings` | Plugin settings |
| `POST` | `/api/v1/plugins/{id}/enable` | Enable |
| `POST` | `/api/v1/plugins/{id}/disable` | Disable |
| `DELETE` | `/api/v1/plugins/{id}` | Remove |
| `POST` | `/api/v1/plugins/install` | Install |

Plugins can also publish live streams at `ws/v1/plugins/{id}/{endpoint}`. Two the app consumes:

- `time-to-ready.reaplugin` → `timeToReady` — countdown until the machine is at temperature.
- `decent-profile.reaplugin` → `profileGenerated` — generated-profile notifications.

---

## 18. Skins and the web UI server

The middleware hosts the web UI itself, which is how a tablet gets Streamline.js without any separate
web server.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/webui/skins` | List installed skins |
| `GET`/`DELETE` | `/api/v1/webui/skins/{id}` | One skin |
| `PUT` | `/api/v1/webui/skins/default` | Set the active skin |
| `POST` | `/api/v1/webui/skins/install/github-release` | Install from a GitHub release |
| `POST` | `/api/v1/webui/skins/install/github-branch` | Install from a GitHub branch |
| `POST` | `/api/v1/webui/skins/install/url` | Install from a URL |
| `POST` | `/api/v1/webui/skins/update` | Update installed skins |
| `GET` | `/api/v1/webui/server/status` | Is the UI server running |
| `POST` | `/api/v1/webui/server/start` / `/stop` | Start / stop it |
| `GET` | `/api/v1/webui/skin-assets/{id}/{filepath}` | Serve a skin asset |

A skin is identified by its `skin-manifest.json`:

```json
{
  "id": "streamline.js",
  "name": "Streamline.js",
  "description": "Modern, feature-complete WebUI skin for Streamline-Bridge",
  "version": "0.1.95"
}
```

Installing a new version from a GitHub release and then setting it as default is the normal upgrade
path — this is what Settings → Skin drives.

---

## 19. Appendix

### A. Keyboard shortcuts

Shortcuts fire only when a DE1 is connected, the machine is **non‑GHC**, and no text field has
focus. On GHC machines they are disabled — the physical controller is the input.

| Key | Action |
|---|---|
| `E` | Start espresso |
| `S` | Start steam |
| `W` | Dispense hot water |
| `F` | Flush |
| `Space` | Stop (idle) |
| `P` | Sleep |

Bindings are remappable and stored in `localStorage` under `keyboardBindings`.

### B. Local browser storage keys

| Key | Purpose |
|---|---|
| `reaHostname` | Middleware host (port is always `8080`) |
| Theme key | Light/dark selection |
| Display size key | UI zoom level |

Shot history lives in IndexedDB, not `localStorage`.

### C. Spec files in the repository

| File | Contents |
|---|---|
| `rest_v1.yml` | Full OpenAPI 3.0 REST specification |
| `websocket_v1.yml` | Full AsyncAPI 3.0 WebSocket specification |
| `DESIGN_SYSTEM.md` | Design tokens and component patterns |
| `CLAUDE.md` | Build and contribution conventions |

### D. Glossary

| Term | Meaning |
|---|---|
| **DE1** | Decent Espresso machine |
| **GHC** | Group Head Controller — the physical control ring on the machine |
| **Decaid** | The middleware — <https://github.com/decentespresso/decaid>. Formerly Streamline‑Bridge, formerly Rea Prime (repo `reaprime`) |
| **Skin** | A web UI served by the middleware; Streamline.js is one |
| **DYE** | *Describe Your Espresso* — bean/grinder/notes attached to a shot |
| **Workflow** | A profile plus its shot settings, bean and grinder as one unit |
| **Content‑addressed** | Identified by a hash of the content, not by name |
| **Snapshot** | One frame of live machine data on the WebSocket feed |

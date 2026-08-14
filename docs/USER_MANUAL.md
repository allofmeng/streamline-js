# Decaid and Streamline.js — User Manual

**Applies to:** Decaid (the app formerly called decent.app) and the Streamline.js skin, v0.1.95

> **Draft note.** English manual built from Mark Chau's Chinese guide *decent.app 使用說明*, expanded
> and checked against the Decaid and Streamline.js source. Clip placeholders are marked `[VIDEO: …]`.

---

## Table of Contents

**Part I — Getting started with Decaid**
1. [What Decaid is](#1-what-decaid-is)
2. [Installing Decaid and importing your de1app data](#2-installing-decaid-and-importing-your-de1app-data)
3. [Connecting your DE1 and scale](#3-connecting-your-de1-and-scale)
4. [Choosing a skin](#4-choosing-a-skin)
5. [Decaid settings](#5-decaid-settings)

**Part II — Using Streamline.js**
6. [How the interface works](#6-how-the-interface-works)
7. [The main screen](#7-the-main-screen)
8. [Pulling a shot](#8-pulling-a-shot)
9. [Steam, hot water, and flush](#9-steam-hot-water-and-flush)
10. [Profiles and the profile editor](#10-profiles-and-the-profile-editor)
11. [Derek, the smart assistant](#11-derek-the-smart-assistant)
12. [Shot history](#12-shot-history)
13. [Streamline settings](#13-streamline-settings)
14. [Troubleshooting](#14-troubleshooting)

**Part III — The Decaid API (for developers)**
15. [What the API covers](#15-what-the-api-covers)
16. [Devices: scan, connect, forget](#16-devices-scan-connect-forget)
17. [Machine control over REST](#17-machine-control-over-rest)
18. [Live data over WebSocket](#18-live-data-over-websocket)
19. [Profiles and the workflow API](#19-profiles-and-the-workflow-api)
20. [Shots, beans, grinders](#20-shots-beans-grinders)
21. [The key–value store](#21-the-keyvalue-store)
22. [Plugins](#22-plugins)
23. [Skins and the web UI server](#23-skins-and-the-web-ui-server)
24. [Appendix](#24-appendix)

---

# Part I — Getting started with Decaid

## 1. What Decaid is

Decaid is a ground-up rewrite of the software that drives your Decent Espresso machine. It replaces
the old `de1app`, and it was rebuilt with two goals: make the software easier to develop, and run on
as many platforms as possible.

Decaid does not draw the coffee screen itself. It is the **bridge** between your machine and
whichever user interface — "skin" — you choose:

```
   DE1  ──►  tablet  ──►  Decaid  ──►  skin  ──►  your espresso
```

Decaid owns the hard parts: the Bluetooth or USB connection to the machine, the scale, profile
storage, shot logging, and the API that skins are built on. The skin owns what you look at and
touch. This manual covers Decaid in Part I and the **Streamline.js** skin in Part II.

### Supported platforms

| Platform | Notes |
|---|---|
| **Android** | Primary. Runs on the Decent tablets, and can run as a background service that holds the machine and scale connections |
| **iOS / iPadOS** | Via TestFlight while in testing |
| **macOS** | Full support |
| **Windows** | Full support |
| **Linux** | ARM64 and x86_64 |

Decaid connects over Bluetooth or USB, and supports the Bengle as well as the DE1.

**Downloads:** <https://github.com/decentespresso/decaid/releases>

> **A note on the name.** Decaid has been renamed several times: **REA** ("Reasonable Espresso App")
> → **ReaPrime** → **Streamline Bridge** → **Decent.app** → **Decaid** in 2026, ten years after the
> first commit to the original `de1app` repository. The name commemorates that decade while
> describing what the app does: it **aids** you in making *decent* espresso.
>
> Only the display name changed. Internal identifiers were deliberately left alone so existing
> integrations keep working, which is why the old names still show up in the plumbing:
>
> | Identifier | Value |
> |---|---|
> | Dart package | `reaprime` |
> | Bundle ID | `net.tadel.reaprime` |
> | Database | `streamline_bridge` |
> | Plugin extension | `.reaplugin` (e.g. `dye2.reaplugin`) |
> | Streamline.js host key | `localStorage.reaHostname` |
>
> Use **Decaid** in prose; leave the identifiers alone.

---

## 2. Installing Decaid and importing your de1app data

Install Decaid from the releases page above, or from TestFlight on iOS.

The first time you run it on a tablet that already has `de1app`, Decaid offers to **import your
existing data**. Accept it — this is the easiest way to carry over what you already have. Decaid
reads `de1app`'s own files, including `settings.tdb` and the DYE plugin's `grinders.tdb`, and brings
across your settings, profiles, shot history, beans and grinders.

`[VIDEO: Screen_Recording_20260723_154542.mp4 — first install and importing de1app data]`

First-run setup walks through a short sequence: welcome, permissions, an Android warning where
relevant, the data import, scanning for your machine, sign-in, and initialisation.

> If you skip the import at first run, you can still import later from Decaid's data management
> settings.

---

## 3. Connecting your DE1 and scale

On first use Decaid asks **which DE1 to connect to**. Machines in range are listed; choose yours and
connect. Decaid remembers it and auto-connects on later starts.

`[VIDEO: 連機.mov — selecting and connecting your DE1]`

Scales are handled the same way. Connect yours once and enable auto-connect so it comes back on its
own. See §5 for what the scale does when the machine goes to sleep.

---

## 4. Choosing a skin

A skin is the interface you actually touch. Decaid can install and serve several, and two are
officially supported:

| Skin | Notes |
|---|---|
| **Streamline** | Documented in Part II of this manual |
| **Insight** | The other officially supported skin |

Decaid's skin registry also carries community skins — Passione, OverDose, Beanie, NSX and
WorkFlow — which install the same way but are not documented here.

`[VIDEO: 改皮膚.mov — finding and switching skins]`

**To leave a skin and return to Decaid's dashboard: swipe right from the left edge of the screen,**
or use your device's back gesture. This is worth knowing before you open a skin for the first time,
because a skin fills the whole screen.

### Viewing a skin in a browser

The skin also runs in an ordinary browser. Decaid serves it on **port 3000**:

```
http://localhost:3000
```

From another device on the same network, use the tablet's address — `http://<tablet-ip>:3000`.

**The in-app web view is the primary way to use a skin**; a browser is the secondary way, handy for
checking on the machine from a laptop or phone, and for development. Everything works in both.

| | In-app web view (primary) | Browser (secondary) |
|---|---|---|
| Fullscreen | The host OS owns the screen; the fullscreen button is hidden | Fullscreen button available |
| External links | The host opens them in the OS browser | Open normally |
| Leaving the skin | Swipe right from the left edge, or the floating **Exit to Decent dashboard** button | Not applicable |
| Browser engine | The tablet's Android System WebView | Whatever the browser ships |

> **Android WebView versions.** The in-app web view is only as good as the Android System WebView
> installed on the tablet. Some older versions — Teclast tablets are the known case — render skins
> incorrectly. Update Android System WebView and restart the device. Decaid detects an incompatible
> WebView and will point you at an external browser if the problem persists.

**Two ports, two jobs.** Port `3000` serves the skin — that is the one you type into a browser.
Port `8080` is Decaid's API, which the skin calls in the background. You never open `:8080` yourself.

---

## 5. Decaid settings

These are Decaid's own settings, separate from the skin's. The ones people reach for most:

> Looking for the screen saver? That one belongs to the skin, not Decaid — see §13.

### Connections → Scale → scale power mode

What the scale does when the machine goes to sleep. Three choices:

| Mode | Behaviour |
|---|---|
| **None** | Stay connected and keep the scale's display on |
| **Display off** | Stay connected but switch the scale's screen off; it comes back on when the machine wakes |
| **Disconnect** | Drop the scale connection entirely — **the default** |

`[SCREENSHOT: scale power mode]`

### Language

Decaid is translated into a number of languages; pick yours here.

`[SCREENSHOT: language]`

### Data management

Import and export your data — the same machinery used by the first-run de1app import.

---

# Part II — Using Streamline.js

## 6. How the interface works

Streamline.js reduces the main screen to **two gestures**:

| Gesture | What it does |
|---|---|
| **Single tap** | Runs the thing — applies a preset, starts an action, loads a profile |
| **Long press** | Opens a menu of options for that control |

That pattern is consistent, so when you want to *change* something rather than *use* it, press and
hold. A few examples:

| Long-press this | And you get |
|---|---|
| A brew-temperature preset | *Apply 92°C* · *Enter value* — the numpad, to redefine the preset |
| A dose:yield ratio preset | *Apply 18:36* · *Enter value* — two numpads, dose then yield |
| A favourite profile slot | *Browse Profiles*, or clear the slot if one is assigned |
| The shot history panel | *Discuss with Derek* · *Copy Shot Summary* (§11) |
| The active profile | *Use Profile Defaults*, to discard your adjustments |

Values with **−** and **+** buttons work the same way as before: tap to step once, press and hold to
repeat quickly, or tap the number itself to open a numpad. The numpad also lists values you used on
previous shots, so you can jump back to a known-good dose or temperature.

---

## 7. The main screen

Everything lives on one page. It is laid out to put extraction information front and centre:

- **Left column** — the settings for the shot you are about to pull
- **Centre** — the chart, showing your most recent shot until a new one starts, then drawing live
- **Top** — five favourite profiles
- **Bottom** — the summary of the shot on screen, and arrows to step back through history

`[SCREENSHOT: main screen]`

### Top bar

**The top bar has two forms, depending on whether the DYE2 plugin is switched on.** DYE2 is **off by
default**, so unless you have turned it on you are looking at the first form.

#### Always present

| Element | What it does |
|---|---|
| Favourite slots | Five quick-access profile buttons. Tap to load; long-press to reassign |
| **Warmer** | Toggles the cup warmer (only if your machine reports the capability) |
| **Settings** | Opens the skin's settings (§13) |
| **Sleep** | Puts the DE1 to sleep |
| Fullscreen | Toggles browser fullscreen. Hidden in the in-app web view |

With DYE2 off, that is the whole top bar: profile favourites and nothing else. No P/F/R toggle, no
DYE button, no auto-favourite strip.

#### Only when DYE2 is switched on

| Element | What it does |
|---|---|
| **P / F / R** tabs | Switch the strip between **P**rofile favourites (default), **F** DYE2 auto-favourites, and **R** DYE2 recipes |
| Auto-fav / recipe strip | In **F** and **R** modes, shows DYE2's bean-and-recipe snapshots, ending with a **VIEW ALL** cell |
| **DYE** | Opens the DYE2 dashboard — bean, grinder and notes for the shot |

Turning DYE2 on shifts the favourite slots right to make room, so the bar visibly rearranges.

**Turning it on:** Settings → **Extensions** → **Describe Your Espresso** → the **DYE2** toggle. The
`dye2.reaplugin` plugin must be installed in Decaid and at or above its minimum version; if it
isn't, the toggle refuses to stay on and offers a download link. Streamline.js only *reads* DYE2's
data — a recipe hidden in DYE2 will not appear here.

In the in-app web view there is also a floating **Exit to Decent dashboard** button. Drag it to
move it; long-press to hide it.

### Left column — shot settings

- **Grind** — your grinder setting. Recorded with the shot; it does not command the grinder
- **Dose in** — dry coffee weight in grams
- **Drink out** — target beverage weight. Drives stop-at-weight when a scale is connected
- **Temp** — brew temperature
- **Steam** — tap the *label* to cycle between temperature, duration and flow
- **Flush** — tap the label to switch between duration and flow
- **Hot water** — tap the label to cycle volume, temperature, duration and flow

The "tap the label to change what you are editing" pattern is consistent across Steam, Flush and Hot
Water. If a number looks wrong, check which mode the label is in.

### Centre — the chart

Between shots the chart shows your **most recent shot**, so you always have something to compare
against. During a shot it draws live:

- **Pressure** (bar) and **flow** (ml/s)
- **Group temperature** — actual solid, target dashed
- **Weight** and weight flow when a scale is connected
- Markers where the profile steps over

Tap the expand icon for full screen; the back arrow returns you.

`[VIDEO: live shot with chart]`

### Right column — machine buttons (non-GHC machines)

If your DE1 has no Group Head Controller, a column of large buttons appears: **Coffee · Water ·
Steam · Flush · Stop**. While the machine is busy the action buttons dim and **Stop** turns red. On
GHC machines this column is hidden — you use the physical controller.

---

## 8. Pulling a shot

1. **Choose a profile** — tap a favourite slot, or open the profile selector (§10).
2. **Set dose in** and **drink out** for your basket and ratio.
3. **Set brew temperature** if the profile default isn't what you want.
4. **Flush** the group.
5. Lock in the portafilter, cup on the scale.
6. **Tare** — tap the weight readout.
7. **Start** — the GHC, or the **Coffee** button.
8. Watch the chart. With a scale connected and *drink out* set, the machine stops at weight.
   Otherwise stop manually.
9. The summary fills in and the shot is written to history.

**No scale connected?** If your setup requires a scale for stop-at-weight, starting espresso is
blocked until one is connected — from the Coffee button and the keyboard shortcut alike.

`[VIDEO: full shot start-to-finish]`

---

## 9. Steam, hot water, and flush

**Steam.** Set the value in the left column (tap the *Steam* label to switch between temperature,
duration and flow). Start from the GHC or the **Steam** button. Steam stops on its duration limit,
or when you stop it.

**Hot water.** Tap the *Hot Water* label to choose volume, temperature, duration or flow, then set
the value. Start with the GHC or the **Water** button.

**Flush.** A pre-shot flush of a given duration and flow, for stabilising group temperature between
shots.

All three respect the machine's own limits; if a value refuses to go higher, the firmware is capping
it.

---

## 10. Profiles and the profile editor

### The profile library

Open the profile selector from the header for a searchable list of every profile Decaid knows about,
with a detail panel showing author, notes and key parameters. From here you can select, edit, hide,
delete and upload profiles, and assign any of them to one of the five header favourite slots.

`[SCREENSHOT: profile library]`

### The editor

The **EDIT** button opens the in-browser editor, which has **three pages**:

**Steps.** Step cards, four visible at a time, scrolling horizontally.

| Field | Meaning |
|---|---|
| Name | Label for the step, shown on the chart |
| Temperature | Target group temperature for this step |
| Pump | **Flow** or **Pressure** control |
| Rate | The flow rate or pressure target |
| Transition | **Fast** (step change) or **Smooth** (ramp) |
| Exit condition | What ends the step — time, pressure, flow, weight |
| Message | Text shown on screen during the step |

**Settings.** Target weight, target volume, tank temperature, volume count start, beverage type.

**Review.** Plain-English summaries of every step, the profile settings, and a preview graph with
pressure, flow and temperature on a shared axis with step boundaries marked.

`[SCREENSHOT: editor — steps]`
`[SCREENSHOT: editor — settings]`
`[SCREENSHOT: editor — review]`

### How edits are saved

**Original profiles are never modified.** Saving an edit writes a *copy* into Decaid's key–value
store under the `streamline` namespace, and those copies are merged into the list every time you
open the selector.

- Saving over an existing name auto-suffixes it — `My Profile (2)`.
- **RESET** in the selector's right panel deletes your copy and restores the original parent
  profile, after a confirmation.

### Profile notes

The editor includes a full Markdown editor for per-profile notes — bold, italics, headings, lists,
links, live preview. Notes autosave per profile.

---

## 11. Derek, the smart assistant

Derek answers questions about your DE1 and your equipment, and can look at a specific shot with you.

**To ask Derek about a shot:**

1. **Long-press the shot history panel** on the main screen.
2. Choose **Discuss with Derek**.
3. The shot summary is copied to your clipboard and Derek opens.
4. Paste it into the chat and ask your question.

The same menu offers **Copy Shot Summary** if you only want the text.

`[VIDEO: Screen Recording 2026-07-23 at 4.09.16 PM.mov — Derek]`

Derek is not limited to shots you paste in — you can ask it general DE1 and equipment questions too.

> Technically: Decaid proxies Derek at `POST /api/v1/derek/answers/stream`, forwarding to
> `derek.decentespresso.com` and streaming the answer back.

---

## 12. Shot history

Every shot is stored locally in the browser's IndexedDB *and* in Decaid.

- The **←** / **→** arrows below the chart step through past shots.
- Selecting a past shot replays its full curve on the main chart, to compare against what you just
  pulled.
- Each shot carries its metrics: pre-infusion, extraction and total summaries.
- History is paginated — it loads more as you go back.
- **Long-press the history panel** for Derek and copy options (§11).

---

## 13. Streamline settings

Reached from the **Settings** button. Eleven sections; numbering matches the on-screen menu.

### 1. Quick Adjustments
Fast access to steam, water and limit values. *The save buttons here are not yet wired up.*

### 2. Connections
Scan for and connect the DE1 and scales; disconnect individual devices; **scale auto-connect**
(recommended). Machine auto-connect is not implemented yet. This is the section to visit when
devices stop responding.

### 3. Calibration
**Fan threshold** (saveable) and **advanced heater phase flow**. Reset-defaults, refill-kit
calibration, voltage/stop-at-weight/steam saves and slow start are either not wired up yet or not
supported by the firmware API.

### 4. Machine
Sub-pages for **USB**, **Machine Information**, and — on Bengle machines only — **Cup Warmer** and
**Lighting** (LED strip).

### 5. Maintenance
**Machine Descaling** and air purge.

### 6. Skin
**Theme & Updates** — light/dark theme, and the skin switcher. Applying a different skin reloads the
page.

### 7. Language
Runtime language switching, CSV-backed. No reload needed.

### 8. Extensions
Three sub-pages:

**Visualizer** — toggle on and enter your Decent Visualizer credentials to upload shots
automatically.

**Plugins** — the plugins Decaid has installed.

**DYE2** — the *Describe Your Espresso* master switch, **default off**. Turning it on adds the P/F/R
toggle, the auto-favourite/recipe strip and the DYE button to the header (§7). Requires
`dye2.reaplugin` installed in Decaid.

### 9. Miscellaneous
A group of sub-pages: **Decent.app Settings**, **Brightness**, **Wake Lock**, **Presence
Detection**, **Display Size**, **Temperature**, **Screen Saver** and **Keyboard Shortcuts**.

**Display size (zoom)** is persisted locally — useful on unusual tablet resolutions. **Temperature**
switches between °C and °F. **Smart charging** offers a night-mode schedule and live charging
status.

#### Screen Saver

The screen saver belongs to the skin, not to Decaid — it is configured here, and it only appears
while the machine is **confirmed asleep**. Tapping it wakes the machine.

| Control | Notes |
|---|---|
| On / off | Enabled by default |
| Your own images | Upload one or more; thumbnails are shown, and you can clear them again |
| Image cycle | How long each image stays up, 2–600 seconds, default 10. Only meaningful with more than one image |
| Black screen | A plain black screen saver instead of images |

`[SCREENSHOT: screen saver — image selection]`
`[SCREENSHOT: screen saver — black screen]`

> The skin never raises the screen saver optimistically, and hiding it never wakes the machine —
> only your tap does. This is deliberate: an earlier version put the machine to sleep and woke it
> again 46 ms later because hiding the overlay also sent a wake command.

### 10. Updates
Decaid's app version and build info; machine firmware version and serial; and **DE1 firmware
upload**. The firmware/app "check for update" buttons are not yet wired.

> **Firmware uploads are not reversible from the UI.** Do not power off the machine or the tablet
> while one is in progress.

### 11. User Manual
Links to Decent Espresso support, the quickstart, and the skin developer docs.

Also available, depending on build: **Talk to Decent** (read and reply to support conversations
in-app), **Send Feedback** (bug/feature/general report with a Markdown description, optional Decent
account sign-in and system info, submitted as a GitHub issue), and a **Keyboard Shortcuts**
reference.

`[VIDEO: settings walkthrough]`

---

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Page won't load at all in a browser | Wrong port, or the web UI server is stopped | The skin is on `:3000`, not `:8080`. Check Settings → Skin, or `GET /api/v1/webui/server/status` |
| Page loads but everything is greyed out | Decaid not running or not reachable | Confirm Decaid's API is up on `:8080`; check `localStorage.reaHostname` |
| Skin renders wrong on the tablet only | Outdated Android System WebView | Update it and restart the device (§4) |
| Can't get out of a skin | — | Swipe right from the left edge of the screen |
| Machine shows disconnected after a network blip | WebSocket reconnected and reset connection state | Wait — reconnect uses exponential backoff. If it persists, reconnect from Settings → Connections |
| Scale weight jumps or flickers | Normal noise; readings are throttled | If it never settles, disconnect and reconnect the scale |
| Scale drops off every time the machine sleeps | Scale power mode is **Disconnect**, the default | Change it in Decaid's settings (§5) |
| Edited profile disappeared | The copy lives in Decaid's KV store | Check you are on the same Decaid instance you saved from |
| Uploading a profile appears to do nothing | Profiles are content-addressed — an identical one exists | Change the content, not just the title |
| Portrait "rotate device" prompt | The skin is landscape-only | Rotate, or lock the tablet to landscape |
| Chart stops updating mid-shot | Snapshot WebSocket dropped | It reconnects automatically; the machine keeps running regardless |

---

# Part III — The Decaid API (for developers)

## 15. What the API covers

[Decaid](https://github.com/decentespresso/decaid) is a local server that owns everything
Streamline.js cannot do from a browser:

- Bluetooth LE connections to the DE1 and to scales
- Machine state, settings and firmware
- Profile storage, import/export and lineage
- Shot and steam logging, bean and grinder records
- A generic key–value store for skins to persist their own data
- A plugin system
- Hosting the web UI skins themselves

Anything a skin can do, you can do — Streamline.js is an ordinary API client with no privileged
access. Platforms and installation are covered in §1.

### Ports

| Port | Serves |
|---|---|
| `3000` | The skin — this is what you open in a browser |
| `8080` | REST API and WebSocket streams |
| `4001` | Browsable API documentation, while Decaid is running |

For the full API reference, start Decaid and open <http://localhost:4001>. You can also serve it
yourself from the checkout: `cd assets/api/ && npx httpserver -p 4001`.

It exposes two API interfaces, both on port `8080`:

- **REST** — `http://<host>:8080/api/v1/...` (OpenAPI spec: `rest_v1.yml`)
- **WebSocket** — `ws://<host>:8080/ws/v1/...` (AsyncAPI spec: `websocket_v1.yml`)

Rule of thumb: **REST for commands and configuration, WebSocket for anything that changes many times
a second.**

All examples below use `localhost`; substitute the tablet's IP when calling from another machine.

---

## 16. Devices: scan, connect, forget

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

## 17. Machine control over REST

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

## 18. Live data over WebSocket

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

## 19. Profiles and the workflow API

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

## 20. Shots, beans, grinders

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

These back the DYE2 (*Describe Your Espresso*) screen — attaching a bean batch and grinder setting
to a shot so history is searchable later.

---

## 21. The key–value store

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

Streamline.js uses the `streamline` namespace to hold user-edited profile copies (§10). Pick your own
namespace for your own skin; do not write into someone else's.

---

## 22. Plugins

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

### Derek

Derek (§11) is not a plugin — Decaid proxies it directly:

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/v1/derek/answers/stream` | Forwards the request body to `https://derek.decentespresso.com/api/answers/stream` and streams the response back as `text/event-stream` |

Proxying it through Decaid means a skin never needs the upstream address or its own network path to
it.

---

## 23. Skins and the web UI server

The middleware hosts the web UI itself, which is how a tablet gets Streamline.js without any separate
web server. **The skin is served on port `3000`** — `http://localhost:3000`, or
`http://<tablet-ip>:3000` from another device — while the REST and WebSocket APIs stay on `8080`.

The `/webui/server/*` endpoints below control that port‑3000 server.

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

## 24. Appendix

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

In the [Decaid repository](https://github.com/decentespresso/decaid):

| Location | Contents |
|---|---|
| `assets/api/` | The browsable API documentation served on port `4001` |
| `doc/` | Decaid's own documentation |
| `README.md` | Features, platforms, skins, plugins, naming history |

### D. Glossary

| Term | Meaning |
|---|---|
| **DE1** | Decent Espresso machine |
| **GHC** | Group Head Controller — the physical control ring on the machine |
| **Decaid** | The middleware — <https://github.com/decentespresso/decaid>. Formerly Streamline‑Bridge, formerly Rea Prime (repo `reaprime`) |
| **Skin** | A web UI served by Decaid; Streamline.js and Insight are the two official ones |
| **de1app** | The original TCL application Decaid replaces. Decaid can import its data |
| **Derek** | Decent's assistant, reachable from the shot history long-press menu |
| **Bengle** | The other machine Decaid supports alongside the DE1 |
| **DYE2** | *Describe Your Espresso 2* — a separate Decaid plugin (`dye2.reaplugin`) for bean/grinder/notes, auto‑favourites and recipes. Off by default in Streamline.js |
| **Workflow** | A profile plus its shot settings, bean and grinder as one unit |
| **Content‑addressed** | Identified by a hash of the content, not by name |
| **Snapshot** | One frame of live machine data on the WebSocket feed |

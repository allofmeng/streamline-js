# Streamline.js

A modern web UI skin for the Decent Espresso DE1, built on top of [Streamline-Bridge (reaprime)](https://github.com/tadelv/reaprime). This is a full rewrite of the original TCL-based Streamline skin into a browser-native web application — no framework, no bundler, just HTML/CSS/JS served as static files.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Vanilla JavaScript (ES6 modules) |
| Styling | Tailwind CSS + daisyUI (CDN) |
| Charting | Plotly.js |
| Local storage | IndexedDB |
| Communication | WebSocket + REST (via reaprime) |
| Fonts | Inter, NotoSansMono |

---

## Implemented Features

### Real-Time Shot Visualization
- Live pressure, flow, and group temperature charting via Plotly.js
- Target vs. actual overlay lines (dashed = target)
- Phase step markers and annotations
- Scale weight display during extraction

### Shot Settings Control
- Dose in/out, grind size, brew temperature
- Steam temperature, duration, and flow
- Hot water volume, temperature, duration, and flow
- Pre-shot flush duration and flow
- Mobile-friendly numpad modal with value history from previous shots

### Profile Management
- Browse, search, and select from all available profiles
- 5 quick-access favorite profile slots in the header
- Upload, rename, hide, and delete profiles
- Profile metadata display (author, notes, parameters)

### Shot History
- Paginated shot history backed by IndexedDB
- Tap any past shot to replay its data on the chart
- Per-shot metrics: pre-infusion, extraction, and total phase summaries

### Machine Control
- Start/stop espresso, steam mode, hot water dispensing
- Machine sleep button
- Real-time water tank level display
- DE1 and scale device scan/connect/disconnect
- Auto-reconnection with exponential backoff on WebSocket drop

### Settings
- **Bluetooth** — scan and connect DE1 and scale; scale auto-connect
- **Calibration** — fan threshold, advanced heater phase flow (DE1 settings)
- **Skin** — presence-based auto-sleep with configurable schedule; wake-lock toggle
- **Display** — brightness control and auto-brightness toggle; screen saver toggle
- **Language** — multi-language support via CSV-based i18n; runtime language switching
- **Extensions** — Decent Visualizer integration (toggle + credentials)
- **REA Settings** — weight/volume flow multipliers; gateway mode selection
- **User Manual** — links to Decent Espresso support, quickstart, and skin dev docs

### UI & UX
- Light/dark theme (persisted in `localStorage`)
- Responsive scaling for landscape tablets and mobile
- Rotation prompt for portrait devices
- Long-press support on +/− buttons for rapid value adjustment

---

## Coming Soon

### Settings — Unimplemented Functions
- [ ] Quick Adjustments: Flow Multiplier, Steam, Water, Limit save buttons
- [ ] Calibration: Reset defaults, Refill Kit calibrate, Voltage / Fan / Stop-at-Weight / Steam save, Slow Start dropdown
- [ ] Maintenance: Descaling Start, Transport Mode dropdown
- [ ] Skin: Theme toggle, Skin Apply button
- [ ] Miscellaneous: Screen Saver, Units, Font Size, Resolution, Smart Charging dropdowns
- [ ] Updates: Firmware Check, App Update Check buttons
- [ ] Bluetooth: Machine auto-connect (scale auto-connect already works)

### Features
- [ ] Advanced in-browser profile editor (create and edit profiles, not just upload/delete)

---

## Getting Started

**Prerequisites:** [reaprime (Streamline-Bridge)](https://github.com/tadelv/reaprime) must be running and accessible on `localhost:8080`.

```bash
# Clone the repo
git clone <repo-url>
cd streamline_js

# Serve from the repo root — no build step required
python3 -m http.server
```

Open `http://localhost:8000` in your browser.

**Custom hostname:** If reaprime runs on a different host, set it before loading the app:

```js
localStorage.setItem('reaHostname', '192.168.1.x:8080')
```

---

## Project Structure

```
src/
├── modules/
│   ├── api.js              # All REST + WebSocket I/O; MachineState enum
│   ├── app.js              # Bootstrap, global state, WebSocket wiring
│   ├── ui.js               # DOM update functions
│   ├── chart.js            # Plotly real-time shot graph
│   ├── profileManager.js   # Profile CRUD
│   ├── profile_selector.js # Profile browser UI
│   ├── history.js          # Shot history (IndexedDB + API)
│   ├── shotData.js         # Shot metric display
│   ├── waterTank.js        # Water level WebSocket
│   ├── router.js           # SPA sub-page loader
│   ├── numpad-modal.js     # Mobile numeric input
│   ├── scaling.js          # Responsive scaling / orientation
│   ├── i18n.js             # CSV-based translations
│   └── idb.js              # IndexedDB wrapper
├── settings/               # Settings page HTML + JS
├── profiles/               # Bundled example profiles (JSON)
├── css/                    # main.css, dark-mode.css, numpad-modal.css
└── ui/                     # Fonts, icons, images
```

---

## Contributing

See `CLAUDE.md` for coding conventions, API reference (`reaprime_api.md`), and the design system (`DESIGN_SYSTEM.md`).

Key rules:
- Tailwind + daisyUI only — no custom CSS unless unavoidable
- Use `Plotly.update()`, not `Plotly.react()`, for chart updates
- Profile changes must go through the workflow API wrapper in `api.js`
- IndexedDB writes must be atomic

# Copilot Instructions for streamline_project

## Project Overview
This is a modern web app rewrite of the Decent Espresso machine's Streamline skin. It communicates with Decaid to control the espresso machine and display real-time data.

## Architecture

### Core Components
- `src/modules/api.js`: WebSocket and REST API communication with Decaid (port 8080)
- `src/modules/app.js`: Main application logic and state management
- `src/modules/chart.js`: Real-time data visualization using Plotly
- `src/modules/history.js`: Shot history management with IndexedDB storage
- `src/modules/ui.js`: UI updates and event handlers

### Key Data Flows
1. Real-time machine data:
   ```js
   WebSocket(ws/v1/de1/snapshot) -> handleData() -> updateChart() & UI updates
   ```
2. Profile/workflow management:
   ```js
   REST API(/api/v1/workflow) <-> loadInitialData() -> UI updates
   ```

## Project Conventions

### UI/Styling
- Uses TailwindCSS + DaisyUI for styling
- No custom CSS unless absolutely necessary
- Theme colors via DaisyUI's data-theme="light"
- Custom font: 'Inter' from local files in `src/ui/`

### API Integration
- Base URL: `http://${hostname}:8080/api/v1`
- WebSocket path: `ws/v1/de1/snapshot`
- Keep `REA_PORT` constant in sync with middleware
- Always use reconnecting WebSocket for reliability

### State Management
- Machine state tracked via `isDe1Connected` and `isScaleConnected`
- Shot timing via `shotStartTime` in app.js
- Connection health monitored via `resetDataTimeout()` and `resetScaleDataTimeout()`
- Data persisted in IndexedDB for shot history

### Data Visualization
- Chart data format:
  ```js
  {
    x: [timestamps],
    y: [values],
    name: 'metric',
    type: 'scatter',
    line: { color: '#hex', dash: 'style' }
  }
  ```
- Standard metrics: pressure, flow, groupTemperature
- Both actual and target values plotted

## Development Workflow
1. Always start with `chart.initChart()` and `ui.initUI()`
2. Load initial data via `loadInitialData()`
3. Establish WebSocket connections with error handling
4. Update UI in response to data events
5. Persist shot data after completion

## Common Gotchas
- Scale readings need throttling to prevent UI flicker
- WebSocket reconnection resets machine connection status
- Chart updates must maintain exact array lengths
- Profile updates require workflow API call wrapper
- History updates must be atomic with IndexedDB

## Reference Files
- `rest_v1.yml` and `websocket_v1.yml`: Repository-local Decaid API contracts
- [Decaid API documentation](https://github.com/decentespresso/decaid/blob/main/doc/Api.md): Current backend reference
- `DESIGN_SYSTEM.md`: UI/UX guidelines
- `GEMINI.md`: Project goals and requirements

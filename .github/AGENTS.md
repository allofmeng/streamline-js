# AGENTS.md - Agent Guidelines for Streamline Project

## Project Overview

Modern web app rewrite of the Decent Espresso machine's Streamline skin. Communicates with Decaid to control the espresso machine and display real-time data.

### Tech Stack
- **Language:** Vanilla JavaScript (ES6+)
- **Styling:** Tailwind CSS + daisyUI
- **Charting:** Plotly.js
- **Storage:** IndexedDB for shot history
- **Communication:** WebSocket + REST API

---

## Commands

### Running the Application
```bash
# Python 3
python -m http.server 8000

# Or Node.js
npx serve -p 8000
```
Access: `http://localhost:8000` | Ensure Decaid runs on port 8080

### Testing
No test framework configured. To add tests:
1. `npm init -y && npm install vitest --save-dev`
2. Create `.test.js` files in `src/modules/`
3. Run: `npx vitest run` (single test: `npx vitest run testName`)

Manual testing: Browser DevTools (F12) > Console + Network tabs

### Linting
No formal linting. Use VSCode ESLint extension or run: `npx eslint src/modules/`

---

## Code Style Guidelines

### General Principles
1. **Reduce redundant code** - Reuse existing code before writing new
2. **Single Responsibility** - Each module/function does one thing
3. **State-Driven UI** - Use `appState` as single source of truth

### JavaScript Conventions

**Imports/Exports:**
```javascript
import { function1 } from './module.js';
import * as chartModule from './chart.js';
window.handleFunction = handleFunction;  // For global access
```

**Naming:** Functions: `camelCase`, Constants: `UPPER_SNAKE_CASE`, Classes: `PascalCase`, Private: `_internalFunction()`

**Functions:**
```javascript
const handler = (data) => data.map(item => item.value);
async function fetchData() {
    try { return await api.getWorkflow(); }
    catch (error) { logger.error('Fetch failed:', error); throw error; }
}
```

### Error Handling
```javascript
try { await someAsyncOperation(); }
catch (error) { logger.error('Operation failed:', error); }
```

### Logging
```javascript
import { logger, setDebug } from './logger.js';
logger.debug('Debug info');   // Only when debug enabled
logger.info('Status'); logger.warn('Warning'); logger.error('Error');
setDebug(true);
```

### State Management
```javascript
const appState = { settings: {}, machine: { state: 'idle' }, shot: { startTime: null } };
function render() { ui.updateMachineStatus(); ui.updateChart(); }
```

### DOM Manipulation
- Use `id` attributes for frequent updates, cache DOM references
- Event delegation for dynamic elements

```javascript
const elements = { statusText: document.getElementById('status-text') };
document.getElementById('shot-list').addEventListener('click', (e) => {
    if (e.target.classList.contains('shot-item')) handleShotClick(e.target.dataset.id);
});
```

### Styling
1. **Use Tailwind CSS** - Prefer utilities over custom CSS
2. Only add custom CSS in `src/css/` when necessary
3. **Theme colors:** Primary `#385A92`, Success `#0CA581`
4. **Dark/Light mode:** CSS custom properties on `<body>`

```html
<button class="btn btn-primary">Connect</button>
<body data-theme="light"> or <body data-theme="dark">
```

### API Communication
```javascript
const REA_BASE_URL = `http://${hostname}:8080/api/v1`;
const WS_PATH = 'ws/v1/machine/snapshot';
// Use reconnecting-websocket.js for reliability
```

### Performance
- **Chart:** Use `Plotly.update()` not `Plotly.react()`
- **Scale:** Throttle readings to prevent flicker
- **WebSocket:** Handle reconnection gracefully

---

## Key Modules
| Module | Purpose |
|--------|---------|
| `api.js` | WebSocket + REST API |
| `app.js` | Main logic, state |
| `chart.js` | Plotly charting |
| `ui.js` | UI updates |
| `history.js` | IndexedDB shots |
| `router.js` | SPA routing |
| `idb.js` | IndexedDB wrapper |

---

## Reference Files
- `DESIGN_SYSTEM.md` - UI/UX tokens
- `GEMINI.md` - Gemini AI instructions
- `QWEN.md` - Qwen AI instructions  
- `rest_v1.yml` and `websocket_v1.yml` - local API contracts
- [Decaid API documentation](https://github.com/decentespresso/decaid/blob/main/doc/Api.md) - current backend reference
- `.github/copilot-instructions.md` - Copilot rules
- `SKILL.md` - Clean code reviewer skill

---

## Code Review Skill
Use **clean-code-reviewer** skill (SKILL.md) when reviewing code:
1. Analyze redundancies vs existing modules
2. Identify simplification opportunities
3. Check clean code principles
4. Suggest refactoring techniques
5. Recommend tests based on functionality
6. Point out performance/maintainability concerns

---

## Common Gotchas
- Scale readings need throttling
- WebSocket reconnection resets connection status
- Chart updates must maintain exact array lengths
- Profile updates require workflow API call
- History updates must be atomic with IndexedDB
- SPA page jumps - ensure functions work across routes

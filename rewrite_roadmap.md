# Roadmap: Rewriting DE1 Streamline Skin to a Web Application

This document outlines a strategic roadmap for rewriting the Tcl-based "Streamline" skin for the DE1 application into a modern web application using HTML, CSS, and JavaScript.

## 1. Project Overview

The goal is to create a web-based equivalent of the Streamline skin, offering a modern, responsive, and maintainable user interface for interacting with the Decent Espresso machine. This involves replicating the existing UI components, data visualizations, and user interactions in a standard web technology stack.

The primary challenges are:
1.  **Real-time Data Communication:** Establishing a connection between the web browser and the DE1 machine to send commands and receive live data.
2.  **UI/UX Modernization:** Translating the fixed-resolution Tcl layout into a responsive design that works across various devices.
3.  **Feature Parity:** Ensuring all functionalities from the original skin are implemented.

## 2. Recommended Technology Stack

### Frontend (UI)
*   **HTML:** The standard for structuring the web application.
*   **CSS:** We will be using **Tailwind CSS** for styling. It will help us create a responsive and themeable (light/dark) layout with utility-first classes.
*   **JavaScript:** The core logic of the application.
    *   **Vanilla JS (ES6+ Modules):** For a dependency-free approach. This is feasible but requires careful code organization.
    *   **A Modern Framework (Recommended):** Libraries like **React**, **Vue**, or **Svelte** are highly recommended. They simplify managing complex UIs, state changes, and component logic, leading to a more robust and maintainable application. This roadmap will assume a component-based approach, which fits well with these frameworks.

### Charting
*   We will use **Plotly.js** to render the real-time espresso shot graphs (pressure, flow, temperature).

### Data Communication (The Critical Part)
The Tcl script communicates directly with the machine's backend. A web application cannot do this directly. To solve this, we will use **Decaid**, which acts as the communication app between the web app and the Decent Espresso machine. It connects to the machine automatically and serves its data via WebSocket and REST APIs.

*   **Decaid:** This tool acts as a bridge between the espresso machine and our web application. It can be found at `https://github.com/decentespresso/decaid.git`.
*   **Decaid API:** Our JavaScript code will connect to Decaid's WebSocket and REST API server. This will be the primary way to receive real-time data (like temperature and pressure) and send commands (like start and stop) to the machine. The contracts are documented in `rest_v1.yml` and `websocket_v1.yml`.

## 3. Development Roadmap

This roadmap is broken down into phases.

### Phase 1: Project Setup & Foundation

1.  **Basic File Structure:**
    *   `index.html`: The main HTML file.
    *   `css/`: A directory for stylesheets.
        *   `style.css`: Main stylesheet.
        *   `theme.css`: For color variables (light/dark modes).
    *   `js/`: A directory for JavaScript files.
        *   `main.js`: The main application entry point.
        *   `components/`: Directory for UI components.
        *   `de1-api.js`: A dedicated module for all WebSocket communication with the `reaprime` server.
    *   `fonts/`: Directory for the font files (`Inter`, `NotoSansMono`, etc.).

2.  **CSS Foundation:**
    *   In `theme.css`, define all colors from the Tcl script as CSS variables under a `:root` selector for the light theme and a `.dark-mode` class for the dark theme.
    *   In `style.css`, use `@font-face` rules to import the custom fonts.
    *   Set up a basic layout using CSS Grid or Flexbox to create the main regions (e.g., left sidebar, main content, header).

### Phase 2: Data Communication Layer

1.  **Create the DE1 API Module (`de1-api.js`):**
    *   Implement functions to handle the WebSocket connection lifecycle: `connect()`, `disconnect()`.
    *   Write functions to send commands to the machine over the WebSocket connection (e.g., `startEspresso()`, `stop()`, `setTemperature(t)`).
    *   Implement a message handler to process incoming data from the WebSocket.
    *   Implement "listener" or "event subscription" functions (e.g., `onStateUpdate(callback)`) that will be triggered when new data is received from the WebSocket, allowing other parts of the application to react to state changes.

### Phase 3: UI Component Development (Static)

Translate the UI elements from the Tcl script into reusable JavaScript components. At this stage, focus on their appearance, not their functionality.

1.  **Component Creation (`js/components/`):**
    *   `DataCard.js`: For displaying key-value data (e.g., "Mix Temp", "Group Temp").
    *   `ActionButton.js`: For the main actions (Espresso, Steam, Flush).
    *   `SettingsInput.js`: For the inputs on the left (Grind, Dose, Temp).
    *   `ShotChart.js`: A component that renders a `<canvas>` element for the chart.
    *   `ProfileSelector.js`: For the profile selection UI.

2.  **Build the Static UI:**
    *   In `main.js`, import these components and assemble the main application layout. Populate the screen with static, hardcoded data to match the look of the original skin.

### Phase 4: State Management & Interactivity

This is where the application comes to life.

1.  **Global State Management:**
    *   Create a central state object in your JavaScript. This object will hold all the dynamic data, such as machine temperatures, pressures, the current shot profile, UI settings, etc.
    *   When your `de1-api.js` module receives data, it should update this global state.

2.  **Connect UI to State:**
    *   Create an "update" or "render" function that gets called whenever the state changes. This function will re-render the necessary UI components with the new data. (A framework like React or Vue handles this automatically).
    *   For example, when `state.groupHeadTemp` is updated, the `DataCard` component for the group head temperature should automatically display the new value.

3.  **Implement User Actions:**
    *   Wire up the UI buttons. A click on the "Flush" button should call the `startFlush()` function in your `de1-api.js` module.
    *   When a user changes a setting (e.g., brew temperature), update the state and call the appropriate function in `de1-api.js` to send the new setting to the machine.

4.  **Implement the Chart:**
    *   As shot data (pressure, flow, etc.) arrives during an espresso pull, store it in an array within your state object.
    *   Pass this array to your `ShotChart` component and use the charting library to draw and update the graph in real-time.

### Phase 5: Final Features & Refinement

1.  **Page/View Navigation:**
    *   The original skin has different "pages" (`off`, `espresso`, `steam`). Implement a simple view manager in JavaScript that shows/hides the correct UI containers based on the machine's current state.

2.  **Responsive Design:**
    *   Use CSS media queries to adapt the layout for different screen sizes, from mobile phones to large desktop monitors. This will be a significant improvement over the original fixed-size skin.

3.  **Local History & Settings:**
    *   Use the browser's `localStorage` to save user settings (like preferred theme, favorite profiles) and shot history, similar to how the Tcl version uses the file system.

4.  **Testing and Debugging:**
    *   Thoroughly test all UI interactions and data flows. Browser developer tools will be essential for debugging both the UI and the Web Bluetooth communication.





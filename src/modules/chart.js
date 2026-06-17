import { logger } from './logger.js';
import { getTranslation } from './i18n.js';

// Maps internal trace key → i18n key used for the chart label.
const LABEL_KEYS = {
    pressure: 'Pressure',
    flow: 'Flow',
    groupTemperature: 'Temperature',
    weight: 'Weight'
};

function getLabelText(traceName, fallback) {
    const key = LABEL_KEYS[traceName];
    return key ? getTranslation(key) : fallback;
}

// Define colors for step markers
const STEP_MARKER_COLORS = {
    dark: '#7f8bbb',
    light: '#7c7c7c'
};

// Function to get or update the chart element reference
function getChartElement() {
    const mainPage = document.getElementById('main-page');
    if (mainPage && mainPage.style.display === 'none') {
        const subpageHost = document.getElementById('subpage-host');
        const el = subpageHost?.querySelector('#plotly-chart');
        if (el) return el;
    }
    return document.getElementById('plotly-chart');
}
let currentSubstate = 'idle';
let previousSubstateForShape = 'idle'; // To track step changes for vertical lines
let annotationUpdateCounter = 0;
const ANNOTATION_UPDATE_THROTTLE = 10; // Update every 10 data points
let lastWeight = 0;
let lastTime = 0;
const SMOOTHING_FACTOR = 0.1;
let smoothedWeightChange = 0;

// Base chart data with light mode defaults
const baseChartData = {
    pressure: {
        x: [],
        y: [],
        name: 'Pressure',
        type: 'lines',
        mode: 'lines',
        line: { color: '#17c29a' },
        hoverinfo: 'name'
    },
    flow: {
        x: [],
        y: [],
        name: 'Flow',
        type: 'lines',
        mode: 'lines',
        line: { color: '#0358cf' },
        hoverinfo: 'name'
    },
    targetPressure: {
        x: [],
        y: [],
        name: 'Target Pressure',
        type: 'lines',
        mode: 'lines',
        line: { color: '#bde2d5', dash: 'dot' },
        hoverinfo: 'name'
    },
    targetFlow: {
        x: [],
        y: [],
        name: 'Target Flow',
        type: 'lines',
        mode: 'lines',
        line: { color: '#cdd9f5', dash: 'dot' },
        hoverinfo: 'name'
    },
    groupTemperature: {
        x: [],
        y: [],
        name: '°C',
        type: 'lines',
        mode: 'lines',
        line: {color: '#ff97a1'},
        hoverinfo: 'name'
    },
    targetTemperature: {
        x: [],
        y: [],
        name: 'Target °C',
        type: 'lines',
        mode: 'lines',
        line: { color: '#F9ebec', dash: 'dot' },
        hoverinfo: 'name'
    },
    weight: {
        x: [],
        y: [],
        name: 'Weight',
        type: 'lines',
        mode: 'lines',
        line: { color: '#D8BDA8' }, // light mode
        hoverinfo: 'name'
    }
};

// Create chartData with initial values
const chartData = JSON.parse(JSON.stringify(baseChartData));

const baseLayout = {
    plot_bgcolor: '#0d0e14',
    paper_bgcolor: '#0d0e14',
    font: { color: '#606579', size: 20 },
    shapes: [], // Initialize shapes array for vertical lines
    xaxis: {
        gridcolor: '#3D4255',
        linecolor: '#606579',
        tickcolor: '#606579',
        dtick: 1,
        fixedrange: true
    },
    yaxis: {
        gridcolor: '#3D4255',
        linecolor: '#606579',
        tickcolor: '#606579',
        range: [0, 10],
        dtick: 1,
        fixedrange: true
    },
    autosize: true,
    margin: {
        autoexpand: true,
        l: 50,
        r: 50,
        t: 20,
        b: 40,
        pad: 0
    },
    showlegend: false,
};

const lightLayout = {
    ...baseLayout,
    plot_bgcolor: 'white',
    paper_bgcolor: 'white',
    font: { color: '#959595', size: 20 },
    xaxis: {
        ...baseLayout.xaxis,
        gridcolor: '#E0E0E0',
        linecolor: '#959595',
        tickcolor: '#959595'
    },
    yaxis: {
        ...baseLayout.yaxis,
        gridcolor: '#E0E0E0',
        linecolor: '#959595',
        tickcolor: '#959595'
    }
};

const darkLayout = { ...baseLayout };

const labelColors = {
    light: {
        pressure: '#17c29a',
        flow: '#0358cf',
        groupTemperature: '#ff97a1',
        weight: '#C7A58D'
    },
    dark: {
        pressure: '#17c29a',
        flow: '#0358cf',
        groupTemperature: '#AE6D73',
        weight: '#695f57'
    }
};

const LABEL_FONT_SIZE = 16;
const LABEL_FONT_CSS = `${LABEL_FONT_SIZE}px Inter, sans-serif`;
const LABEL_X_GAP = 6;     // px between line end and label text
const LABEL_X_PAD = 10;    // px breathing room past the widest label

let _measureCanvasCtx = null;
function measureTextWidth(text) {
    if (!_measureCanvasCtx) {
        const canvas = document.createElement('canvas');
        _measureCanvasCtx = canvas.getContext('2d');
    }
    _measureCanvasCtx.font = LABEL_FONT_CSS;
    return _measureCanvasCtx.measureText(text).width;
}

// Plot pixel width (between left and right margin). Falls back to a sensible
// default when the chart element is hidden or hasn't been measured yet —
// returning a tiny value here would blow up `rangeMaxForLabels`.
const DEFAULT_PLOT_PX_WIDTH = 1360; // baseline 1460 chart - margin.l(50) - margin.r(50)
function getPlotPixelWidth() {
    const element = getChartElement();
    const cssWidth = element ? element.clientWidth : 0;
    const usable = cssWidth - 100; // baseLayout margin.l + margin.r
    return usable > 200 ? usable : DEFAULT_PLOT_PX_WIDTH;
}

const DEFAULT_PLOT_PX_HEIGHT = 590; // baseline 650 chart - margin.t(20) - margin.b(40)
function getPlotPixelHeight() {
    const element = getChartElement();
    const cssHeight = element ? element.clientHeight : 0;
    const usable = cssHeight - 60;
    return usable > 100 ? usable : DEFAULT_PLOT_PX_HEIGHT;
}

const MIN_LABEL_SEP_PX = LABEL_FONT_SIZE + 2; // minimum vertical gap between label centers
const BOTTOM_EDGE_PAD_PX = 8;

// Y-axis is fixed [0, 10]. Returns label's natural pixel offset from plot top.
function dataYToPixelY(y, plotPxHeight) {
    return (10 - y) / 10 * plotPxHeight;
}

// Push labels apart vertically when they collide. Mutates `annotations` by
// setting `yshift` (negative px = moved DOWN from the trace endpoint).
function applyLabelCollisionAvoidance(annotations) {
    if (annotations.length < 2) return;
    const plotPxH = getPlotPixelHeight();
    const maxPxY = plotPxH - BOTTOM_EDGE_PAD_PX;

    const items = annotations.map(a => ({
        annotation: a,
        naturalPxY: dataYToPixelY(a.y, plotPxH)
    }));
    items.sort((a, b) => a.naturalPxY - b.naturalPxY); // top → bottom

    let prevPxY = -Infinity;
    for (const item of items) {
        let desired = Math.max(item.naturalPxY, prevPxY + MIN_LABEL_SEP_PX);
        if (desired > maxPxY) desired = maxPxY;
        const shiftDownPx = desired - item.naturalPxY;
        if (shiftDownPx > 0) item.annotation.yshift = -shiftDownPx;
        prevPxY = desired;
    }
}

// Given the data's x-max, return the range max that leaves room for the widest
// (translated) label INSIDE the plot area. Solved from
//   range = dataMax + labelPx * (range - rangeMin) / plotPxWidth
function rangeMaxForLabels(dataMax, rangeMin = 0) {
    let maxLabelPx = 0;
    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        if (trace.x.length === 0) continue;
        const w = measureTextWidth(getLabelText(traceName, trace.name));
        if (w > maxLabelPx) maxLabelPx = w;
    }
    if (maxLabelPx === 0) return dataMax;
    const padPx = maxLabelPx + LABEL_X_GAP + LABEL_X_PAD;
    const plotPxWidth = getPlotPixelWidth();
    const factor = Math.max(0.05, 1 - padPx / plotPxWidth);
    return rangeMin + (dataMax - rangeMin) / factor;
}

function getAnnotations() {
    const theme = localStorage.getItem('theme') || 'light';
    const annotations = [];

    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        if (trace.x.length === 0) continue;

        annotations.push({
            x: trace.x[trace.x.length - 1],
            y: trace.y[trace.y.length - 1],
            xref: 'x',
            yref: 'y',
            text: getLabelText(traceName, trace.name),
            showarrow: false,
            xanchor: 'left',
            yanchor: 'middle',
            xshift: LABEL_X_GAP,
            font: {
                color: (labelColors[theme] && labelColors[theme][traceName]) ? labelColors[theme][traceName] : trace.line.color,
                size: LABEL_FONT_SIZE
            }
        });
    }

    applyLabelCollisionAvoidance(annotations);
    return annotations;
}

// Apply current labels + restore default right margin. Use before
// Plotly.newPlot / Plotly.react.
function applyLabelLayout(layout) {
    layout.annotations = getAnnotations();
    layout.margin = { ...(layout.margin || {}), r: 50 };
}

// Re-measure labels and refresh annotations + x-range so labels stay inside
// the plot area after the chart width changes (e.g. GHC column toggling).
export function refreshLabelMargin() {
    const element = getChartElement();
    if (!element) return;

    // Find current data max across labelled traces.
    let dataMax = 0;
    for (const traceName in chartData) {
        if (traceName === 'targetPressure' || traceName === 'targetFlow' || traceName === 'targetTemperature') continue;
        const trace = chartData[traceName];
        if (trace.x.length === 0) continue;
        const lastX = trace.x[trace.x.length - 1];
        if (lastX > dataMax) dataMax = lastX;
    }
    if (dataMax === 0) {
        // idle / cleared chart — let Plotly autoscale, don't pin a max.
        Plotly.relayout(element, {
            annotations: getAnnotations(),
            'xaxis.autorange': true
        });
        return;
    }

    const rangeMax = rangeMaxForLabels(dataMax);
    Plotly.relayout(element, {
        annotations: getAnnotations(),
        'xaxis.range': [0, rangeMax],
        'xaxis.autorange': false
    });
}

// Helper function to add vertical lines for substate changes and annotations
function addStepMarker(layout, time, theme, stepName = '') {
    if (!layout.shapes) {
        layout.shapes = [];
    }
    layout.shapes.push({
        type: 'line',
        x0: time,
        x1: time,
        y0: 0,
        y1: 1,
        yref: 'paper',
        line: {
            color: theme === 'dark' ? STEP_MARKER_COLORS.dark : STEP_MARKER_COLORS.light, // ::state_change_color from skin.tcl
            width: 2,
            dash: 'longdash' // ::state_change_dashes from skin.tcl is dot equivalent
        }
    });

   
}

// Global variable to store the current profile for real-time step change detection
let currentProfile = null;
let liveProfileFrame = -1; // Track current profileFrame for live data
// let currentStepIndex = 0; // No longer needed for this logic
// let stepExitDetected = false; // No longer needed for this logic

// Store pending updates to batch them for better performance
let pendingUpdates = {
    shapes: null,
    annotations: null
};

export function setCurrentProfile(profile) {
    currentProfile = profile;
    resetProfileTracking(); // Encapsulate the reset logic
}

function resetProfileTracking() {
    liveProfileFrame = -1;
    // Reset any other tracking variables if needed
}

// Helper function to handle profile frame changes
function handleProfileFrameChange(currentFrame, time, profile, theme) {
    if (!profile || !profile.steps || currentFrame === undefined || currentFrame === null) {
        return false;
    }
    
    let stepMarkerAdded = false;
    
    // Handle first step detection (when starting a new shot)
    if (liveProfileFrame === -1) {
        // If first data has profileFrame > 0, draw markers for all skipped steps at time 0
        if (currentFrame > 0) {
            for (let i = 0; i < currentFrame && i < profile.steps.length; i++) {
                const stepName = profile.steps[i].name;
                const layout = theme === 'dark' ? darkLayout : lightLayout;
                addStepMarker(layout, 0, theme, stepName);
            }
        }
        // Draw marker for the current step at time 0 (shot start)
        // This ensures the first step marker is always at x=0, even if profileFrame
        // data arrives late (e.g., first data point doesn't have profileFrame set)
        const stepName = profile.steps[currentFrame].name;
        const layout = theme === 'dark' ? darkLayout : lightLayout;
        addStepMarker(layout, 0, theme, stepName);

        liveProfileFrame = currentFrame;
        stepMarkerAdded = true;
    } else if (currentFrame !== liveProfileFrame && currentFrame >= 0 && currentFrame < profile.steps.length) {
        // Normal step change during the shot
        const stepName = profile.steps[currentFrame].name;
        const layout = theme === 'dark' ? darkLayout : lightLayout;
        addStepMarker(layout, time, theme, stepName);
        liveProfileFrame = currentFrame;
        stepMarkerAdded = true;
    }
    
    return stepMarkerAdded;
}

// Function to apply pending updates to the chart
function applyPendingUpdates() {
    if (pendingUpdates.shapes || pendingUpdates.annotations) {
        const element = getChartElement();
        if (element) {
            Plotly.relayout(element, {
                shapes: pendingUpdates.shapes,
                annotations: pendingUpdates.annotations
            });
        }
        // Reset pending updates
        pendingUpdates = { shapes: null, annotations: null };
    }
}

export function updateChart(shotStartTime, data, weight, filterToPouring = true) {
    if (data && data.state && data.state.substate) {
        currentSubstate = data.state.substate;
    }

    const time = (new Date(data.timestamp) - shotStartTime) / 1000;
    const theme = localStorage.getItem('theme') || 'light';
    let stepMarkerAdded = false;

    // New logic: Add vertical line and annotation at the start of each step based on profileFrame
    if (currentProfile && currentProfile.steps && data.profileFrame !== undefined && data.profileFrame !== null) {
        // logger.debug(`updateChart: profileFrame=${data.profileFrame}, time=${time.toFixed(2)}s, liveProfileFrame=${liveProfileFrame}, substate=${data.state.substate}`);
        if (handleProfileFrameChange(data.profileFrame, time, currentProfile, theme)) {
            stepMarkerAdded = true;
            // logger.debug(`updateChart: step marker added at time=${time.toFixed(2)}s`);
        }
    } else if (currentProfile && currentProfile.steps) {
        // Log when profileFrame is missing (helps debug late-arriving profileFrame data)
        logger.debug(`updateChart: NO profileFrame (is ${data.profileFrame}), time=${time.toFixed(2)}s, liveProfileFrame=${liveProfileFrame}, substate=${data.state.substate}`);
    } else if (!currentProfile) {
        logger.debug(`updateChart: NO currentProfile set, time=${time.toFixed(2)}s, substate=${data.state.substate}`);
    }


    if (filterToPouring) {
        const espressoStates = ['preinfusion', 'pouring'];
        if (!espressoStates.includes(data.state.substate)) {
            return;
        }
    }
    const pressureY = data.pressure;
    const flowY = data.flow;
    const targetPressureY = data.targetPressure;
    const targetFlowY = data.targetFlow;
    const groupTemperatureY = (data.groupTemperature / 100) * 10;

    let weightY = 0;
    if (lastTime > 0 && time > lastTime) {
        const timeDiff = time - lastTime;
        const rawWeightChange = (weight - lastWeight) / timeDiff;
        smoothedWeightChange = (SMOOTHING_FACTOR * rawWeightChange) + (1 - SMOOTHING_FACTOR) * smoothedWeightChange;
        weightY = smoothedWeightChange;
    }
    lastWeight = weight;
    lastTime = time;

    const isFirstDataPoint = chartData.pressure.x.length === 0;

    chartData.pressure.x.push(time);
    chartData.pressure.y.push(pressureY);
    chartData.flow.x.push(time);
    chartData.flow.y.push(flowY);
    chartData.targetPressure.x.push(time);
    chartData.targetPressure.y.push(targetPressureY);
    chartData.targetFlow.x.push(time);
    chartData.targetFlow.y.push(targetFlowY);
    chartData.groupTemperature.x.push(time);
    chartData.groupTemperature.y.push(groupTemperatureY);
    chartData.weight.x.push(time);
    chartData.weight.y.push(weightY);

    const element = getChartElement();
    if (!element) {
        console.error('updateChart: chartElement not found in DOM');
        return;
    }
    let dtickValue;
    if (time < 15) {
        dtickValue = 1;
    } else if (time < 60) {
        dtickValue = 5;
    } else if (time < 100) {
        dtickValue = 20;
    } else {
        dtickValue = 30;
    }

    Plotly.extendTraces(element, {
        x: [[time], [time], [time], [time], [time], [time]],
        y: [[pressureY], [flowY], [targetPressureY], [targetFlowY], [groupTemperatureY], [weightY]]
    }, [0, 1, 2, 3, 4, 5]);

    // Manage x-range manually so labels (right of each line's last point) stay
    // INSIDE the plot area instead of being clipped at the right edge.
    const rangeMax = rangeMaxForLabels(time);

    // If a step marker was added, we need to use Plotly.react to update shapes
    if (stepMarkerAdded) {
        const layout = theme === 'dark' ? darkLayout : lightLayout;
        applyLabelLayout(layout);
        Plotly.react(element, Object.values(chartData), layout);
        Plotly.relayout(element, {
            'xaxis.range': [0, rangeMax],
            'xaxis.autorange': false,
            'xaxis.dtick': dtickValue
        });
    } else {
        // Throttle annotation refresh so we don't relayout on every tick.
        annotationUpdateCounter++;
        const relayoutPayload = {
            'xaxis.range': [0, rangeMax],
            'xaxis.autorange': false,
            'xaxis.dtick': dtickValue
        };
        if (isFirstDataPoint || annotationUpdateCounter % 10 === 0) {
            relayoutPayload.annotations = getAnnotations();
        }
        Plotly.relayout(element, relayoutPayload);
    }
}

export function clearChart() {
    // Clear all chart data arrays
    for (const trace in chartData) {
        chartData[trace].x = [];
        chartData[trace].y = [];
    }
    
    // Reset all tracking variables
    lastWeight = 0;
    lastTime = 0;
    smoothedWeightChange = 0;
    previousSubstateForShape = 'idle';
    liveProfileFrame = -1;  // FIX: Reset profile frame tracking
    currentSubstate = 'idle';  // FIX: Reset substate
    annotationUpdateCounter = 0;  // FIX: Reset counter
    
    // Clear shapes and annotations from BOTH layouts
    // This prevents issues when theme is switched between shots
    darkLayout.shapes = [];
    lightLayout.shapes = [];
    darkLayout.annotations = [];
    lightLayout.annotations = [];
    
    const theme = localStorage.getItem('theme') || 'light';
    const layout = theme === 'dark' ? darkLayout : lightLayout;

    const element = getChartElement();
    if (!element) {
        console.error('clearChart: chartElement not found in DOM');
        return;
    }
    Plotly.react(element, Object.values(chartData), layout);
    Plotly.relayout(element, { 'xaxis.autorange': true });
}

export function plotHistoricalShot(measurements, workflow = null) {
    if (!measurements || measurements.length === 0) {
        clearChart();
        return;
    }

    clearChart();

    let shotStartTime = null;

    for (const dataPoint of measurements) {
        const machineData = dataPoint.machine;
        if (machineData && machineData.state && (machineData.state.substate === 'preinfusion' || machineData.state.substate === 'pouring' )) {
            shotStartTime = new Date(machineData.timestamp);
            break;
        }
    }

    if (!shotStartTime) {
        console.warn("plotHistoricalShot: Could not find a starting data point (preinfusion/pouring) to begin the chart at t=0.");
        const firstPoint = measurements.find(p => (p.machine && p.machine.timestamp) || (p.scale && p.scale.timestamp));
        if (firstPoint) {
            const machineTs = firstPoint.machine && new Date(firstPoint.machine.timestamp);
            const scaleTs = firstPoint.scale && new Date(firstPoint.scale.timestamp);
            shotStartTime = (machineTs && scaleTs) ? (machineTs < scaleTs ? machineTs : scaleTs) : (machineTs || scaleTs);
        } else {
            console.error("plotHistoricalShot: No timestamps found in any measurements.");
            return;
        }
    }

    let shotEndTime = null;
    for (let i = measurements.length - 1; i >= 0; i--) {
        const machineData = measurements[i].machine;
        if (machineData && machineData.state && (machineData.state.substate === 'preinfusion' || machineData.state.substate === 'pouring')) {
            shotEndTime = new Date(machineData.timestamp);
            break;
        }
    }

    const tempChartData = {
        pressure: { x: [], y: [] },
        flow: { x: [], y: [] },
        targetPressure: { x: [], y: [] },
        targetFlow: { x: [], y: [] },
        groupTemperature: { x: [], y: [] },
        targetTemperature: { x: [], y: [] },
        weight: { x: [], y: [] }
    };

    let lastScaleWeight = 0;
    let lastScaleTime = 0;
    let localSmoothedWeightChange = 0;

    let historicalCurrentProfileFrame = -1; // Track current profileFrame for historical data

    // If workflow is provided, use step exit conditions for vertical lines
    if (workflow && workflow.profile && workflow.profile.steps) {
        const steps = workflow.profile.steps;
        const theme = localStorage.getItem('theme') || 'light';
        const layout = theme === 'dark' ? darkLayout : lightLayout;

        for (const dataPoint of measurements) {
            const machineData = dataPoint.machine;
            const scaleData = dataPoint.scale;

            if (machineData && machineData.state && machineData.state.substate) {
                const currentState = machineData.state.substate;
                const time = (new Date(machineData.timestamp) - shotStartTime) / 1000;

                // Only add data points during espresso phases
                if (currentState === 'preinfusion' || currentState === 'pouring') {
                    if (time >= 0) {
                        tempChartData.pressure.x.push(time);
                        tempChartData.pressure.y.push(machineData.pressure);
                        tempChartData.flow.x.push(time);
                        tempChartData.flow.y.push(machineData.flow);
                        tempChartData.targetPressure.x.push(time);
                        tempChartData.targetPressure.y.push(machineData.targetPressure);
                        tempChartData.targetFlow.x.push(time);
                        tempChartData.targetFlow.y.push(machineData.targetFlow);
                        tempChartData.groupTemperature.x.push(time);
                        tempChartData.groupTemperature.y.push((machineData.groupTemperature / 100) * 10);
                        tempChartData.targetTemperature.x.push(time);
                        tempChartData.targetTemperature.y.push((machineData.targetGroupTemperature / 100) * 10);
                    }

                    // New logic: Add vertical line and annotation at the start of each step based on profileFrame
                    if (machineData.profileFrame !== undefined && machineData.profileFrame !== null &&
                        machineData.profileFrame !== historicalCurrentProfileFrame &&
                        machineData.profileFrame >= 0 && machineData.profileFrame < steps.length) {
                        historicalCurrentProfileFrame = machineData.profileFrame;
                        const stepName = steps[machineData.profileFrame].name;
                        addStepMarker(layout, time, theme, stepName);
                    }
                }
            }


            if (scaleData && scaleData.weight) {
                const scaleTimestamp = new Date(scaleData.timestamp);
                if (shotEndTime && scaleTimestamp > shotEndTime) {
                    continue;
                }
                const time = (scaleTimestamp - shotStartTime) / 1000;
                if (time >= 0) {
                    let weightChange = 0;
                    if (lastScaleTime > 0 && time > lastScaleTime) {
                        const timeDiff = time - lastScaleTime;
                        const rawWeightChange = (scaleData.weight - lastScaleWeight) / timeDiff;
                        localSmoothedWeightChange = (SMOOTHING_FACTOR * rawWeightChange) + (1 - SMOOTHING_FACTOR) * localSmoothedWeightChange;
                        weightChange = localSmoothedWeightChange;
                    }
                    tempChartData.weight.x.push(time);
                    tempChartData.weight.y.push(weightChange);
                    lastScaleWeight = scaleData.weight;
                    lastScaleTime = time;
                }
            }
        }
    } else {
        // Fallback to original behavior if no workflow is provided
        // But only add data points, no vertical lines for substate changes
        for (const dataPoint of measurements) {
            const machineData = dataPoint.machine;
            const scaleData = dataPoint.scale;

            // Process machine data
            if (machineData && machineData.state && machineData.state.substate) {
                const currentState = machineData.state.substate;

                // Only add data points during espresso phases
                if (currentState === 'preinfusion' || currentState === 'pouring') {
                    const time = (new Date(machineData.timestamp) - shotStartTime) / 1000;
                    if (time >= 0) {
                        tempChartData.pressure.x.push(time);
                        tempChartData.pressure.y.push(machineData.pressure);
                        tempChartData.flow.x.push(time);
                        tempChartData.flow.y.push(machineData.flow);
                        tempChartData.targetPressure.x.push(time);
                        tempChartData.targetPressure.y.push(machineData.targetPressure);
                        tempChartData.targetFlow.x.push(time);
                        tempChartData.targetFlow.y.push(machineData.targetFlow);
                        tempChartData.groupTemperature.x.push(time);
                        tempChartData.groupTemperature.y.push((machineData.groupTemperature / 100) * 10);
                        tempChartData.targetTemperature.x.push(time);
                        tempChartData.targetTemperature.y.push((machineData.targetGroupTemperature / 100) * 10);
                    }
                }
            }

            if (scaleData && scaleData.weight) {
                const scaleTimestamp = new Date(scaleData.timestamp);
                if (shotEndTime && scaleTimestamp > shotEndTime) {
                    continue;
                }
                const time = (scaleTimestamp - shotStartTime) / 1000;
                if (time >= 0) {
                    let weightChange = 0;
                    if (lastScaleTime > 0 && time > lastScaleTime) {
                        const timeDiff = time - lastScaleTime;
                        const rawWeightChange = (scaleData.weight - lastScaleWeight) / timeDiff;
                        localSmoothedWeightChange = (SMOOTHING_FACTOR * rawWeightChange) + (1 - SMOOTHING_FACTOR) * localSmoothedWeightChange;
                        weightChange = localSmoothedWeightChange;
                    }
                    tempChartData.weight.x.push(time);
                    tempChartData.weight.y.push(weightChange);
                    lastScaleWeight = scaleData.weight;
                    lastScaleTime = time;
                }
            }
        }
    }

    Object.keys(tempChartData).forEach(key => {
        if(chartData[key]) {
            chartData[key].x = tempChartData[key].x;
            chartData[key].y = tempChartData[key].y;
        }
    });
    let maxTime = 0;
    for (const traceName in tempChartData) {
        const trace = tempChartData[traceName];
        if (trace.x && trace.x.length > 0) {
            const traceMaxTime = Math.max(...trace.x);
            if (traceMaxTime > maxTime) {
                maxTime = traceMaxTime;
            }
        }
    }
    let dtickValue;
    if (maxTime < 10) {
        dtickValue = 1;
    } else if (maxTime < 60) {
        dtickValue = 5;
    } else if (maxTime < 100) {
        dtickValue = 20;
    } else {
        dtickValue = 30;
    }

    const theme = localStorage.getItem('theme') || 'light';
    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);

    const element = getChartElement();
    if (!element) {
        console.error('plotHistoricalShot: chartElement not found in DOM');
        return;
    }
    Plotly.react(element, Object.values(chartData), layout, {displayModeBar: false});

    if (maxTime > 0) {
        const rangeMax = rangeMaxForLabels(maxTime);
        Plotly.relayout(element, {
            'xaxis.range': [0, rangeMax],
            'xaxis.autorange': false,
            'xaxis.dtick': dtickValue
        });
    } else {
        Plotly.relayout(element, {
            'xaxis.autorange': true,
            'xaxis.dtick': dtickValue
        });
    }
}

// Helper function to check if exit condition is met
function checkExitCondition(machineData, exitCondition) {
    if (!exitCondition || !machineData) return false;

    const { type, condition, value } = exitCondition;

    switch (type) {
        case 'pressure':
            if (condition === 'over') return machineData.pressure > value;
            if (condition === 'under') return machineData.pressure < value;
            break;
        case 'flow':
            if (condition === 'over') return machineData.flow > value;
            if (condition === 'under') return machineData.flow < value;
            break;
        case 'temperature':
            if (condition === 'over') return machineData.mixTemperature > value;
            if (condition === 'under') return machineData.mixTemperature < value;
            break;
        case 'weight':
            // Weight is in scale data, not machine data
            // This would need to be handled differently
            break;
        case 'time':
            // Time-based exits would be handled differently
            break;
        default:
            return false;
    }

    return false;
}

export function plotProfile(profile) {
    if (!profile || !profile.steps || profile.steps.length === 0) {
        clearChart();
        return;
    }

    for (const trace in chartData) {
        chartData[trace].x = [];
        chartData[trace].y = [];
    }

    const tpX = chartData.targetPressure.x;
    const tpY = chartData.targetPressure.y;
    const tfX = chartData.targetFlow.x;
    const tfY = chartData.targetFlow.y;
    const tempX = chartData.groupTemperature.x;
    const tempY = chartData.groupTemperature.y;

    let currentTime = 0;

    const initialTemp = (parseFloat(profile.steps[0].temperature || 0) / 100) * 10;
    tpX.push(0);
    tpY.push(0);
    tfX.push(0);
    tfY.push(0);
    tempX.push(0);
    tempY.push(initialTemp);

    for (const step of profile.steps) {
        const duration = parseFloat(step.seconds || 0);
        if (duration <= 0) continue;

        const nextTime = currentTime + duration;
        let pressure = null;
        let flow = null;
        const temp = (parseFloat(step.temperature || 0) / 100) * 10;

        if (step.pump === 'pressure') {
            pressure = parseFloat(step.pressure || 0);
        } else if (step.pump === 'flow') {
            flow = parseFloat(step.flow || 0);
        }

        tpX.push(currentTime, nextTime);
        tpY.push(pressure, pressure);

        tfX.push(currentTime, nextTime);
        tfY.push(flow, flow);

        tempX.push(currentTime, nextTime);
        tempY.push(temp, temp);

        currentTime = nextTime;
    }

    const theme = localStorage.getItem('theme') || 'light';
    const layout = JSON.parse(JSON.stringify(theme === 'dark' ? darkLayout : lightLayout));
    layout.annotations = [];
    layout.shapes = []; // Clear shapes for profile plot
    layout.xaxis.range = [0, currentTime];

    // Adaptive X-axis tick density based on profile duration
    let xDtick;
    if (currentTime < 60) {
        xDtick = 10;
    } else if (currentTime < 120) {
        xDtick = 15;
    } else if (currentTime < 180) {
        xDtick = 20;
    } else {
        xDtick = 30;
    }
    layout.xaxis.dtick = xDtick;

    // Sparser Y-axis ticks (0, 2, 4, 6, 8, 10) instead of every 1 unit
    layout.yaxis.dtick = 2;
    const plotData = JSON.parse(JSON.stringify(Object.values(chartData)));

    const targetPressureTrace = plotData.find(trace => trace.name === 'Target Pressure');
    if (targetPressureTrace) {
        targetPressureTrace.line.dash = 'solid';
        targetPressureTrace.line.width = 5;
    }

    const targetFlowTrace = plotData.find(trace => trace.name === 'Target Flow');
    if (targetFlowTrace) {
        targetFlowTrace.line.dash = 'solid';
        targetFlowTrace.line.width = 5;
    }

    const groupTempTrace = plotData.find(trace => trace.name === '°C');
    if (groupTempTrace) {
        groupTempTrace.line.width = 5;
    }

    const element = getChartElement();
    if (!element) {
        console.error('plotProfile: chartElement not found in DOM');
        return;
    }
    Plotly.react(element, plotData, layout, {displayModeBar: false});
}

// Function to update chart colors based on theme
function updateChartColors(theme) {
    const isDark = theme === 'dark';

    // Update target flow line color
    chartData.targetFlow.line.color = isDark ? '#23416c' : baseChartData.targetFlow.line.color;

    // Update target temperature line color
    chartData.targetTemperature.line.color = isDark ? '#3e3233' : baseChartData.targetTemperature.line.color;

    // Update temperature line color
    chartData.groupTemperature.line.color = isDark ? '#AE6D73' : baseChartData.groupTemperature.line.color;

    // Update weight line color
    chartData.weight.line.color = isDark ? '#695f57' : baseChartData.weight.line.color;
}

export function initChart() {
    console.log('initChart: Starting chart initialization');

    const element = getChartElement();
    if (!element) {
        console.error('initChart: chartElement is not found in the DOM');
        return;
    }

    console.log('initChart: chartElement found, offsetParent:', element.offsetParent !== null);
    console.log('initChart: chartElement visibility:', window.getComputedStyle ? window.getComputedStyle(element).visibility : 'unknown');
    console.log('initChart: chartElement display:', window.getComputedStyle ? window.getComputedStyle(element).display : 'unknown');

    const theme = localStorage.getItem('theme') || 'light';
    updateChartColors(theme); // Apply theme-specific colors

    const layout = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layout);

    console.log('initChart: About to call Plotly.newPlot');
    try {
        Plotly.newPlot(element, Object.values(chartData), layout, {displayModeBar: false});
        Plotly.relayout(element, { 'xaxis.autorange': true });
        console.log('initChart: Plotly.newPlot completed successfully');
    } catch (error) {
        console.error('initChart: Error in Plotly.newPlot:', error);
    }

    let resizeTimeout;
    console.log('initChart: Adding resize event listener');
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const resizeElement = getChartElement();
            console.log('initChart: Window resize event, checking chart visibility');
            if (resizeElement && resizeElement.offsetParent !== null) {
                console.log('initChart: Chart element is visible, attempting resize');
                try {
                    Plotly.Plots.resize(resizeElement);
                    // Recompute label range against the now-visible width — fixes
                    // bogus ranges left over from a live tick that fired while
                    // the chart was hidden (clientWidth = 0).
                    refreshLabelMargin();
                    console.log('initChart: Chart resized successfully');
                } catch (error) {
                    console.warn('Could not resize chart, element may not be visible:', error);
                }
            } else {
                console.log('initChart: Chart element not visible or not found, skipping resize');
            }
        }, 100);
    });
    
    // Listen for theme changes to update the chart when the theme changes
    window.addEventListener('storage', (event) => {
        if (event.key === 'theme') {
            const newTheme = event.newValue || 'light';
            setTheme(newTheme);
        }
    });

    // Re-render labels and grow the plot range when the UI language changes —
    // translated label widths differ, so range padding must follow.
    document.addEventListener('streamline:languagechange', () => {
        refreshLabelMargin();
    });

    console.log('initChart: Chart initialization completed');
}

export function setTheme(theme) {
    updateChartColors(theme); // Apply theme-specific colors

    const layoutUpdate = theme === 'dark' ? darkLayout : lightLayout;
    applyLabelLayout(layoutUpdate);
    const data = Object.values(chartData);
    const element = getChartElement();
    if (!element) {
        console.error('setTheme: chartElement not found in DOM');
        return;
    }
    Plotly.react(element, data, layoutUpdate);
}

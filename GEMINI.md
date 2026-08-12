# Gemini Guidelines

This document provides guidelines for interacting with the Gemini AI assistant in this project.

# Project Context: Rewrite existing Decent Espresso App

## 1. Project Overview

*   **Goal:** Rewrite existing streamline skin into modern html , css,Javascript based web app. 
*   **Core Features:** using Decaid as middle ware to talk to decent espresso machine and control it, and display real time data, and allow for profile creation and management.
*.  **Reference**:** All UI and Design reference can be accessed via figna design file and DESIGN_SYSTEM.MD. 
## 2. Tech Stack

*   **Framework:** Javascript , html , css
*   **Language:** Javascript
*   **Styling:** Tailwind CSS,daisyUI 
*   **UI Components:** plotly.js for charting

## 3. Project Structure

A brief description of key directories to help with navigation.

*   `src/modules`: Main Javascript modules to render pages and provide core application logic.
*   `src/css`: Stylesheets and CSS-related files.
*   `src/ui`: Basic, reusable UI components (buttons, inputs, fonts, icons).


## 4. Key Commands

A list of frequently used commands will save us time.

You are allowed to use Figma MCP commands to reference current finished design. 
Tools:
    - create_design_system_rules
    - get_code
    - get_code_connect_map
    - get_image
    - get_metadata
    - get_variable_defs

    Prompts:
    - create_design_system_rules
    - get_code_for_selection
    - map_selection_to_code_connect

## 5. Coding Reference

Current Working example is at /Users/markc/Documents/streamline_js/de1app/de1plus/skins/Streamline main functionality is written in skin.tcl , if you are not sure how to implement certain feature in Javascript, check aginst the logic in skin.tcl before you implement. 
You are also required to check rest_v1.yml, websocket_v1.yml, the [Decaid API documentation](https://github.com/decentespresso/decaid/blob/main/doc/Api.md), and rewrite_roadmap.md in your reasoning. These documents serve as guidelines for the project.
## 6. Current Goal

* * bug fixes and code suggestions. 
## Gemini Added Memories
- When updating Plotly charts, use Plotly.update() instead of Plotly.react() for better performance.



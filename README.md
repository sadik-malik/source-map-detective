# Source Map Detective

A Chrome extension that detects when websites expose JavaScript source maps and lets you download the original source code.

## What it does

- Automatically scans every page's JavaScript files for source map references
- Detects three types: **external** (`.map` file URL), **inline** (base64-embedded), and **header** (`SourceMap:` HTTP header)
- Shows a badge on the extension icon with the count of detected source maps
- Lets you download individual source maps or all at once as a ZIP
- Reconstructs the original file/folder structure from the source map

## Installation

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select this folder (`source-map-detective/`)

The extension icon will appear in your toolbar.

## How to use

1. Navigate to any website
2. If source maps are found, the extension icon shows an orange badge with the count
3. Click the icon to open the popup
4. Click **Download** next to any entry to download that source map's files
5. Click **Download all** to get everything as a single ZIP

## Notes

- Source maps must contain `sourcesContent` (embedded file content) for download to work. Some source maps only contain mappings without the actual source text.
- Downloads are saved to your default Chrome downloads folder.
- The extension scans up to 30 script files per page to avoid overloading slow sites.
- Works on webpack, Vite, Rollup, esbuild, and other bundlers that produce standard source maps.

## File structure

```
source-map-detective/
├── manifest.json       Extension manifest
├── background.js       Service worker (stores results, handles downloads)
├── content.js          Content script (scans page scripts)
├── popup/
│   ├── popup.html      Extension popup UI
│   ├── popup.js        Popup logic
│   └── popup.css       Popup styles
└── icons/              Extension icons
```

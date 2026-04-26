// Source Map Detective — Background Service Worker

// In-memory store: tabId -> { maps: [...], url }
const tabData = {};

// ── Message router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SOURCE_MAPS_FOUND') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    tabData[tabId] = { maps: msg.maps, url: msg.url };
    updateBadge(tabId, msg.maps.length);
    return;
  }

  if (msg.type === 'GET_MAPS') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id;
      sendResponse(tabData[tabId] || { maps: [], url: '' });
    });
    return true; // async
  }

  if (msg.type === 'DOWNLOAD_MAP') {
    downloadSourceMap(msg.entry).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true; // async
  }

  if (msg.type === 'DOWNLOAD_ALL') {
    downloadAllMaps(msg.maps).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

// ── Badge ────────────────────────────────────────────────────────────────────
function updateBadge(tabId, count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#E8860A', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// Clear badge when tab navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete tabData[tabId];
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete tabData[tabId];
});

// ── Source map fetching & parsing ────────────────────────────────────────────
async function fetchMapJson(entry) {
  if (entry.type === 'inline') {
    // data:application/json;base64,<b64>  OR  data:...;charset=...,<json>
    const [header, body] = entry.mapUrl.split(',');
    if (header.includes('base64')) {
      return JSON.parse(atob(body));
    }
    return JSON.parse(decodeURIComponent(body));
  }
  const resp = await fetch(entry.mapUrl);
  if (!resp.ok) throw new Error(`Failed to fetch source map: ${resp.status}`);
  return resp.json();
}

// ── Single map download ──────────────────────────────────────────────────────
async function downloadSourceMap(entry) {
  const map = await fetchMapJson(entry);
  const sources = map.sources || [];
  const contents = map.sourcesContent || [];

  if (contents.length === 0) {
    throw new Error('Source map exists but contains no embedded source content (sourcesContent is empty). The original files are not bundled.');
  }

  if (sources.length === 1) {
    // Single file — download directly
    const filename = sanitizePath(sources[0] || 'source.js');
    const blob = new Blob([contents[0] || ''], { type: 'text/plain' });
    await downloadBlobAsDataUrl(blob, filename);
    return { ok: true, count: 1 };
  }

  // Multiple files — build a ZIP
  const files = {};
  sources.forEach((src, i) => {
    if (contents[i] != null) {
      const path = sanitizePath(src);
      files[path] = contents[i];
    }
  });

  const zipBlob = buildZip(files);
  const zipName = hostnameFromUrl(entry.jsUrl) + '_sources.zip';
  await downloadBlobAsDataUrl(zipBlob, zipName);
  return { ok: true, count: Object.keys(files).length };
}

// ── Download all maps as one ZIP ─────────────────────────────────────────────
async function downloadAllMaps(maps) {
  const allFiles = {};
  let total = 0;

  for (const entry of maps) {
    try {
      const map = await fetchMapJson(entry);
      const sources = map.sources || [];
      const contents = map.sourcesContent || [];
      const prefix = fileBasename(entry.jsUrl);

      sources.forEach((src, i) => {
        if (contents[i] != null) {
          const path = prefix + '/' + sanitizePath(src);
          allFiles[path] = contents[i];
          total++;
        }
      });
    } catch { /* skip failed maps */ }
  }

  if (total === 0) throw new Error('No embedded source content found in any of the detected source maps.');

  const zipBlob = buildZip(allFiles);
  await downloadBlobAsDataUrl(zipBlob, 'all_sources.zip');
  return { ok: true, count: total };
}

// Service-worker-safe blob download: convert blob to data: URL and use chrome.downloads
async function downloadBlobAsDataUrl(blob, filename) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  const base64 = btoa(binary);
  const mime = blob.type || 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${base64}`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
}

// ── Minimal ZIP builder (no external lib needed) ─────────────────────────────
// Implements PKZIP store (no compression) — reliable, tiny, no dependencies
function buildZip(files) {
  const enc = new TextEncoder();
  const localHeaders = [];
  const centralDirectory = [];
  let offset = 0;

  for (const [path, content] of Object.entries(files)) {
    const pathBytes = enc.encode(path);
    const dataBytes = typeof content === 'string' ? enc.encode(content) : content;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;
    const date = dosDate(new Date());

    // Local file header
    const lh = new Uint8Array(30 + pathBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);  // sig
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // compression (store)
    lv.setUint16(10, date.time, true);
    lv.setUint16(12, date.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, pathBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(pathBytes, 30);

    localHeaders.push(lh);
    localHeaders.push(dataBytes);

    // Central directory entry
    const cd = new Uint8Array(46 + pathBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, date.time, true);
    cv.setUint16(14, date.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, pathBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cd.set(pathBytes, 46);

    centralDirectory.push(cd);
    offset += lh.length + dataBytes.length;
  }

  const cdOffset = offset;
  const cdSize = centralDirectory.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centralDirectory.length, true);
  ev.setUint16(10, centralDirectory.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);

  const parts = [...localHeaders, ...centralDirectory, eocd];
  return new Blob(parts, { type: 'application/zip' });
}

// CRC-32 implementation
function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDate(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sanitizePath(p) {
  return p
    .replace(/^(webpack:\/\/|\.\/|\/)/i, '')
    .replace(/\.\.\//g, '')
    .replace(/[<>:"|?*\x00-\x1F]/g, '_')
    .replace(/^\/+/, '');
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname.replace(/\./g, '_'); } catch { return 'sources'; }
}

function fileBasename(url) {
  try {
    const p = new URL(url).pathname;
    return p.split('/').pop().replace(/\.js$/, '') || 'script';
  } catch { return 'script'; }
}

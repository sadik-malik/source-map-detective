// Source Map Detective — Content Script
// Scans the current page for JavaScript files that expose source maps

(async () => {
  const foundMaps = [];
  const seenUrls = new Set();

  // Helper: resolve a potentially-relative URL against a base
  function resolveUrl(mapUrl, baseUrl) {
    if (!mapUrl) return null;
    if (mapUrl.startsWith('data:')) return mapUrl;
    try {
      return new URL(mapUrl, baseUrl).href;
    } catch {
      return null;
    }
  }

  // Helper: fetch a JS file and look for sourceMappingURL comment
  async function checkJsForSourceMap(jsUrl) {
    try {
      const resp = await fetch(jsUrl, { cache: 'force-cache' });
      if (!resp.ok) return null;

      // Check response header first (most reliable)
      const headerMap = resp.headers.get('SourceMap') || resp.headers.get('X-SourceMap');
      if (headerMap) {
        return {
          type: 'header',
          mapUrl: resolveUrl(headerMap, jsUrl),
          jsUrl
        };
      }

      // Read text — limit to last 4KB to avoid huge downloads
      const text = await resp.text();
      const last4k = text.slice(-4096);

      const match = last4k.match(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/);
      if (!match) return null;

      const raw = match[1].trim();
      if (raw.startsWith('data:')) {
        return { type: 'inline', mapUrl: raw, jsUrl };
      }
      return { type: 'external', mapUrl: resolveUrl(raw, jsUrl), jsUrl };
    } catch {
      return null;
    }
  }

  // Collect all script src URLs from the page
  const scriptUrls = [];
  document.querySelectorAll('script[src]').forEach(s => {
    try {
      const url = new URL(s.src, location.href).href;
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        scriptUrls.push(url);
      }
    } catch { /* skip */ }
  });

  // Also scan inline scripts for sourceMappingURL pointing to external files
  document.querySelectorAll('script:not([src])').forEach(s => {
    const match = s.textContent.match(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/);
    if (!match) return;
    const raw = match[1].trim();
    if (raw.startsWith('data:')) {
      if (!seenUrls.has(raw.slice(0, 60))) {
        seenUrls.add(raw.slice(0, 60));
        foundMaps.push({ type: 'inline', mapUrl: raw, jsUrl: location.href + ' (inline script)' });
      }
    }
  });

  // Fetch and check all script files in parallel (cap at 30 to avoid hammering)
  const toCheck = scriptUrls.slice(0, 30);
  const results = await Promise.all(toCheck.map(checkJsForSourceMap));

  results.forEach(r => {
    if (r && r.mapUrl && !seenUrls.has(r.mapUrl)) {
      seenUrls.add(r.mapUrl);
      foundMaps.push(r);
    }
  });

  // Send results to background regardless (even empty, so background can clear badge)
  chrome.runtime.sendMessage({
    type: 'SOURCE_MAPS_FOUND',
    maps: foundMaps,
    url: location.href
  });
})();

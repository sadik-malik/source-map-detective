// Source Map Detective — Popup Script

const $ = id => document.getElementById(id);

const views = {
  scanning: $('scanning'),
  noneFound: $('none-found'),
  found: $('found-view')
};

function show(view) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

function showError(msg) {
  const bar = $('error-bar');
  bar.textContent = msg;
  bar.classList.remove('hidden');
  setTimeout(() => bar.classList.add('hidden'), 6000);
}

function fileBasename(url) {
  try {
    const p = new URL(url).pathname;
    return p.split('/').pop() || url;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + '…' : url;
  }
}

function shortUrl(url) {
  if (!url || url.startsWith('data:')) return 'Inline (embedded in JS)';
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').pop();
    return u.hostname + '/…/' + path;
  } catch {
    return url.length > 50 ? url.slice(0, 47) + '…' : url;
  }
}

function buildMapRow(entry, index) {
  const row = document.createElement('div');
  row.className = 'map-row';

  const typeLabel = entry.type === 'inline' ? 'inline' : entry.type === 'header' ? 'header' : 'external';

  row.innerHTML = `
    <span class="map-type-pill ${typeLabel}">${typeLabel}</span>
    <div class="map-info">
      <div class="map-js-name">${fileBasename(entry.jsUrl)}</div>
      <div class="map-url">${shortUrl(entry.mapUrl)}</div>
    </div>
    <button class="btn-download" data-index="${index}" title="Download source files">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Download
    </button>
  `;
  return row;
}

async function triggerDownload(btn, entry) {
  btn.disabled = true;
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <circle cx="12" cy="12" r="9" stroke-dasharray="4 4"/>
    </svg>
    Working…
  `;

  const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_MAP', entry });

  if (result?.ok) {
    btn.classList.add('success');
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M20 6L9 17l-5-5"/>
      </svg>
      Saved (${result.count} file${result.count !== 1 ? 's' : ''})
    `;
  } else {
    btn.disabled = false;
    btn.classList.add('error-state');
    btn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      Failed
    `;
    showError(result?.error || 'Download failed. The source map may not contain embedded source content.');
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  // Show current tab hostname
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    try {
      $('page-host').textContent = new URL(tab.url).hostname;
    } catch { /* keep default */ }
  }

  // If content script hasn't finished yet, give it a moment then request data
  const data = await chrome.runtime.sendMessage({ type: 'GET_MAPS' });

  if (!data || data.maps === undefined) {
    // Background has no data yet — content script may still be scanning
    setTimeout(async () => {
      const retry = await chrome.runtime.sendMessage({ type: 'GET_MAPS' });
      renderResults(retry);
    }, 1500);
    return;
  }

  renderResults(data);
})();

function renderResults(data) {
  if (!data || !data.maps) {
    show(views.noneFound);
    return;
  }

  const maps = data.maps;

  if (maps.length === 0) {
    show(views.noneFound);
    return;
  }

  // Render found view
  $('found-count').textContent = maps.length;
  const list = $('maps-list');
  list.innerHTML = '';

  maps.forEach((entry, i) => {
    const row = buildMapRow(entry, i);
    list.appendChild(row);
  });

  // Per-row download buttons
  list.addEventListener('click', async e => {
    const btn = e.target.closest('.btn-download');
    if (!btn) return;
    const idx = parseInt(btn.dataset.index, 10);
    await triggerDownload(btn, maps[idx]);
  });

  // Download all button
  $('btn-download-all').addEventListener('click', async () => {
    const btn = $('btn-download-all');
    btn.disabled = true;
    btn.textContent = 'Zipping…';

    const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_ALL', maps });
    if (result?.ok) {
      btn.textContent = `✓ Saved ${result.count} files`;
    } else {
      btn.disabled = false;
      btn.textContent = 'Download all';
      showError(result?.error || 'Could not create ZIP file.');
    }
  });

  show(views.found);
}

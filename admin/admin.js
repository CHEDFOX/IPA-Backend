// Admin panel for the IPA site. Plain ES module, no build step.

const TYPE_LABELS = { land: 'Land', residential: 'Residential', commercial: 'Commercial' };
const STATUS_LABELS = { available: 'Available', under_offer: 'Under offer', sold: 'Sold' };
const VISIBILITY = {
  public: { label: 'Public', help: 'Shown on the site and to search engines.' },
  unlisted: { label: 'Private link', help: 'Hidden from the site. Only people you send the private link to can open it.' },
  draft: { label: 'Draft', help: 'Hidden. You can still preview it with the private link.' },
};
const UNITS = { m2: 'm²', ha: 'hectares', acre: 'acres', sqft: 'sq ft' };
const SUGGESTED_DETAILS = {
  land: [['Plot number', false], ['Dimensions', false], ['Zoning', true], ['Title', true], ['Road access', true], ['Utilities', false], ['Terrain', false]],
  residential: [['Built area', true], ['Plot area', false], ['Floors', false], ['Year built', false], ['Parking', true], ['Furnishing', false], ['Title', false]],
  commercial: [['Floor area', true], ['Floors', false], ['Parking', true], ['Zoning', true], ['Current use', false], ['Title', false]],
};
const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD', 'EGP', 'MAD', 'TRY', 'INR', 'PKR', 'NGN', 'KES', 'ZAR', 'CAD', 'AUD'];

// ---------- helpers

class Html {
  constructor(value) {
    this.value = value;
  }
}
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESCAPES[c]);
function part(v) {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
// Tagged template that escapes every interpolated value unless it is already Html.
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += part(v) + strings[i + 1];
  });
  return new Html(out);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const mount = (el, content) => {
  el.innerHTML = part(content);
};

const svg = (paths, size = 16) =>
  new Html(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
  );
const icon = {
  external: svg('<path d="M7 17 17 7"/><path d="M8 7h9v9"/>', 14),
  left: svg('<path d="m15 6-6 6 6 6"/>'),
  right: svg('<path d="m9 6 6 6-6 6"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
  x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  upload: svg('<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>', 22),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = kind === 'error' ? 'toast error' : 'toast';
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied');
  } catch {
    window.prompt('Copy this link:', text);
  }
}

// ---------- server calls

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.field = data?.field;
  }
}

function sessionEnded() {
  if (!state.me) return;
  state.me = null;
  state.dirty = false;
  renderLogin('Your session ended. Please sign in again.');
}

async function api(method, url, body) {
  const options = { method, headers: { 'x-ipa-admin': '1' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError(0, { error: 'Could not reach the server. Check your connection.' });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON (e.g. a proxy error page)
  }
  if (res.status === 401 && url !== '/api/admin/login') sessionEnded();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// XHR instead of fetch so large videos can show upload progress.
function upload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-ipa-admin', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      if (xhr.status === 401) sessionEnded();
      const fallback = xhr.status === 413 ? 'This file is larger than the server accepts.' : `Upload failed (${xhr.status}).`;
      reject(new ApiError(xhr.status, { error: data.errors?.[0]?.error || data.error || fallback }));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: 'Network error during upload.' }));
    xhr.send(formData);
  });
}

// ---------- app shell and routing

const state = { me: null, dirty: false, hash: '' };

function setDirty(dirty) {
  state.dirty = dirty;
  const label = $('#save-state');
  if (label) {
    label.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    label.classList.toggle('dirty', dirty);
  }
}

window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

function renderLogin(message = '') {
  document.title = 'Sign in · Admin';
  mount(
    $('#app'),
    html`<main class="login">
      <form class="login-card" id="login-form">
        <div><span class="label">Admin</span><h1>Sign in</h1></div>
        <label class="field">
          <span>Password</span>
          <input class="input" type="password" name="password" autocomplete="current-password" required>
        </label>
        <p class="field-error" id="login-error">${message}</p>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
    </main>`,
  );
  const form = $('#login-form');
  form.elements.password.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('button', form);
    button.disabled = true;
    try {
      await api('POST', '/api/admin/login', { password: form.elements.password.value });
      await boot();
    } catch (err) {
      $('#login-error').textContent = err.message;
      form.elements.password.select();
    } finally {
      button.disabled = false;
    }
  });
}

function renderShell() {
  const { me } = state;
  document.title = `${me.siteName} · Admin`;
  mount(
    $('#app'),
    html`<header class="topbar">
        <a class="brand" href="#/properties"><span class="brand-name">${me.siteName}</span><span class="label">Admin</span></a>
        <nav class="topnav" aria-label="Admin sections">
          <a href="#/properties" data-nav="properties">Properties</a>
          <a href="#/enquiries" data-nav="enquiries">Enquiries <span class="count" id="unread"></span></a>
          <a href="#/settings" data-nav="settings">Settings</a>
        </nav>
        <div class="topbar-actions">
          <a href="${me.siteUrl}" target="_blank" rel="noopener">View site ${icon.external}</a>
          <button class="link-btn" type="button" id="logout">Sign out</button>
        </div>
      </header>
      <main class="view" id="view"></main>`,
  );
  setUnread(me.unreadEnquiries);
  $('#logout').addEventListener('click', async () => {
    if (state.dirty && !window.confirm('You have unsaved changes. Sign out anyway?')) return;
    await api('POST', '/api/admin/logout').catch(() => {});
    state.me = null;
    state.dirty = false;
    renderLogin();
  });
}

function setUnread(n) {
  const badge = $('#unread');
  if (!badge) return;
  badge.textContent = n;
  badge.hidden = !n;
  badge.setAttribute('aria-label', `${n} unread`);
}

async function route() {
  if (!state.me) return;
  const hash = location.hash || '#/properties';
  if (state.dirty && hash !== state.hash) {
    if (!window.confirm('You have unsaved changes. Leave without saving?')) {
      history.replaceState(null, '', state.hash);
      return;
    }
    setDirty(false);
  }
  state.hash = hash;
  const section = hash.split('/')[1] || 'properties';
  for (const link of $$('[data-nav]')) {
    if (link.dataset.nav === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const view = $('#view');
  view.onclick = null;
  mount(view, html`<p class="muted">Loading…</p>`);
  const editor = hash.match(/^#\/properties\/(\d+)$/);
  try {
    if (editor) await viewEditor(view, Number(editor[1]));
    else if (section === 'enquiries') await viewEnquiries(view);
    else if (section === 'settings') await viewSettings(view);
    else await viewProperties(view);
  } catch (err) {
    if (err.status === 401) return;
    mount(view, html`<div class="empty"><h2>Could not load this page</h2><p class="muted">${err.message}</p></div>`);
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

async function boot() {
  try {
    state.me = await api('GET', '/api/admin/me');
  } catch (err) {
    if (err.status === 401) return renderLogin();
    return mount($('#app'), html`<p class="boot">Could not reach the server: ${err.message}</p>`);
  }
  renderShell();
  await route();
}

// ---------- shared form bits

const field = (label, control, hint) =>
  html`<label class="field"><span>${label}</span>${control}${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;

const options = (map, selected) =>
  Object.entries(map).map(([value, label]) => html`<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`);

function clearErrors(root) {
  for (const el of $$('[aria-invalid="true"]', root)) el.removeAttribute('aria-invalid');
  for (const el of $$('.field-error[data-for]', root)) el.remove();
}

function showError(root, name, message) {
  const input = root.querySelector(`[name="${name}"]`) || document.querySelector(`[name="${name}"][form]`);
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  const note = document.createElement('span');
  note.className = 'field-error';
  note.dataset.for = name;
  note.textContent = message;
  input.closest('.field')?.append(note);
  input.focus();
}

function setupDropzone(zone, onFiles) {
  const input = $('input[type="file"]', zone);
  input.addEventListener('change', () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('over');
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    onFiles([...e.dataTransfer.files]);
  });
}

// Uploads files one by one into `queueEl`, showing progress. `send` posts one file.
async function runQueue(queueEl, files, send) {
  const limit = state.me.maxUploadMb * 1024 * 1024;
  const items = files.map((file) => {
    const item = document.createElement('div');
    item.className = 'queue-item';
    mount(item, html`<span class="name">${file.name}</span><span class="status">Waiting…</span><div class="bar"><span></span></div>`);
    queueEl.append(item);
    return item;
  });
  let ok = 0;
  for (const [i, file] of files.entries()) {
    const item = items[i];
    const status = $('.status', item);
    const bar = $('.bar > span', item);
    if (file.size > limit) {
      item.classList.add('error');
      status.textContent = `Too large (max ${state.me.maxUploadMb} MB)`;
      continue;
    }
    status.textContent = 'Uploading…';
    try {
      await send(file, (fraction) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
        status.textContent = fraction < 1 ? `${Math.round(fraction * 100)}% of ${fmtBytes(file.size)}` : 'Processing…';
      });
      item.remove();
      ok += 1;
    } catch (err) {
      item.classList.add('error');
      status.textContent = err.message;
      if (err.status === 401) return ok;
    }
  }
  return ok;
}

// ---------- properties list

async function viewProperties(view) {
  const { items } = await api('GET', '/api/admin/properties');
  document.title = `Properties · ${state.me.siteName}`;

  mount(
    view,
    html`<div class="page-head">
        <div><span class="label">${items.length} ${items.length === 1 ? 'property' : 'properties'}</span><h1>Properties</h1></div>
        <button class="btn btn-primary" type="button" id="new-property">${icon.plus} New property</button>
      </div>
      ${items.length
        ? html`<div class="toolbar">
              <label class="visually-hidden" for="search">Search properties</label>
              <input class="input" type="search" id="search" placeholder="Search by title or location">
              <label class="visually-hidden" for="filter-type">Type</label>
              <select class="select" id="filter-type"><option value="">All types</option>${options(TYPE_LABELS)}</select>
            </div>
            <div class="list" id="list"></div>`
        : html`<div class="empty">
            <h2>No properties yet</h2>
            <p class="muted">Add your first plot, home or commercial site. It stays a draft until you publish it.</p>
            <button class="btn btn-primary" type="button" id="new-property-empty">${icon.plus} Add a property</button>
          </div>`}`,
  );

  for (const id of ['new-property', 'new-property-empty']) $(`#${id}`)?.addEventListener('click', newPropertyDialog);
  if (!items.length) return;

  const renderList = () => {
    const q = $('#search').value.trim().toLowerCase();
    const type = $('#filter-type').value;
    const shown = items.filter(
      (p) => (!type || p.type === type) && (!q || `${p.title} ${p.location}`.toLowerCase().includes(q)),
    );
    mount(
      $('#list'),
      shown.length
        ? shown.map(
            (p) => html`<a class="row" href="#/properties/${p.id}">
              ${p.cover ? html`<img class="thumb" src="${p.cover.sizes[0].url}" alt="" loading="lazy">` : html`<span class="thumb">No photo</span>`}
              <div>
                <div class="row-title">${p.title}</div>
                <div class="row-meta">
                  <span class="label">${TYPE_LABELS[p.type]}${p.location ? ` · ${p.location}` : ''}</span>
                  <span class="pill"><span class="dot ${p.status}"></span>${STATUS_LABELS[p.status]}</span>
                  ${p.featured ? html`<span class="pill">Featured</span>` : ''}
                </div>
              </div>
              <div class="row-side">
                <span class="pill ${p.visibility}">${VISIBILITY[p.visibility].label}</span>
                <span class="muted mono">${p.photoCount} photos${p.videoCount ? ` · ${p.videoCount} video` : ''}</span>
              </div>
            </a>`,
          )
        : html`<p class="muted row">No properties match.</p>`,
    );
  };
  $('#search').addEventListener('input', renderList);
  $('#filter-type').addEventListener('change', renderList);
  renderList();
}

function newPropertyDialog() {
  const dialog = document.createElement('dialog');
  mount(
    dialog,
    html`<form id="new-form">
      <h2>New property</h2>
      ${field('Title', html`<input class="input" name="title" required maxlength="160" placeholder="e.g. Riverside Plot 12">`)}
      ${field('Type', html`<select class="select" name="type">${options(TYPE_LABELS, 'land')}</select>`)}
      <p class="hint">It starts as a draft. Nothing shows on the site until you publish it.</p>
      <div class="dialog-actions">
        <button class="btn" type="button" value="cancel">Cancel</button>
        <button class="btn btn-primary" type="submit">Create</button>
      </div>
    </form>`,
  );
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  $('[value="cancel"]', dialog).addEventListener('click', () => dialog.close());
  const form = $('form', dialog);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = form.elements.type.value;
    try {
      const created = await api('POST', '/api/admin/properties', {
        title: form.elements.title.value,
        type,
        details: SUGGESTED_DETAILS[type].map(([label, key]) => ({ label, value: '', key })),
      });
      dialog.close();
      location.hash = `#/properties/${created.id}`;
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  dialog.showModal();
}

// ---------- property editor

function parseMapLink(text) {
  const s = decodeURIComponent(String(text || ''));
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // dropped pin
    /[?&](?:q|query|ll|destination|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, // map centre
    /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/, // plain "lat, lng"
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

async function viewEditor(view, id) {
  let [p, { settings }, { items: all }] = await Promise.all([
    api('GET', `/api/admin/properties/${id}`),
    api('GET', '/api/admin/settings'),
    api('GET', '/api/admin/properties'),
  ]);
  const siteUrl = state.me.siteUrl;
  const locations = [...new Set(all.map((x) => x.location).filter(Boolean))].sort();
  const lists = {
    details: p.details.map((d) => ({ ...d })),
    nearby: p.nearby.map((n) => ({ ...n })),
  };
  document.title = `${p.title} · ${state.me.siteName}`;
  const num = (v) => (v === null || v === undefined ? '' : String(v));

  mount(
    view,
    html`<div class="page-head">
        <div><a class="label" href="#/properties">← All properties</a><h1 id="ed-title">${p.title}</h1></div>
        <div class="inline" id="ed-links"></div>
      </div>
      <div class="editor" id="editor">
        <div class="editor-main">
          <form id="prop-form" novalidate>
            <section class="panel">
              <div class="panel-head"><h2>Basics</h2></div>
              <div class="grid">
                ${field('Title', html`<input class="input" name="title" value="${p.title}" maxlength="160" required>`)}
                <div class="grid grid-2">
                  ${field('Type', html`<select class="select" name="type">${options(TYPE_LABELS, p.type)}</select>`)}
                  ${field(
                    'Web address',
                    html`<div class="prefix"><span title="${siteUrl}/properties/">/properties/</span><input class="input" name="slug" value="${p.slug}" maxlength="80"></div>`,
                    'Changing this breaks links you already sent.',
                  )}
                </div>
                ${field(
                  'Summary',
                  html`<input class="input" name="summary" value="${p.summary}" maxlength="200" placeholder="e.g. Level 2.4 ha plot with 120 m road frontage, freehold">`,
                  'One line shown on cards and in link previews in WhatsApp and other apps.',
                )}
              </div>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Price and size</h2></div>
              <div class="grid grid-2">
                ${field(
                  'Price',
                  html`<div class="prefix"><span>${settings.currency}</span><input class="input" name="price" value="${num(p.price)}" inputmode="decimal" placeholder="Leave empty for “Price on request”"></div>`,
                )}
                ${field('Price note', html`<input class="input" name="priceNote" value="${p.priceNote}" maxlength="60" placeholder="e.g. Negotiable">`)}
                ${field('Area', html`<input class="input" name="area" value="${num(p.area)}" inputmode="decimal" placeholder="e.g. 2.4">`)}
                ${field('Area unit', html`<select class="select" name="areaUnit">${options(UNITS, p.areaUnit)}</select>`)}
                ${field('Bedrooms', html`<input class="input" name="bedrooms" value="${num(p.bedrooms)}" inputmode="numeric" placeholder="Optional">`)}
                ${field('Bathrooms', html`<input class="input" name="bathrooms" value="${num(p.bathrooms)}" inputmode="numeric" placeholder="Optional">`)}
              </div>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Location</h2></div>
              <div class="grid">
                <div class="grid grid-2">
                  ${field(
                    'Area name',
                    html`<input class="input" name="location" value="${p.location}" maxlength="80" list="locations" placeholder="e.g. North Valley">
                      <datalist id="locations">${locations.map((l) => html`<option value="${l}"></option>`)}</datalist>`,
                    'Used for the location filter. Use the same spelling each time.',
                  )}
                  ${field('Address', html`<input class="input" name="address" value="${p.address}" maxlength="200" placeholder="e.g. Plot 12, Block C, Valley Road">`)}
                </div>
                ${field(
                  'Google Maps link',
                  html`<input class="input" id="map-link" placeholder="Paste a Google Maps link or “lat, lng”">`,
                  html`<span id="map-hint">Fills in the coordinates below. For short links (maps.app.goo.gl), open them in your browser first and copy the full address.</span>`,
                )}
                <div class="grid grid-2">
                  ${field('Latitude', html`<input class="input mono" name="latitude" value="${num(p.latitude)}" inputmode="decimal" placeholder="e.g. 25.2048">`)}
                  ${field('Longitude', html`<input class="input mono" name="longitude" value="${num(p.longitude)}" inputmode="decimal" placeholder="e.g. 55.2708">`)}
                </div>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head"><h2>Description</h2></div>
              ${field(
                'About this property',
                html`<textarea class="textarea tall" name="description" maxlength="20000">${p.description}</textarea>`,
                'Leave a blank line between paragraphs.',
              )}
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Key facts and details</h2>
                <p class="hint">Tick “Key fact” to show a row in the large facts strip at the top of the page (up to 3, next to the area). Rows without a value are hidden on the site.</p>
              </div>
              <div class="rows" id="rows-details"></div>
              <div class="inline">
                <button class="btn btn-sm" type="button" data-row-add="details">${icon.plus} Add row</button>
                <button class="btn btn-sm" type="button" id="suggest">Add suggested rows</button>
              </div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2>Nearby</h2>
                <p class="hint">Places and distances, e.g. “Town centre — 7 km”.</p>
              </div>
              <div class="rows" id="rows-nearby"></div>
              <div class="inline"><button class="btn btn-sm" type="button" data-row-add="nearby">${icon.plus} Add place</button></div>
            </section>
          </form>

          <section class="panel" id="gallery-panel">
            <div class="panel-head">
              <h2>Photos and videos</h2>
              <p class="hint">The first photo is the cover on cards and link previews. Drag tiles or use the arrows to reorder. Changes here save straight away.</p>
            </div>
            <label class="dropzone" id="gallery-drop">
              ${icon.upload}
              <strong>Drop photos and videos here, or click to choose</strong>
              <span class="hint">JPEG, PNG, WebP · MP4, MOV, WebM up to ${state.me.maxUploadMb} MB each${state.me.videoProcessing ? '' : ' · videos are stored as uploaded'}</span>
              <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/quicktime,video/webm,.mov,.m4v">
            </label>
            <div class="queue" id="gallery-queue"></div>
            <div class="media-grid" id="gallery-grid"></div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>Site plan and brochure</h2>
              <p class="hint">A survey or site plan image is shown next to the map. A PDF brochure gets a download button.</p>
            </div>
            <div class="grid grid-2">
              <div class="stack"><span class="label">Site plan</span><div id="slot-plan"></div><div class="queue" id="queue-plan"></div></div>
              <div class="stack"><span class="label">Brochure (PDF)</span><div id="slot-brochure"></div><div class="queue" id="queue-brochure"></div></div>
            </div>
          </section>
        </div>

        <aside class="editor-side">
          <section class="panel">
            <div class="panel-head"><h2>Publish</h2></div>
            <div class="stack">
              <div class="radio-list" role="radiogroup" aria-label="Visibility">
                ${Object.entries(VISIBILITY).map(
                  ([value, v]) => html`<label>
                    <input type="radio" name="visibility" value="${value}" form="prop-form" ${p.visibility === value ? 'checked' : ''}>
                    <span><strong>${v.label}</strong><small>${v.help}</small></span>
                  </label>`,
                )}
              </div>
              ${field('Status', html`<select class="select" name="status" form="prop-form">${options(STATUS_LABELS, p.status)}</select>`)}
              <label class="check"><input type="checkbox" name="featured" form="prop-form" ${p.featured ? 'checked' : ''}> Feature on the home page</label>
              ${field(
                'Display order',
                html`<input class="input" name="sortOrder" form="prop-form" value="${num(p.sortOrder)}" inputmode="numeric">`,
                'Lower numbers show first. Leave at 0 to show newest first.',
              )}
            </div>
          </section>
          <section class="panel" id="share-panel"></section>
          <section class="panel">
            <div class="panel-head"><h2>Delete</h2></div>
            <button class="btn btn-danger" type="button" id="delete-property">${icon.trash} Delete property</button>
          </section>
        </aside>
      </div>
      <div class="savebar">
        <span class="state" id="save-state">All changes saved</span>
        <button class="btn btn-primary" type="submit" form="prop-form" id="save-btn">Save changes</button>
      </div>`,
  );

  const form = $('#prop-form');
  const editor = $('#editor');

  // -- header links and share box reflect the last saved state
  function renderLinks() {
    const preview = p.visibility === 'public' ? `${siteUrl}/properties/${p.slug}` : `${siteUrl}/p/${p.shareToken}`;
    mount(
      $('#ed-links'),
      html`<a class="btn" href="${preview}" target="_blank" rel="noopener">${p.visibility === 'public' ? 'View on site' : 'Preview'} ${icon.external}</a>`,
    );
    const publicUrl = `${siteUrl}/properties/${p.slug}`;
    const privateUrl = `${siteUrl}/p/${p.shareToken}`;
    mount(
      $('#share-panel'),
      html`<div class="panel-head"><h2>Share</h2></div>
        <div class="stack">
          ${p.visibility === 'public'
            ? html`<span class="label">Public link</span>
                <div class="share-url"><span>${publicUrl}</span><button class="btn btn-sm" type="button" data-copy="${publicUrl}">Copy</button></div>
                <a class="btn btn-sm" href="/api/admin/properties/${p.id}/qr.png" download>Download QR code</a>`
            : html`<p class="hint">Choose “Public” and save to get a public link.</p>`}
          <span class="label">Private link</span>
          <div class="share-url"><span>${privateUrl}</span><button class="btn btn-sm" type="button" data-copy="${privateUrl}">Copy</button></div>
          <div class="inline">
            <a class="btn btn-sm" href="/api/admin/properties/${p.id}/qr.png?private=1" download>QR code</a>
            <button class="btn btn-sm" type="button" id="new-private">New private link</button>
          </div>
          <p class="hint">Works for drafts and private listings too. A new private link stops the old one working.</p>
        </div>`,
    );
  }

  // -- details / nearby row editors
  const ROWS = {
    details: {
      head: html`<div class="rows-item details rows-head"><span>Label</span><span>Value</span><span></span><span></span></div>`,
      fields: (d, i) => html`
        <input class="input" data-list="details" data-i="${i}" data-k="label" value="${d.label}" maxlength="60" placeholder="e.g. Zoning" aria-label="Label ${i + 1}">
        <input class="input" data-list="details" data-i="${i}" data-k="value" value="${d.value}" maxlength="200" placeholder="e.g. Agricultural" aria-label="Value ${i + 1}">
        <label class="check"><input type="checkbox" data-list="details" data-i="${i}" data-k="key" ${d.key ? 'checked' : ''}> Key fact</label>`,
      blank: () => ({ label: '', value: '', key: false }),
    },
    nearby: {
      head: html`<div class="rows-item nearby rows-head"><span>Place</span><span>Distance</span><span></span></div>`,
      fields: (n, i) => html`
        <input class="input" data-list="nearby" data-i="${i}" data-k="place" value="${n.place}" maxlength="80" placeholder="e.g. Town centre" aria-label="Place ${i + 1}">
        <input class="input" data-list="nearby" data-i="${i}" data-k="distance" value="${n.distance}" maxlength="40" placeholder="e.g. 7 km" aria-label="Distance ${i + 1}">`,
      blank: () => ({ place: '', distance: '' }),
    },
  };

  function renderRows(name) {
    const list = lists[name];
    const spec = ROWS[name];
    mount(
      $(`#rows-${name}`),
      list.length
        ? [
            spec.head,
            list.map(
              (row, i) => html`<div class="rows-item ${name}">
                ${spec.fields(row, i)}
                <div class="rows-actions">
                  <button class="btn btn-sm btn-icon" type="button" data-row-move="-1" data-list="${name}" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon.up}</button>
                  <button class="btn btn-sm btn-icon" type="button" data-row-move="1" data-list="${name}" data-i="${i}" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon.down}</button>
                  <button class="btn btn-sm btn-icon btn-danger" type="button" data-row-remove data-list="${name}" data-i="${i}" aria-label="Remove row">${icon.x}</button>
                </div>
              </div>`,
            ),
          ]
        : html`<p class="hint">Nothing added yet.</p>`,
    );
  }

  form.addEventListener('click', (e) => {
    const add = e.target.closest('[data-row-add]');
    const move = e.target.closest('[data-row-move]');
    const remove = e.target.closest('[data-row-remove]');
    const button = add || move || remove;
    if (!button) return;
    const name = button.dataset.rowAdd || button.dataset.list;
    const list = lists[name];
    const i = Number(button.dataset.i);
    if (add) list.push(ROWS[name].blank());
    if (move) {
      const j = i + Number(move.dataset.rowMove);
      [list[i], list[j]] = [list[j], list[i]];
    }
    if (remove) list.splice(i, 1);
    renderRows(name);
    setDirty(true);
    if (add) $(`#rows-${name} .rows-item:last-child input`)?.focus();
  });

  $('#suggest').addEventListener('click', () => {
    const have = new Set(lists.details.map((d) => d.label.trim().toLowerCase()));
    const added = SUGGESTED_DETAILS[form.elements.type.value].filter(([label]) => !have.has(label.toLowerCase()));
    if (!added.length) return toast('All suggested rows are already there');
    lists.details.push(...added.map(([label, key]) => ({ label, value: '', key })));
    renderRows('details');
    setDirty(true);
  });

  // -- dirty tracking for every control that belongs to the form (including sidebar ones)
  const track = (e) => {
    const el = e.target;
    if (el.dataset.list) {
      lists[el.dataset.list][Number(el.dataset.i)][el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value;
    }
    if (el.form === form || el.dataset.list) setDirty(true);
  };
  editor.addEventListener('input', track);
  editor.addEventListener('change', track);

  $('#map-link').addEventListener('input', (e) => {
    const found = parseMapLink(e.target.value);
    const hint = $('#map-hint');
    if (!e.target.value.trim()) return;
    if (!found) {
      hint.textContent = 'No coordinates found in that link. Try the full link from the address bar, or type “lat, lng”.';
      return;
    }
    form.elements.latitude.value = found.lat;
    form.elements.longitude.value = found.lng;
    hint.textContent = `Coordinates set to ${found.lat}, ${found.lng}. Save to keep them.`;
    setDirty(true);
  });

  function collect() {
    const v = (name) => form.elements.namedItem(name)?.value ?? '';
    return {
      title: v('title'),
      slug: v('slug'),
      type: v('type'),
      summary: v('summary'),
      price: v('price'),
      priceNote: v('priceNote'),
      area: v('area'),
      areaUnit: v('areaUnit'),
      bedrooms: v('bedrooms'),
      bathrooms: v('bathrooms'),
      location: v('location'),
      address: v('address'),
      latitude: v('latitude'),
      longitude: v('longitude'),
      description: v('description'),
      visibility: v('visibility'),
      status: v('status'),
      featured: form.elements.namedItem('featured').checked,
      sortOrder: v('sortOrder'),
      details: lists.details,
      nearby: lists.nearby,
    };
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(document);
    const button = $('#save-btn');
    button.disabled = true;
    try {
      p = await api('PUT', `/api/admin/properties/${id}`, collect());
      form.elements.slug.value = p.slug;
      $('#ed-title').textContent = p.title;
      document.title = `${p.title} · ${state.me.siteName}`;
      renderLinks();
      setDirty(false);
      toast(p.visibility === 'public' ? 'Saved. The site updates within a minute.' : 'Saved');
    } catch (err) {
      if (err.field) showError(document, err.field, err.message);
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  // -- gallery
  function coverId() {
    return (p.gallery.find((m) => m.kind === 'image') || p.gallery[0])?.id;
  }

  function thumb(m) {
    const set = m.kind === 'video' ? m.poster : m;
    return set?.sizes?.length
      ? html`<img src="${set.sizes[0].url}" alt="" loading="lazy">`
      : html`<span class="slot-preview">Video</span>`;
  }

  function renderGallery() {
    const grid = $('#gallery-grid');
    if (!p.gallery.length) {
      mount(grid, html`<p class="hint">No photos or videos yet.</p>`);
      return;
    }
    const cover = coverId();
    const last = p.gallery.length - 1;
    mount(
      grid,
      p.gallery.map(
        (m, i) => html`<div class="tile" draggable="true" data-id="${m.id}">
          <div class="tile-media">
            ${thumb(m)}
            ${m.id === cover ? html`<span class="tile-badge">Cover</span>` : ''}
            ${m.kind === 'video' ? html`<span class="tile-badge right">Video${m.duration ? ` · ${fmtDuration(m.duration)}` : ''}</span>` : ''}
          </div>
          <input class="input" data-alt="${m.id}" value="${m.alt}" maxlength="200" placeholder="Short description" aria-label="Description for item ${i + 1}">
          <div class="tile-actions">
            <div class="inline">
              <button class="btn btn-sm btn-icon" type="button" data-move="-1" data-id="${m.id}" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>${icon.left}</button>
              <button class="btn btn-sm btn-icon" type="button" data-move="1" data-id="${m.id}" aria-label="Move later" ${i === last ? 'disabled' : ''}>${icon.right}</button>
            </div>
            <div class="inline">
              ${m.kind === 'image' && m.id !== cover ? html`<button class="btn btn-sm" type="button" data-cover="${m.id}">Set cover</button>` : ''}
              <button class="btn btn-sm btn-icon btn-danger" type="button" data-delete="${m.id}" aria-label="Delete">${icon.trash}</button>
            </div>
          </div>
        </div>`,
      ),
    );
  }

  async function reorder(ids) {
    const byId = new Map(p.gallery.map((m) => [m.id, m]));
    p.gallery = ids.map((i) => byId.get(i));
    renderGallery();
    try {
      p = await api('PUT', `/api/admin/properties/${id}/media/order`, { ids });
    } catch (err) {
      toast(err.message, 'error');
      p = await api('GET', `/api/admin/properties/${id}`);
    }
    renderGallery();
  }

  const galleryPanel = $('#gallery-panel');
  galleryPanel.addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]');
    const makeCover = e.target.closest('[data-cover]');
    const del = e.target.closest('[data-delete]');
    const ids = p.gallery.map((m) => m.id);
    if (move) {
      const i = ids.indexOf(Number(move.dataset.id));
      const j = i + Number(move.dataset.move);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      return reorder(ids);
    }
    if (makeCover) {
      const target = Number(makeCover.dataset.cover);
      return reorder([target, ...ids.filter((x) => x !== target)]);
    }
    if (del) {
      if (!window.confirm('Delete this file? This cannot be undone.')) return;
      try {
        await api('DELETE', `/api/admin/media/${del.dataset.delete}`);
        p.gallery = p.gallery.filter((m) => m.id !== Number(del.dataset.delete));
        renderGallery();
        toast('Deleted');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  galleryPanel.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-alt]');
    if (!input) return;
    try {
      const updated = await api('PATCH', `/api/admin/media/${input.dataset.alt}`, { alt: input.value });
      const m = p.gallery.find((x) => x.id === updated.id);
      if (m) m.alt = updated.alt;
      toast('Description saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // drag tiles to reorder
  let dragged = null;
  const grid = $('#gallery-grid');
  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || e.target.matches('input')) return;
    dragged = Number(tile.dataset.id);
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragged));
  });
  grid.addEventListener('dragover', (e) => {
    const tile = e.target.closest('.tile');
    if (dragged === null || !tile) return;
    e.preventDefault();
    for (const t of $$('.drop-target', grid)) t.classList.remove('drop-target');
    if (Number(tile.dataset.id) !== dragged) tile.classList.add('drop-target');
  });
  grid.addEventListener('drop', (e) => {
    const tile = e.target.closest('.tile');
    if (dragged === null || !tile) return;
    e.preventDefault();
    const target = Number(tile.dataset.id);
    if (target !== dragged) {
      const ids = p.gallery.map((m) => m.id).filter((x) => x !== dragged);
      ids.splice(ids.indexOf(target), 0, dragged);
      reorder(ids);
    }
  });
  grid.addEventListener('dragend', () => {
    dragged = null;
    for (const t of $$('.dragging, .drop-target', grid)) t.classList.remove('dragging', 'drop-target');
  });

  const sendTo = (role) => (file, onProgress) => {
    const data = new FormData();
    data.append('files', file);
    return upload(`/api/admin/properties/${id}/media?role=${role}`, data, onProgress).then((res) => {
      p = res.property;
      if (role === 'gallery') renderGallery();
      else renderSlots();
    });
  };

  setupDropzone($('#gallery-drop'), async (files) => {
    const done = await runQueue($('#gallery-queue'), files, sendTo('gallery'));
    if (done) toast(done === 1 ? 'Uploaded' : `${done} files uploaded`);
  });

  // -- site plan and brochure (one file each)
  function renderSlots() {
    const slot = (role, item, preview, accept, chooseLabel) =>
      html`<div class="slot">
        <div class="slot-preview">${preview}</div>
        <div class="stack">
          <label class="btn btn-sm dropzone-btn" id="drop-${role}">
            ${item ? 'Replace' : chooseLabel}
            <input class="visually-hidden" type="file" accept="${accept}">
          </label>
          ${item ? html`<button class="btn btn-sm btn-danger" type="button" data-remove-slot="${item.id}">Remove</button>` : ''}
        </div>
      </div>`;
    mount(
      $('#slot-plan'),
      slot(
        'plan',
        p.plan,
        p.plan ? html`<img src="${p.plan.sizes[0].url}" alt="">` : 'No site plan',
        'image/jpeg,image/png,image/webp',
        'Upload image',
      ),
    );
    mount(
      $('#slot-brochure'),
      slot(
        'brochure',
        p.brochure,
        p.brochure ? html`<a href="${p.brochure.url}" target="_blank" rel="noopener">PDF · ${fmtBytes(p.brochure.bytes)}</a>` : 'No brochure',
        'application/pdf',
        'Upload PDF',
      ),
    );
    for (const role of ['plan', 'brochure']) {
      setupDropzone($(`#drop-${role}`), (files) => runQueue($(`#queue-${role}`), files.slice(0, 1), sendTo(role)));
    }
  }

  editor.addEventListener('click', async (e) => {
    const remove = e.target.closest('[data-remove-slot]');
    if (!remove || !window.confirm('Remove this file?')) return;
    try {
      await api('DELETE', `/api/admin/media/${remove.dataset.removeSlot}`);
      p = await api('GET', `/api/admin/properties/${id}`);
      renderSlots();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // -- share panel and delete
  $('#share-panel').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) return copy(copyBtn.dataset.copy);
    if (e.target.closest('#new-private')) {
      if (!window.confirm('Make a new private link? The old private link will stop working.')) return;
      try {
        const fresh = await api('POST', `/api/admin/properties/${id}/private-link`);
        p.shareToken = fresh.shareToken;
        renderLinks();
        toast('New private link ready');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  $('#delete-property').addEventListener('click', async () => {
    if (!window.confirm(`Delete “${p.title}” with all its photos and videos? This cannot be undone.`)) return;
    try {
      await api('DELETE', `/api/admin/properties/${id}`);
      setDirty(false);
      toast('Property deleted');
      location.hash = '#/properties';
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  renderLinks();
  renderRows('details');
  renderRows('nearby');
  renderGallery();
  renderSlots();
  setDirty(false);
}

// ---------- enquiries

function contactLinks(contact) {
  if (contact.includes('@')) return html`<a class="btn btn-sm" href="mailto:${contact}">Email</a>`;
  const digits = contact.replace(/[^\d+]/g, '');
  if (digits.replace('+', '').length < 6) return '';
  return html`<a class="btn btn-sm" href="tel:${digits}">Call</a>
    <a class="btn btn-sm" href="https://wa.me/${digits.replace('+', '')}" target="_blank" rel="noopener">WhatsApp</a>`;
}

async function viewEnquiries(view) {
  let { items } = await api('GET', '/api/admin/enquiries');
  document.title = `Enquiries · ${state.me.siteName}`;

  const render = () => {
    const unread = items.filter((e) => !e.read).length;
    setUnread(unread);
    mount(
      view,
      html`<div class="page-head">
          <div><span class="label">${unread} unread</span><h1>Enquiries</h1></div>
        </div>
        ${items.length
          ? html`<div class="list">
              ${items.map(
                (e) => html`<article class="enquiry ${e.read ? '' : 'unread'}">
                  <div>
                    <div class="enquiry-name">${e.name}</div>
                    <div class="mono">${e.contact}</div>
                  </div>
                  <div class="hint">${fmtDate(e.createdAt)}</div>
                  <div class="hint enquiry-about">
                    ${e.propertyId
                      ? html`About <a href="#/properties/${e.propertyId}">${e.propertyTitle}</a>`
                      : e.propertyTitle
                        ? `About ${e.propertyTitle} (deleted)`
                        : 'General enquiry'}
                  </div>
                  ${e.message ? html`<p class="enquiry-msg">${e.message}</p>` : ''}
                  <div class="enquiry-actions">
                    ${contactLinks(e.contact)}
                    <button class="btn btn-sm" type="button" data-read="${e.id}">${e.read ? 'Mark as unread' : 'Mark as read'}</button>
                    <button class="btn btn-sm btn-danger" type="button" data-remove="${e.id}">Delete</button>
                  </div>
                </article>`,
              )}
            </div>`
          : html`<div class="empty"><h2>No enquiries yet</h2><p class="muted">Messages sent from the enquiry form on your property pages appear here.</p></div>`}`,
    );
  };

  view.onclick = async (ev) => {
    const read = ev.target.closest('[data-read]');
    const remove = ev.target.closest('[data-remove]');
    try {
      if (read) {
        const e = items.find((x) => x.id === Number(read.dataset.read));
        await api('PATCH', `/api/admin/enquiries/${e.id}`, { read: !e.read });
        e.read = !e.read;
        render();
      }
      if (remove && window.confirm('Delete this enquiry?')) {
        await api('DELETE', `/api/admin/enquiries/${remove.dataset.remove}`);
        items = items.filter((x) => x.id !== Number(remove.dataset.remove));
        render();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  render();
}

// ---------- settings

async function viewSettings(view) {
  let data = await api('GET', '/api/admin/settings');
  const s = data.settings;
  document.title = `Settings · ${state.me.siteName}`;
  const input = (name, attrs = '', cls = 'input') => html`<input class="${cls}" name="${name}" value="${s[name]}" ${new Html(attrs)}>`;
  const area = (name, rows = 4) => html`<textarea class="textarea" name="${name}" rows="${rows}">${s[name]}</textarea>`;

  mount(
    view,
    html`<div class="page-head"><div><span class="label">Site</span><h1>Settings</h1></div></div>
      <form id="settings-form" novalidate>
        <section class="panel">
          <div class="panel-head"><h2>Site</h2></div>
          <div class="grid grid-2">
            ${field('Site name', input('siteName', 'maxlength="60" required'))}
            ${field('Tagline', input('tagline', 'maxlength="80"'), 'Shown next to the name, e.g. “Real estate & land”.')}
            ${field(
              'Currency',
              html`${input('currency', 'maxlength="3" list="currencies"', 'input mono')}<datalist id="currencies">${CURRENCIES.map((c) => html`<option value="${c}"></option>`)}</datalist>`,
              '3-letter code, e.g. USD, EUR, AED.',
            )}
            ${field('Footer note', input('footerNote', 'maxlength="200"'))}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Home page</h2></div>
          <div class="grid">
            ${field('Headline', input('heroTitle', 'maxlength="120"'))}
            ${field('Intro text', area('heroText', 3))}
            <div class="stack"><span class="label">Large photo at the top</span><div id="slot-hero"></div><div class="queue" id="queue-hero"></div>
              <p class="hint">Optional. Without one, the cover of your first featured property is used.</p></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>About you</h2><p class="hint">Leave the text empty to hide the About section.</p></div>
          <div class="grid">
            ${field('Heading', input('aboutTitle', 'maxlength="120" placeholder="e.g. Sam Rivera, land and property advisor"'))}
            ${field('Text', area('aboutText', 5), 'Leave a blank line between paragraphs.')}
            <div class="stack"><span class="label">Portrait</span><div id="slot-portrait"></div><div class="queue" id="queue-portrait"></div></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>Contact</h2><p class="hint">Buttons only appear for the details you fill in.</p></div>
          <div class="grid grid-2">
            ${field('WhatsApp number', input('whatsapp', 'maxlength="40" inputmode="tel" placeholder="+971 50 123 4567"'), 'Full international number. Used for the WhatsApp buttons.')}
            ${field('Phone', input('phone', 'maxlength="40" inputmode="tel"'))}
            ${field('Email', input('email', 'maxlength="120" inputmode="email"'))}
            ${field('Office address', input('address', 'maxlength="200"'))}
            ${field('Contact heading', input('contactTitle', 'maxlength="120"'))}
            ${field('Contact text', input('contactText', 'maxlength="400"'))}
            ${field('Instagram link', input('instagram', 'maxlength="200" placeholder="https://instagram.com/…"'))}
            ${field('Facebook link', input('facebook', 'maxlength="200" placeholder="https://facebook.com/…"'))}
          </div>
        </section>
      </form>
      <div class="savebar">
        <span class="state" id="save-state">All changes saved</span>
        <button class="btn btn-primary" type="submit" form="settings-form" id="save-btn">Save settings</button>
      </div>`,
  );

  const form = $('#settings-form');
  form.addEventListener('input', (e) => {
    if (e.target.type !== 'file') setDirty(true);
  });

  function renderImageSlots() {
    for (const role of ['hero', 'portrait']) {
      const item = data[role];
      mount(
        $(`#slot-${role}`),
        html`<div class="slot">
          <div class="slot-preview">${item ? html`<img src="${item.sizes[0].url}" alt="">` : 'No image'}</div>
          <div class="stack">
            <label class="btn btn-sm" id="drop-${role}">${item ? 'Replace' : 'Upload image'}<input class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp"></label>
            ${item ? html`<button class="btn btn-sm btn-danger" type="button" data-clear="${role}">Remove</button>` : ''}
          </div>
        </div>`,
      );
      setupDropzone($(`#drop-${role}`), (files) =>
        runQueue($(`#queue-${role}`), files.slice(0, 1), (file, onProgress) => {
          const body = new FormData();
          body.append('file', file);
          return upload(`/api/admin/site-media?role=${role}`, body, onProgress).then((res) => {
            data = { ...data, hero: res.hero, portrait: res.portrait };
            renderImageSlots();
          });
        }),
      );
    }
  }

  view.onclick = async (e) => {
    const clear = e.target.closest('[data-clear]');
    if (!clear || !window.confirm('Remove this image?')) return;
    try {
      const res = await api('DELETE', `/api/admin/site-media/${clear.dataset.clear}`);
      data = { ...data, ...res };
      renderImageSlots();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const button = $('#save-btn');
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      data = await api('PUT', '/api/admin/settings', body);
      form.elements.currency.value = data.settings.currency;
      state.me.siteName = data.settings.siteName;
      $('.brand-name').textContent = data.settings.siteName;
      setDirty(false);
      toast('Settings saved');
    } catch (err) {
      if (err.field) showError(form, err.field, err.message);
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  renderImageSlots();
  setDirty(false);
}

boot();

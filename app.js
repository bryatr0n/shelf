'use strict';

/* ---------- Helpers ---------- */
const STORE_KEY = 'shelf.books.v1';
const GKEY_KEY = 'shelf.googleKey';
const STATUS_LABELS = { reading: 'Reading', want: 'TBR', finished: 'Finished', dnf: 'Did not finish' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const toInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
function localToday() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function initials(title) {
  return String(title || '?').replace(/^(the|a|an)\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
}
function stripHtml(s) {
  if (!s) return '';
  return new DOMParser().parseFromString(String(s).replace(/<br\s*\/?>|<\/p>/gi, '\n'), 'text/html').body.textContent.trim();
}
const safeStorage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- Storage ---------- */
let books = loadBooks();
function loadBooks() {
  try {
    const v = JSON.parse(safeStorage.get(STORE_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function persist() {
  if (!safeStorage.set(STORE_KEY, JSON.stringify(books))) toast('Could not save — storage unavailable');
}
// Ask the browser not to evict our data under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

/* ---------- Covers ---------- */
function coverHTML(b, size) {
  const ph = esc(initials(b.title));
  if (!b.cover) return `<span class="cover ${size} ph" aria-hidden="true">${ph}</span>`;
  return `<img class="cover ${size}" src="${esc(b.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ph="${ph}">`;
}
// Swap broken cover images for a placeholder.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.classList.contains('cover')) return;
  const span = document.createElement('span');
  span.className = img.className + ' ph';
  span.textContent = img.dataset.ph || '';
  img.replaceWith(span);
}, true);

/* ---------- Library view ---------- */
let tab = 'reading'; // always open on Reading

function sortFor(status) {
  const t = (s) => (s ? Date.parse(s) || 0 : 0);
  if (status === 'reading') return (a, b) => t(b.updatedAt) - t(a.updatedAt);
  if (status === 'finished' || status === 'dnf') return (a, b) => (t(b.finishedAt) - t(a.finishedAt)) || (t(b.updatedAt) - t(a.updatedAt));
  return (a, b) => t(b.addedAt) - t(a.addedAt);
}

function cardHTML(b) {
  const meta = [b.year, b.pages ? `${b.pages} pages` : ''].filter(Boolean).join(' · ');
  let extra = '';
  if (b.status === 'reading') {
    const pct = b.pages ? Math.min(100, Math.round(((b.progress || 0) / b.pages) * 100)) : 0;
    extra = `<span class="progress"><span style="width:${pct}%"></span></span>
      <span class="progress-row">
        <span class="meta">${b.pages ? `Page ${b.progress || 0} of ${b.pages} · ${pct}%` : `Page ${b.progress || 0}`}</span>
        <button type="button" class="update-btn" aria-label="Update page for ${esc(b.title)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/></svg>Update
        </button>
      </span>`;
  } else if ((b.status === 'finished' || b.status === 'dnf') && b.rating) {
    extra = `<span class="stars" aria-label="${b.rating} stars">${'★'.repeat(b.rating)}</span>`;
  }
  return `<div class="card" role="button" tabindex="0" data-id="${esc(b.id)}">
    ${coverHTML(b, 'sm')}
    <span class="info">
      <span class="title">${esc(b.title)}</span>
      ${b.authors ? `<span class="author">${esc(b.authors)}</span>` : ''}
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
      ${extra}
    </span>
  </div>`;
}

const EMPTY = {
  reading: 'Nothing on the nightstand.',
  want: 'Your TBR is empty.',
  finished: 'No finished books yet.',
  dnf: 'No abandoned books. Nice.',
};

function render() {
  $$('#tabs button').forEach((btn) => {
    const s = btn.dataset.status;
    btn.classList.toggle('active', s === tab);
    btn.setAttribute('aria-pressed', s === tab);
    const n = books.filter((b) => b.status === s).length;
    btn.querySelector('.count').textContent = n || '';
  });

  const list = $('#list');
  const items = books.filter((b) => b.status === tab).sort(sortFor(tab));
  if (!items.length) {
    list.innerHTML = `<div class="empty"><p>${EMPTY[tab]}</p><button class="pill-btn" data-action="search">Find a book</button></div>`;
    return;
  }

  if (tab === 'finished') {
    // Group finished books by the year they were finished.
    const groups = new Map();
    for (const b of items) {
      const y = b.finishedAt ? b.finishedAt.slice(0, 4) : 'Undated';
      if (!groups.has(y)) groups.set(y, []);
      groups.get(y).push(b);
    }
    list.innerHTML = [...groups].map(([y, bs]) =>
      `<h3 class="group-label">${esc(y)} · ${bs.length} book${bs.length === 1 ? '' : 's'}</h3>${bs.map(cardHTML).join('')}`
    ).join('');
  } else {
    list.innerHTML = items.map(cardHTML).join('');
  }
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  tab = btn.dataset.status;
  render();
  window.scrollTo({ top: 0 });
});

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="search"]')) return openSearch();
  const card = e.target.closest('.card');
  if (!card) return;
  const b = books.find((x) => x.id === card.dataset.id);
  if (!b) return;
  if (e.target.closest('.update-btn')) openProgress(b);
  else openForm(b, false);
});
$('#list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
    e.preventDefault();
    e.target.click();
  }
});

/* ---------- Reading sessions ---------- */
// Each page update is a session { at, d, from, to }. An update within 15 minutes of the
// previous one on the same book (e.g. fixing a typo) adjusts that session instead.
const SESSION_MERGE_MS = 15 * 60 * 1000;
function logSession(b, from, to) {
  if (from === to) return;
  delete b.progressLog; // replaced by sessions
  const now = new Date();
  const today = localToday();
  b.sessions = b.sessions || [];
  const last = b.sessions[b.sessions.length - 1];
  if (last && last.d === today && now - Date.parse(last.at) < SESSION_MERGE_MS) {
    last.to = to;
    last.at = now.toISOString();
    if (last.from === last.to) b.sessions.pop();
    return;
  }
  b.sessions.push({ at: now.toISOString(), d: today, from, to });
}

/* ---------- Stats ---------- */
const parseDay = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
function dayKey(date) {
  const x = new Date(date);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
function addDays(d, n) { const x = parseDay(d); x.setDate(x.getDate() + n); return dayKey(x); }
function fmtDay(d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const t = localToday();
  if (d === t) return 'Today';
  if (d === addDays(t, -1)) return 'Yesterday';
  return parseDay(d).toLocaleDateString(undefined, opts);
}
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function allSessions() {
  const out = [];
  for (const b of books) {
    for (const s of b.sessions || []) out.push({ ...s, pages: s.to - s.from, bookId: b.id, title: b.title });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function dayTotals(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const e = m.get(s.d) || { pages: 0, titles: new Set(), count: 0 };
    e.pages += s.pages;
    e.titles.add(s.title);
    e.count++;
    m.set(s.d, e);
  }
  for (const e of m.values()) e.pages = Math.max(0, e.pages); // corrections never go below zero
  return m;
}

function niceMax(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

let statsView = 'days';
const CHART_DAYS = 14;

function tilesHTML(totals) {
  const t = localToday();
  const pagesOn = (d) => (totals.get(d) || {}).pages || 0;
  let week = 0;
  for (let i = 0; i < 7; i++) week += pagesOn(addDays(t, -i));
  let sum30 = 0, days30 = 0;
  for (let i = 0; i < 30; i++) { const p = pagesOn(addDays(t, -i)); if (p > 0) { sum30 += p; days30++; } }
  // Streak: consecutive days with reading, ending today (or yesterday if today has none yet).
  let d = pagesOn(t) > 0 ? t : addDays(t, -1);
  let streak = 0;
  while (pagesOn(d) > 0) { streak++; d = addDays(d, -1); }
  const tile = (value, label) => `<div class="tile"><span class="tile-value">${value}</span><span class="tile-label">${label}</span></div>`;
  return [
    tile(pagesOn(t).toLocaleString(), 'pages today'),
    tile(week.toLocaleString(), 'pages, last 7 days'),
    tile(days30 ? Math.round(sum30 / days30).toLocaleString() : '–', 'avg per reading day (30d)'),
    tile(streak, `day streak`),
  ].join('');
}

function chartHTML(totals) {
  const t = localToday();
  const days = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const d = addDays(t, -i);
    const e = totals.get(d);
    days.push({ d, pages: e ? e.pages : 0, titles: e ? [...e.titles] : [] });
  }
  const total = days.reduce((n, x) => n + x.pages, 0);
  const top = niceMax(Math.max(...days.map((x) => x.pages)));
  const caption = `Last ${CHART_DAYS} days · ${plural(total, 'page')}`;
  const bars = days.map((x) => {
    const label = `${fmtDay(x.d)}: ${plural(x.pages, 'page')}${x.titles.length ? ` · ${x.titles.join(', ')}` : ''}`;
    return `<button type="button" class="bar-col${x.d === t ? ' today' : ''}" data-label="${esc(label)}" aria-label="${esc(label)}">
      <span class="bar" style="height:${(x.pages / top) * 100}%"></span>
    </button>`;
  }).join('');
  const xl = days.map((x) => `<span class="${x.d === t ? 'today' : ''}">${parseDay(x.d).getDate()}</span>`).join('');
  return `<figure class="chart">
    <figcaption class="chart-head">
      <span class="chart-title">Pages per day</span>
      <span id="chartCaption" class="chart-caption" data-default="${esc(caption)}">${esc(caption)}</span>
    </figcaption>
    <div class="plot">
      <span class="gridline" style="bottom:100%"><span>${top}</span></span>
      <span class="gridline" style="bottom:50%"><span>${top / 2}</span></span>
      <div class="bars">${bars}</div>
    </div>
    <div class="xlabels">${xl}</div>
  </figure>`;
}

function daysListHTML(totals) {
  const rows = [...totals.entries()].filter(([, e]) => e.pages > 0).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 90);
  if (!rows.length) return '';
  return `<h3 class="section-title">Daily log</h3><div class="log">${rows.map(([d, e]) => `
    <div class="log-row">
      <div class="log-main">
        <div class="log-title">${esc(fmtDay(d))}</div>
        <div class="log-sub">${esc([...e.titles].join(', '))}${e.count > 1 ? ` · ${e.count} sessions` : ''}</div>
      </div>
      <div class="log-num">${plural(e.pages, 'page')}</div>
    </div>`).join('')}</div>`;
}

function sessionsListHTML(sessions) {
  return `<div class="log">${sessions.slice(0, 200).map((s) => {
    const time = new Date(s.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const n = s.pages;
    return `<div class="log-row">
      <div class="log-main">
        <div class="log-title">${esc(s.title)}</div>
        <div class="log-sub">${esc(fmtDay(s.d))}, ${esc(time)} · p. ${s.from} → ${s.to}</div>
      </div>
      <div class="log-num">${n > 0 ? '+' : ''}${n.toLocaleString()}</div>
      <button type="button" class="x-btn" data-del-session="${esc(s.bookId)}|${esc(s.at)}" aria-label="Delete this session">×</button>
    </div>`;
  }).join('')}</div>`;
}

function renderStats() {
  const sessions = allSessions();
  const totals = dayTotals(sessions);
  $('#statTiles').innerHTML = tilesHTML(totals);
  const body = $('#statsBody');
  if (!sessions.length) {
    body.innerHTML = '<p class="hint">No reading logged yet.<br>Tap <strong>Update</strong> on a book you’re reading to log pages.</p>';
    return;
  }
  body.innerHTML = statsView === 'days'
    ? chartHTML(totals) + daysListHTML(totals)
    : sessionsListHTML(sessions);
}

function openStats() {
  renderStats();
  $('#statsDialog').showModal();
  $('.form-body', $('#statsDialog')).scrollTop = 0;
}

$('#statsBtn').addEventListener('click', openStats);
$('#statsDialog').addEventListener('change', (e) => {
  if (e.target.name === 'statsView') { statsView = e.target.value; renderStats(); }
});
// Chart: show the value for the bar under the finger/cursor, or the focused one.
function showBar(col) {
  const cap = $('#chartCaption');
  if (!cap) return;
  $$('.bar-col.sel', $('#statsDialog')).forEach((c) => c.classList.toggle('sel', c === col));
  if (col) col.classList.add('sel');
  cap.textContent = col ? col.dataset.label : cap.dataset.default;
}
$('#statsBody').addEventListener('click', (e) => {
  const col = e.target.closest('.bar-col');
  if (col) { showBar(col.classList.contains('sel') ? null : col); return; }
  const del = e.target.closest('[data-del-session]');
  if (!del) return;
  const [bookId, at] = del.dataset.delSession.split('|');
  const b = books.find((x) => x.id === bookId);
  if (!b || !confirm('Delete this session? Your current page stays the same.')) return;
  b.sessions = (b.sessions || []).filter((s) => s.at !== at);
  b.updatedAt = new Date().toISOString();
  persist();
  window.Sync?.changed(b.id);
  renderStats();
});
$('#statsBody').addEventListener('pointerover', (e) => {
  if (e.pointerType === 'mouse') showBar(e.target.closest('.bar-col'));
});
$('#statsBody').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') showBar(null); }, true);
$('#statsBody').addEventListener('focusin', (e) => { const c = e.target.closest('.bar-col'); if (c) showBar(c); });

/* ---------- Quick progress update ---------- */
const pgForm = $('#progressForm');
let pgBook = null;

function pgRefresh() {
  const p = toInt(pgForm.elements.page.value);
  const total = pgBook.pages;
  const pct = p != null && total ? Math.min(100, Math.round((p / total) * 100)) : null;
  const delta = p != null ? p - (pgBook.progress || 0) : 0;
  $('#pgPct').textContent = [
    pct != null ? `${pct}%` : '',
    delta > 0 ? `+${delta} page${delta === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') || ' ';
  $('#pgFinish').hidden = !(total && p != null && p >= total);
}

function openProgress(b) {
  pgBook = b;
  $('#pgTitle').textContent = b.title;
  $('#pgOf').textContent = b.pages ? `of ${b.pages}` : '';
  pgForm.elements.page.value = b.progress || '';
  pgForm.elements.page.max = b.pages || '';
  pgRefresh();
  $('#progressDialog').showModal();
  // Focus synchronously (still inside the tap) so iOS opens the number keyboard.
  pgForm.elements.page.focus();
  pgForm.elements.page.select();
}

function saveProgress(finish) {
  const b = books.find((x) => x.id === pgBook.id);
  if (!b) return;
  let page = toInt(pgForm.elements.page.value);
  if (page == null || page < 0) { pgForm.elements.page.focus(); return; }
  if (b.pages) page = Math.min(page, b.pages);
  const today = localToday();
  logSession(b, b.progress || 0, page);
  b.progress = page;
  if (finish) {
    b.status = 'finished';
    b.finishedAt = b.finishedAt || today;
    b.startedAt = b.startedAt || today;
  }
  b.updatedAt = new Date().toISOString();
  persist();
  window.Sync?.changed(b.id);
  $('#progressDialog').close();
  if (finish) {
    tab = 'finished';
    render();
    openForm(b, false); // so a rating can be added straight away
    toast('Finished! Add a rating?');
  } else {
    render();
    toast(b.pages ? `Page ${page} · ${Math.round((page / b.pages) * 100)}%` : `Page ${page}`);
  }
}

pgForm.addEventListener('input', pgRefresh);
pgForm.addEventListener('submit', (e) => { e.preventDefault(); saveProgress(false); });
$('#pgFinish').addEventListener('click', () => saveProgress(true));

/* ---------- Book search (Google Books + Open Library) ---------- */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function matchKey(b) {
  const t = norm(String(b.title || '').split(':')[0]).replace(/^(the|a|an) /, '');
  const a = norm(String(b.authors || '').split(',')[0]).split(' ').pop() || '';
  return `${t}|${a}`;
}
const isIsbn = (q) => /^[\d\s-]{10,17}[\dxX]?$/.test(q.trim()) && [10, 13].includes(q.replace(/[^\dxX]/g, '').length);

async function fetchJSON(url, ms = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const olIsbnCover = (isbn) => `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;

async function googleSearch(q) {
  const query = isIsbn(q) ? `isbn:${q.replace(/[^\dxX]/g, '')}` : q;
  const key = (safeStorage.get(GKEY_KEY) || '').trim();
  const data = await fetchJSON(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=25&printType=books${key ? `&key=${encodeURIComponent(key)}` : ''}`);
  return (data.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const isbn = (ids.find((i) => i.type === 'ISBN_13') || ids.find((i) => i.type === 'ISBN_10') || {}).identifier || '';
    let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
    // Upgrade to https and request a larger rendition.
    if (cover) cover = cover.replace(/^http:/, 'https:').replace('&edge=curl', '') + '&fife=w400-h600';
    else if (isbn) cover = olIsbnCover(isbn);
    return {
      title: v.title || 'Untitled',
      subtitle: v.subtitle || '',
      authors: (v.authors || []).join(', '),
      year: toInt((v.publishedDate || '').slice(0, 4)),
      pages: v.pageCount || null,
      publisher: v.publisher || '',
      isbn,
      genres: (v.categories || []).join(', '),
      description: stripHtml(v.description),
      cover,
      source: 'google',
    };
  });
}

async function openLibrarySearch(q) {
  const fields = 'key,title,subtitle,author_name,first_publish_year,number_of_pages_median,cover_i,isbn,publisher,subject';
  const param = isIsbn(q) ? `isbn=${encodeURIComponent(q.replace(/[^\dxX]/g, ''))}` : `q=${encodeURIComponent(q)}`;
  const data = await fetchJSON(`https://openlibrary.org/search.json?${param}&limit=20&fields=${fields}`);
  return (data.docs || []).map((d) => {
    const isbn = (d.isbn || []).find((i) => i.length === 13) || (d.isbn || [])[0] || '';
    return {
      title: d.title || 'Untitled',
      subtitle: d.subtitle || '',
      authors: (d.author_name || []).slice(0, 3).join(', '),
      year: d.first_publish_year || null,
      pages: d.number_of_pages_median || null,
      publisher: (d.publisher || [])[0] || '',
      isbn,
      genres: (d.subject || []).slice(0, 3).join(', '),
      description: '',
      cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : '',
      olKey: d.key || '',
      source: 'openlibrary',
    };
  });
}

/**
 * Query both sources in parallel. Google Books has better relevance, page counts and
 * descriptions; Open Library knows the *original* publication year and has good covers.
 * Merge them by title + author, and collapse duplicate editions.
 */
async function searchBooks(q) {
  const [g, o] = await Promise.allSettled([googleSearch(q), openLibrarySearch(q)]);
  if (g.status === 'rejected' && o.status === 'rejected') throw g.reason;
  const gb = g.status === 'fulfilled' ? g.value : [];
  const ol = o.status === 'fulfilled' ? o.value : [];

  const olByKey = new Map();
  for (const b of ol) if (!olByKey.has(matchKey(b))) olByKey.set(matchKey(b), b);

  const out = [];
  const seen = new Map();
  const fill = (target, src) => {
    for (const k of ['pages', 'cover', 'isbn', 'publisher', 'genres', 'description', 'subtitle', 'olKey']) {
      if (!target[k] && src[k]) target[k] = src[k];
    }
    if (src.year && (!target.year || src.year < target.year)) target.year = src.year;
  };

  for (const b of gb) {
    const k = matchKey(b);
    const m = olByKey.get(k);
    if (m) fill(b, m);
    if (seen.has(k)) { fill(seen.get(k), b); continue; }
    seen.set(k, b);
    out.push(b);
  }
  for (const b of ol) {
    const k = matchKey(b);
    if (!seen.has(k)) { seen.set(k, b); out.push(b); }
  }
  return out.slice(0, 30);
}

let lastResults = [];
let searchSeq = 0;
let searchTimer;

function openSearch() {
  $('#searchInput').value = '';
  $('#results').innerHTML = '<p class="hint">Search by title, author, or ISBN.</p>';
  $('#searchDialog').showModal();
  setTimeout(() => $('#searchInput').focus(), 50);
}

function inLibrary(r) {
  const k = matchKey(r);
  return books.find((b) => matchKey(b) === k);
}

async function runSearch(q) {
  q = q.trim();
  const seq = ++searchSeq;
  const box = $('#results');
  if (q.length < 2) { box.innerHTML = '<p class="hint">Search by title, author, or ISBN.</p>'; return; }
  box.innerHTML = '<p class="hint">Searching…</p>';
  try {
    const found = await searchBooks(q);
    if (seq !== searchSeq) return; // a newer search has started
    lastResults = found;
    if (!found.length) { box.innerHTML = '<p class="hint">No matches. Try fewer words, or add it manually.</p>'; return; }
    box.innerHTML = found.map((r, i) => {
      const meta = [r.year, r.pages ? `${r.pages} pages` : ''].filter(Boolean).join(' · ');
      const owned = inLibrary(r);
      return `<button class="result" data-i="${i}">
        ${coverHTML(r, 'sm')}
        <span class="info">
          <span class="title">${esc(r.title)}</span>
          ${r.authors ? `<span class="author">${esc(r.authors)}</span>` : ''}
          ${meta ? `<span class="meta">${esc(meta)}</span>` : ''}
          ${owned ? `<span class="in-lib">On your shelf · ${esc(STATUS_LABELS[owned.status])}</span>` : ''}
        </span>
      </button>`;
    }).join('');
  } catch (err) {
    if (seq !== searchSeq) return;
    console.warn(err);
    box.innerHTML = '<p class="hint">Search failed. Check your connection and try again.</p>';
  }
}

$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 450);
});
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  $('#searchInput').blur(); // dismiss the iOS keyboard
  runSearch($('#searchInput').value);
});
$('#results').addEventListener('click', (e) => {
  const el = e.target.closest('.result');
  if (!el) return;
  const r = lastResults[+el.dataset.i];
  const owned = inLibrary(r);
  if (owned) return openForm(owned, false);
  openForm({ ...r, status: tab === 'reading' ? 'reading' : 'want' }, true);
  if (!r.description && r.olKey) fillOpenLibraryDescription(r);
});

// Open Library's search API has no descriptions; fetch it from the work record.
async function fillOpenLibraryDescription(r) {
  try {
    const w = await fetchJSON(`https://openlibrary.org${r.olKey}.json`);
    let d = w.description;
    if (d && typeof d === 'object') d = d.value;
    d = String(d || '').replace(/\r/g, '').split(/\n-{3,}|\n\*\*|\n\(\[source\]/)[0].trim();
    if (!d) return;
    r.description = d;
    const field = form.elements.description;
    if ($('#bookDialog').open && editing && editing.isNew && !field.value) field.value = d;
  } catch { /* optional enrichment */ }
}
$('#manualBtn').addEventListener('click', () => {
  const q = $('#searchInput').value.trim();
  openForm({ title: q, status: tab === 'reading' ? 'reading' : 'want', source: 'manual' }, true);
});

/* ---------- Add / edit form ---------- */
const form = $('#bookForm');
let editing = null; // { id, isNew, source }

function setRating(n) {
  form.elements.rating.value = n || '';
  $$('#stars button').forEach((b) => b.classList.toggle('on', +b.dataset.v <= (n || 0)));
}
$('#stars').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const v = +b.dataset.v;
  setRating(+form.elements.rating.value === v ? 0 : v); // tap the same star again to clear
});

function syncStatusFields() {
  const status = form.elements.status.value;
  $$('[data-for]', form).forEach((el) => {
    el.toggleAttribute('data-hidden', !el.dataset.for.split(' ').includes(status));
  });
  updatePct();
}
function updatePct() {
  const p = toInt(form.elements.progress.value);
  const total = toInt(form.elements.pages.value);
  $('#pctOut').textContent = p != null && total ? `${Math.min(100, Math.round((p / total) * 100))}%` : '–';
}
function updateCoverPreview() {
  const url = form.elements.cover.value.trim();
  $('#coverPreview').innerHTML = coverHTML({ title: form.elements.title.value, cover: url }, 'lg');
}

function openForm(data, isNew) {
  editing = { id: data.id || null, isNew, source: data.source || 'manual' };
  form.reset();
  for (const el of form.elements) {
    if (!el.name || el.type === 'radio') continue;
    el.value = data[el.name] ?? '';
  }
  form.elements.status.value = data.status || 'want';
  setRating(data.rating || 0);
  $('#bookFormTitle').textContent = isNew ? 'Add book' : 'Edit book';
  $('#deleteBtn').hidden = isNew;
  syncStatusFields();
  updateCoverPreview();
  const dlg = $('#bookDialog');
  if (!dlg.open) dlg.showModal();
  $('.form-body', form).scrollTop = 0;
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'status') syncStatusFields();
  if (e.target.name === 'cover') updateCoverPreview();
});
form.addEventListener('input', (e) => {
  if (e.target.name === 'progress' || e.target.name === 'pages') updatePct();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form.elements;
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); toast('A title is required'); return; }

  const now = new Date().toISOString();
  const existing = editing.id ? books.find((b) => b.id === editing.id) : null;
  const status = f.status.value;
  const book = {
    ...(existing || {}),
    id: existing ? existing.id : uid(),
    title,
    subtitle: f.subtitle.value.trim(),
    authors: f.authors.value.trim(),
    series: f.series.value.trim(),
    year: toInt(f.year.value),
    pages: toInt(f.pages.value),
    publisher: f.publisher.value.trim(),
    isbn: f.isbn.value.trim(),
    genres: f.genres.value.trim(),
    cover: f.cover.value.trim(),
    description: f.description.value.trim(),
    status,
    progress: toInt(f.progress.value) || 0,
    startedAt: f.startedAt.value || null,
    finishedAt: f.finishedAt.value || null,
    rating: toInt(f.rating.value) || 0,
    notes: f.notes.value.trim(),
    source: existing ? existing.source : editing.source,
    addedAt: existing ? existing.addedAt : now,
    updatedAt: now,
  };

  // Sensible automatic dates when the status changes.
  const prev = existing ? existing.status : null;
  if (status !== prev) {
    if (status === 'reading' && !book.startedAt) book.startedAt = localToday();
    if ((status === 'finished' || status === 'dnf') && !book.finishedAt) book.finishedAt = localToday();
    if (status === 'finished' && book.pages) book.progress = book.pages;
  }
  if (status === 'want') { book.startedAt = null; book.finishedAt = null; book.progress = 0; }
  if (status === 'reading') book.finishedAt = null;

  // Page changes on a book you were reading count as a reading session.
  if (existing && prev === 'reading' && status !== 'want') {
    logSession(book, existing.progress || 0, book.progress || 0);
  }

  if (existing) Object.assign(existing, book);
  else books.push(book);
  persist();
  window.Sync?.changed(book.id);

  $('#bookDialog').close();
  if ($('#searchDialog').open) $('#searchDialog').close();
  tab = status;
  render();
  toast(existing ? 'Saved' : `Added to ${STATUS_LABELS[status]}`);
});

$('#deleteBtn').addEventListener('click', () => {
  if (!editing || !editing.id) return;
  const b = books.find((x) => x.id === editing.id);
  if (!b || !confirm(`Delete “${b.title}” from your library?`)) return;
  books = books.filter((x) => x.id !== editing.id);
  persist();
  window.Sync?.removed(b.id);
  $('#bookDialog').close();
  render();
  toast('Deleted');
});

/* ---------- Menu: stats, export, import ---------- */
function openMenu() {
  const year = new Date().getFullYear().toString();
  const finished = books.filter((b) => b.status === 'finished');
  const thisYear = finished.filter((b) => (b.finishedAt || '').startsWith(year));
  const pages = thisYear.reduce((n, b) => n + (b.pages || 0), 0);
  $('#stats').textContent = `${books.length} book${books.length === 1 ? '' : 's'} in your library. ` +
    `${thisYear.length} finished in ${year}${pages ? ` (${pages.toLocaleString()} pages)` : ''}.`;
  $('#googleKey').value = safeStorage.get(GKEY_KEY) || '';
  window.Sync?.renderBox();
  $('#menuDialog').showModal();
}
$('#googleKey').addEventListener('change', (e) => {
  safeStorage.set(GKEY_KEY, e.target.value.trim());
  toast('API key saved');
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'shelf', version: 1, exportedAt: new Date().toISOString(), books }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `shelf-backup-${localToday()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.books;
    if (!Array.isArray(incoming)) throw new Error('No books found in file');
    // Merge by id; the most recently updated copy wins.
    const byId = new Map(books.map((b) => [b.id, b]));
    let added = 0, updated = 0;
    const touched = [];
    for (const b of incoming) {
      if (!b || !b.id || !b.title) continue;
      const cur = byId.get(b.id);
      if (!cur) { byId.set(b.id, b); added++; touched.push(b.id); }
      else if ((Date.parse(b.updatedAt) || 0) > (Date.parse(cur.updatedAt) || 0)) { byId.set(b.id, b); updated++; touched.push(b.id); }
    }
    books = [...byId.values()];
    persist();
    if (touched.length) window.Sync?.changed(...touched);
    render();
    $('#menuDialog').close();
    toast(`Imported: ${added} new, ${updated} updated`);
  } catch (err) {
    console.warn(err);
    alert('That file could not be imported. Make sure it is a Shelf backup (.json).');
  }
});

/* ---------- Dialog plumbing ---------- */
$('#addBtn').addEventListener('click', openSearch);
$('#menuBtn').addEventListener('click', openMenu);
$$('dialog').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { e.preventDefault(); dlg.close(); return; }
    // Click on the backdrop closes the dialog. While typing, it only dismisses the
    // keyboard instead, so a stray tap can't throw away what was entered.
    if (e.target === dlg) {
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside) return;
      if (dlg._wasTyping) dlg._wasTyping = false; // first tap just closed the keyboard
      else dlg.close();
    }
  });
  // Record focus state when the finger touches down: by the time "click" fires,
  // the browser has already moved focus off the input.
  dlg.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    dlg._wasTyping = e.target === dlg && Boolean(active && dlg.contains(active) && active.matches('input, textarea'));
  });
});

// Remember whether the last interaction was touch/mouse or keyboard (for focus rings).
document.addEventListener('pointerdown', () => document.documentElement.classList.add('pointer'), true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') document.documentElement.classList.remove('pointer');
}, true);

/* ---------- Boot ---------- */
render();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

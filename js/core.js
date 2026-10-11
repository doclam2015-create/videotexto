'use strict';
// Glosa — utilidades base: almacenamiento (IndexedDB), ajustes, interfaz y puente con la app de Mac.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const icon = (n, cls = '') => `<svg class="ic ${cls}"><use href="#i-${n}"/></svg>`;

// ---------- tiempo ----------
function fmtT(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(sec / 3600), mm = Math.floor(sec % 3600 / 60), ss = sec % 60;
  return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
}
function parseT(s) {
  if (typeof s === 'number') return s;
  const p = String(s).trim().split(':').map(Number);
  return p.reduce((a, b) => a * 60 + b, 0);
}
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  const hh = Math.floor(sec / 3600), mm = Math.round(sec % 3600 / 60);
  return hh ? `${hh} h ${mm} min` : `${Math.max(1, mm)} min`;
}
function relDate(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'ahora';
  if (d < 3600) return `hace ${Math.floor(d / 60)} min`;
  if (d < 86400) return `hace ${Math.floor(d / 3600)} h`;
  if (d < 86400 * 7) return `hace ${Math.floor(d / 86400)} d`;
  return new Date(ts).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- IndexedDB ----------
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('glosa', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('videos', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('kv');
      };
      r.onsuccess = () => res(this._db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      const q = fn(s);
      t.oncomplete = () => res(q && 'result' in q ? q.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  get: (st, k) => DB.tx(st, 'readonly', s => s.get(k)),
  all: st => DB.tx(st, 'readonly', s => s.getAll()),
  put: (st, v, k) => DB.tx(st, 'readwrite', s => k === undefined ? s.put(v) : s.put(v, k)),
  del: (st, k) => DB.tx(st, 'readwrite', s => s.delete(k)),
  clear: st => DB.tx(st, 'readwrite', s => s.clear()),
};
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

// ---------- ajustes ----------
const Settings = {
  defaults: {
    key: '', model: 'gemini-flash-latest', lang: 'es', chunk: 1200, conc: 2, res: 'low', src: 'ai',
    theme: 'auto', font: 17, follow: true, speakers: true, vault: 'obsidian vault', folder: 'research/videos',
    keepFiles: true, usage: {}, fallback: 'codex',
  },
  load() {
    try { return Object.assign({}, this.defaults, JSON.parse(localStorage.getItem('glosa_settings') || '{}')); }
    catch { return { ...this.defaults }; }
  },
};
let S = Settings.load();
function saveSettings(patch) {
  Object.assign(S, patch);
  try { localStorage.setItem('glosa_settings', JSON.stringify(S)); } catch {}
}
function addUsage(u) {
  if (!u) return;
  const day = new Date().toISOString().slice(0, 10);
  const d = S.usage[day] || { in: 0, out: 0, n: 0 };
  d.in += u.promptTokenCount || 0; d.out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); d.n++;
  S.usage = { [day]: d };
  saveSettings({});
}

function applyTheme() {
  const t = S.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : S.theme;
  document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty('--fs', S.font + 'px');
  $('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#f6f5fb' : '#0e0d14');
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

// ---------- puente con Mac ----------
const native = !!window.webkit?.messageHandlers?.glosa;
function bridge(op, args = {}) {
  return window.webkit.messageHandlers.glosa.postMessage({ op, ...args });
}
const nativeListeners = new Set();
window.__glosaEvt = e => nativeListeners.forEach(f => f(e));

// ---------- interfaz ----------
function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind, html: msg });
  $('#toasts').append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, kind === 'err' ? 6000 : 2600);
}

function sheet(title, body, { wide = false, onClose } = {}) {
  const close = () => { wrap.classList.remove('in'); setTimeout(() => wrap.remove(), 250); onClose?.(); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); };
  const card = h('div', { class: 'sheet' + (wide ? ' wide' : '') },
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', html: icon('x'), onclick: close })),
    h('div', { class: 'sheet-body' }, body));
  const wrap = h('div', { class: 'scrim', onclick: e => { if (e.target === wrap) close(); } }, card);
  document.body.append(wrap);
  document.addEventListener('keydown', key);
  requestAnimationFrame(() => wrap.classList.add('in'));
  return { close, el: card };
}

function confirmBox(msg, ok = 'Aceptar', danger = false) {
  return new Promise(res => {
    let done = false;
    const s = sheet('Confirmar', h('div', {},
      h('p', { class: 'muted', html: msg }),
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => { done = true; res(false); s.close(); } }, 'Cancelar'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; res(true); s.close(); } }, ok))),
      { onClose: () => !done && res(false) });
  });
}

function menu(anchor, items) {
  $$('.pop').forEach(p => p.remove());
  const pop = h('div', { class: 'pop' });
  for (const it of items) {
    if (it === '-') { pop.append(h('hr')); continue; }
    pop.append(h('button', { class: it.danger ? 'danger' : '', html: icon(it.icon || 'dot') + `<span>${esc(it.label)}</span>`, onclick: () => { pop.remove(); it.run(); } }));
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = Math.min(r.left, innerWidth - pw - 12), y = r.bottom + 6;
  if (y + ph > innerHeight - 12) y = Math.max(12, r.top - ph - 6);
  pop.style.left = Math.max(12, x) + 'px'; pop.style.top = y + 'px';
  requestAnimationFrame(() => pop.classList.add('in'));
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

async function copyText(t, msg = 'Copiado') {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = t; document.body.append(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(icon('check') + ' ' + msg);
}

async function saveFile(name, text, mime = 'text/plain') {
  if (native) { try { await bridge('save', { name, text }); } catch (e) { toast(esc(e.message || e), 'err'); } return; }
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const file = new File([blob], name, { type: mime });
  if (navigator.maxTouchPoints > 1 && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// Markdown mínimo → HTML (encabezados, listas, negrita, cursiva, enlaces y marcas de tiempo [m:ss])
function md(src) {
  const inline = s => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\[?\b((?:\d{1,2}:)?\d{1,2}:\d{2})\b\]?/g, '<button class="ts" data-t="$1">$1</button>');
  const out = []; let list = null;
  for (const raw of String(src || '').split('\n')) {
    const l = raw.trimEnd();
    const m = l.match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
    if (m) {
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline(m[2])}</li>`); continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    const hd = l.match(/^(#{1,4})\s+(.*)/);
    if (hd) out.push(`<h${hd[1].length + 2}>${inline(hd[2])}</h${hd[1].length + 2}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function normUrl(u) {
  u = String(u || '').trim().replace(/[),.;:!?»”]+$/, '');
  if (!u) return '';
  if (!/^[a-z]+:\/\//i.test(u)) {
    if (/^@\w/.test(u)) return '';
    if (!/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(u)) return '';
    u = 'https://' + u;
  }
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}

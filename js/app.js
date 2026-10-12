'use strict';
// VideoTexto — interfaz: inicio + biblioteca, vista de video con reproductor sincronizado y pestañas de análisis.

const VERSION = '1.2';
const SRC_LABEL = { desc: 'Descripción', pantalla: 'En pantalla', voz: 'Dicho en voz', mencionado: 'Mencionado', 'página': 'Página' };
const SPK_COLORS = ['#ff7a59', '#7c6cff', '#2ec5a6', '#f5b83d', '#ff5c8a', '#3fa7ff', '#a3d65c', '#c77dff'];

// =====================================================================
// Reproductor (YouTube IFrame API o <video>)
// =====================================================================
let ytApi;
function loadYT() {
  if (ytApi) return ytApi;
  ytApi = new Promise(res => {
    if (window.YT?.Player) return res(window.YT);
    window.onYouTubeIframeAPIReady = () => res(window.YT);
    document.head.append(h('script', { src: 'https://www.youtube.com/iframe_api' }));
  });
  return ytApi;
}

// Obtiene la duración con un reproductor oculto (sin costo de IA)
async function probeYTDuration(id) {
  try {
    const YT = await Promise.race([loadYT(), sleep(8000).then(() => null)]);
    if (!YT) return 0;
    return await new Promise(res => {
      const box = h('div', { style: 'position:fixed;left:-9999px;top:0;width:320px;height:180px' }, h('div'));
      document.body.append(box);
      let p;
      const done = d => { clearTimeout(to); try { p.destroy(); } catch {} box.remove(); res(d || 0); };
      const to = setTimeout(() => done(p?.getDuration?.() || 0), 10000);
      p = new YT.Player(box.firstChild, {
        videoId: id, playerVars: { playsinline: 1, mute: 1, origin: location.origin },
        events: {
          onReady: () => { const d = p.getDuration(); if (d) done(d); else { p.mute(); p.playVideo(); } },
          onStateChange: () => { const d = p.getDuration(); if (d) { p.stopVideo(); done(d); } },
          onError: () => done(0),
        },
      });
    });
  } catch { return 0; }
}

const Player = {
  kind: null, yt: null, el: null, rate: 1,
  async mount(v, host) {
    this.destroy();
    host.innerHTML = '';
    if (v.kind === 'yt' && v.ytId) {
      this.kind = 'yt';
      const div = h('div'); host.append(div);
      const YT = await loadYT();
      await new Promise(res => {
        this.yt = new YT.Player(div, {
          videoId: v.ytId, width: '100%', height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin, start: v.resume ? Math.floor(v.resume) : undefined },
          events: { onReady: res, onError: res },
        });
      });
      return;
    }
    let src = v.mediaUrl;
    if (!src && v.hasBlob) { const b = await DB.get('blobs', v.id); if (b) src = this.objUrl = URL.createObjectURL(b); }
    if (src) {
      this.kind = 'video';
      this.el = h('video', { src, controls: true, playsinline: true, preload: 'metadata' });
      if (/audio/.test(v.file?.mime || '')) this.el.poster = v.thumb || '';
      host.append(this.el);
      if (v.resume) this.el.currentTime = v.resume;
      return;
    }
    this.kind = 'none';
    host.append(h('div', { class: 'noplayer', html: (v.thumb ? `<img src="${esc(v.thumb)}" alt="">` : '') + `<div>${icon('play')}<span>${v.url ? 'Abrir el video original' : 'Vuelve a elegir el archivo para reproducirlo'}</span></div>`, onclick: () => v.url ? window.open(v.url, '_blank') : null }));
  },
  destroy() {
    try { this.yt?.destroy(); } catch {}
    if (this.objUrl) URL.revokeObjectURL(this.objUrl);
    this.yt = this.el = this.objUrl = null; this.kind = null;
  },
  time() {
    if (this.kind === 'yt') return this.yt?.getCurrentTime?.() || 0;
    if (this.kind === 'video') return this.el.currentTime || 0;
    return 0;
  },
  playing() {
    if (this.kind === 'yt') return this.yt?.getPlayerState?.() === 1;
    if (this.kind === 'video') return !this.el.paused;
    return false;
  },
  seek(t, play = true) {
    t = Math.max(0, t);
    if (this.kind === 'yt' && this.yt?.seekTo) { this.yt.seekTo(t, true); if (play) this.yt.playVideo(); }
    else if (this.kind === 'video') { this.el.currentTime = t; if (play) this.el.play().catch(() => {}); }
    else if (View.v?.url) window.open(View.v.kind === 'yt' ? `https://youtu.be/${View.v.ytId}?t=${Math.floor(t)}` : View.v.url, '_blank');
  },
  toggle() {
    if (this.kind === 'yt') this.playing() ? this.yt.pauseVideo() : this.yt.playVideo();
    else if (this.kind === 'video') this.el.paused ? this.el.play() : this.el.pause();
  },
  setRate(r) {
    this.rate = r;
    if (this.kind === 'yt') this.yt?.setPlaybackRate?.(r);
    else if (this.kind === 'video') this.el.playbackRate = r;
  },
};

// =====================================================================
// Trabajos de análisis
// =====================================================================
const Jobs = {
  queue: [], active: null,
  add(task) { this.queue.push(task); this.next(); },
  async next() {
    if (this.active || !this.queue.length) return;
    const task = this.queue.shift();
    this.active = { ctrl: new AbortController(), task };
    try { await task(this.active.ctrl.signal); }
    catch (e) { if (e.name !== 'AbortError') console.error(e); }
    this.active = null;
    this.next();
  },
  cancel() { this.active?.ctrl.abort(); },
};

async function saveV(v) { v.updated = Date.now(); await DB.put('videos', JSON.parse(JSON.stringify(v))); }

function step(v, text, pct) {
  v.step = text; if (pct != null) v.pct = pct;
  if (View.v?.id === v.id) { View.v = v; View.progress(); }
}

async function startInput(input, opts = {}) {
  const src = Engine.parse(input);
  if (!src) { toast('Pega un enlace válido de YouTube o de una página web con video', 'err'); return; }
  if (!S.key && !native) { toast('Primero agrega tu clave gratuita de Gemini', 'err'); App.settings(); return; }
  // enlaces que pueden tener varios videos o pedir inicio de sesión: se exploran antes
  if (src.kind === 'web' && !opts.single) {
    const found = await discover(src, opts.cred);
    if (!found) return;
    if (found.auth) {
      if (opts.authTried) { toast('Sigo sin poder entrar a la página. Revisa tu sesión o sube el video.', 'err'); return; }
      const cred = await authFlow(src, found);
      if (!cred) return;
      return startInput(input, { ...opts, cred, authTried: true });
    }
    if (found.items.length > 1) {
      const sel = await pickVideos(src, found);
      if (!sel.length) return;
      for (const it of sel) await startInput(it.url, { single: true, batch: sel.length > 1, cred: opts.cred, title: it.title, pageUrl: src.url });
      if (sel.length > 1) { toast(`${sel.length} videos en cola; se procesan uno tras otro`); location.hash = ''; }
      return;
    }
    if (found.items.length === 1 && Engine.parse(found.items[0].url)?.kind === 'yt' && !found.native) return startInput(found.items[0].url, { ...opts, single: true, pageUrl: src.url });
    src.info = found.info;
  }
  src.cred = opts.cred;
  const id = src.kind === 'yt' ? 'yt-' + src.id : 'w-' + (await hash(src.url));
  const old = await DB.get('videos', id);
  if (old && (old.status === 'done' || (old.status === 'working' && opts.batch))) {
    if (!opts.batch) { location.hash = 'v=' + id; toast('Ya estaba en tu biblioteca'); }
    return;
  }
  const v = old || { id, kind: src.kind, url: src.url, title: opts.title || (src.kind === 'yt' ? 'Video de YouTube' : domainOf(src.url)), added: Date.now(), segments: [], screen: [], chat: [], marks: {}, notes: '', tr: {}, done: {} };
  if (src.kind === 'yt') { v.ytId = src.id; v.thumb = `https://i.ytimg.com/vi/${src.id}/hqdefault.jpg`; v.resume = src.start || 0; }
  if (opts.pageUrl) v.pageUrl = opts.pageUrl;
  v.status = 'working'; v.error = ''; v.segments = []; v.screen = []; v.step = 'En cola…';
  await saveV(v);
  if (!opts.batch) location.hash = 'v=' + id;
  else App.renderLib();
  Jobs.add(signal => runPipeline(v, src, signal));
}

// Explora el enlace: ¿cuántos videos tiene? ¿pide iniciar sesión?
async function discover(src, cred) {
  const t = toastProgress(src.list ? 'Leyendo la lista de videos…' : 'Buscando videos en la página…');
  try {
    if (native) {
      try {
        const r = await bridge('list', { url: src.url, ...(cred || {}) });
        if (r.auth) return { auth: true, msg: r.error };
        if (r.entries?.length) return { items: r.entries.map(e => ({ url: e.url, title: e.title, duration: e.duration, thumb: e.thumb, section: e.section })), native: true, title: r.title };
        if (r.single) return { items: [], native: true };
      } catch (e) { console.warn(e); }
    }
    const info = await Engine.pageInfo(src.url, {}).catch(() => null);
    if (info?.requires_login || (info && !info._ok && !info.videos?.length)) return { auth: true, info };
    const seen = new Set(), items = [];
    for (const x of info?.videos || []) {
      let u; try { u = new URL(x.url, src.url).href; } catch { continue; }
      const p = Engine.parse(u), k = p?.kind === 'yt' ? p.id : u;
      if (seen.has(k)) continue; seen.add(k);
      items.push({ url: u, title: x.title, duration: +x.duration_seconds || 0, thumb: p?.kind === 'yt' ? `https://i.ytimg.com/vi/${p.id}/mqdefault.jpg` : x.thumbnail, section: x.section, kind: x.kind });
    }
    return { items, info, title: info?.title };
  } finally { t.done(); }
}

function pickVideos(src, found) {
  return new Promise(res => {
    let done = false;
    const items = found.items, sel = new Set();
    const count = h('b');
    const go = h('button', { class: 'btn primary', onclick: () => { done = true; res(items.filter((_, i) => sel.has(i))); s.close(); } });
    const upd = () => { count.textContent = `${sel.size} de ${items.length} seleccionados`; go.innerHTML = icon('sparkle') + (sel.size > 1 ? `Transcribir ${sel.size} videos` : 'Transcribir'); go.disabled = !sel.size; go.style.opacity = sel.size ? 1 : .5; };
    const list = h('div', { class: 'picker' });
    let lastSec = null;
    items.forEach((it, i) => {
      if (it.section && it.section !== lastSec) { list.append(h('div', { class: 'pick-sec' }, it.section)); lastSec = it.section; }
      const cb = h('input', { type: 'checkbox', onchange: e => { e.target.checked ? sel.add(i) : sel.delete(i); upd(); } });
      list.append(h('label', { class: 'pick', 'data-q': ((it.title || '') + ' ' + (it.section || '')).toLowerCase() }, cb,
        it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy', onerror: e => e.target.replaceWith(h('div', { class: 'pick-ph', html: icon('play') })) }) : h('div', { class: 'pick-ph', html: icon('play') }),
        h('div', { class: 'pick-b' }, h('b', {}, it.title || domainOf(it.url)), h('small', {}, [it.duration ? fmtT(it.duration) : '', domainOf(it.url)].filter(Boolean).join(' · ')))));
    });
    const all = on => { $$('input', list).forEach((c, i) => { if (c.closest('.pick').hidden) return; c.checked = on; on ? sel.add(i) : sel.delete(i); }); upd(); };
    const body = h('div', {},
      h('p', { class: 'muted' }, `Encontré ${items.length} videos${found.title ? ' en «' + found.title + '»' : ''}. Elige cuáles quieres transcribir y analizar.`),
      h('div', { class: 'row wrap' },
        h('div', { class: 'search sm grow' }, h('span', { html: icon('search') }), h('input', { type: 'search', placeholder: 'Filtrar por título', oninput: e => { const q = e.target.value.toLowerCase(); $$('.pick', list).forEach(l => { l.hidden = q && !l.dataset.q.includes(q); }); } })),
        h('button', { class: 'chip', onclick: () => all(true) }, 'Todos'),
        h('button', { class: 'chip', onclick: () => all(false) }, 'Ninguno')),
      list,
      h('div', { class: 'row end sticky-actions' }, count, h('span', { class: 'grow' }), go));
    const s = sheet('Elige los videos', body, { wide: true, onClose: () => !done && res([]) });
    upd();
  });
}

// Inicio de sesión: en el Mac se abre la página para entrar (o usuario y contraseña para yt-dlp);
// en iPad/iPhone se abre la página y se ofrece subir el video.
function authFlow(src, found) {
  return new Promise(res => {
    let done = false;
    const finish = v => { done = true; res(v); s.close(); };
    const user = h('input', { autocomplete: 'username', placeholder: 'Usuario o correo' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Contraseña' });
    const body = h('div', {},
      h('p', {}, `«${domainOf(src.url)}» pide iniciar sesión para ver el video.`),
      native ? h('div', {},
        h('div', { class: 'card' }, h('b', {}, 'Opción 1 · Iniciar sesión en la página'),
          h('p', { class: 'muted small' }, 'Se abre la página dentro de VideoTexto; entra con tu cuenta como siempre y luego toca «Listo, continuar». La sesión queda guardada en este Mac.'),
          h('button', { class: 'btn primary', html: icon('external') + 'Abrir la página', onclick: async () => {
            try { const ok = await bridge('login', { url: src.url }); if (ok) finish({ cookies: true }); } catch (e) { toast(esc(e.message || e), 'err'); }
          } })),
        h('div', { class: 'card' }, h('b', {}, 'Opción 2 · Usuario y contraseña'),
          h('p', { class: 'muted small' }, 'Para sitios compatibles con yt-dlp. Se usan solo para esta descarga y no se guardan.'),
          h('div', { class: 'field' }, user), h('div', { class: 'field' }, pass),
          h('button', { class: 'btn ghost', onclick: () => user.value && pass.value ? finish({ user: user.value, pass: pass.value }) : toast('Completa usuario y contraseña', 'err') }, 'Continuar'))
      ) : h('div', {},
        h('p', { class: 'muted' }, 'En iPhone y iPad las apps web no pueden usar tu sesión de otros sitios. Opciones:'),
        h('ol', {},
          h('li', { html: 'Abre la página, inicia sesión y <b>descarga o guarda el video</b> en Archivos; luego súbelo aquí.' }),
          h('li', { html: 'O abre el enlace en <b>VideoTexto para Mac</b>, que sí puede iniciar sesión y descargarlo.' })),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', html: icon('external') + 'Abrir la página', onclick: () => window.open(src.url, '_blank') }),
          h('button', { class: 'btn ghost', html: icon('upload') + 'Subir el video', onclick: () => { finish(null); App.pickFile(); } }))));
    const s = sheet('Requiere iniciar sesión', body, { onClose: () => !done && res(null) });
  });
}

async function startFile(file) {
  if (!S.key) { toast('Primero agrega tu clave gratuita de Gemini', 'err'); App.settings(); return; }
  const id = 'f-' + uid();
  const v = { id, kind: 'file', title: file.name.replace(/\.[^.]+$/, ''), channel: 'Archivo local', added: Date.now(), segments: [], screen: [], chat: [], marks: {}, notes: '', tr: {}, done: {}, status: 'working', file: { mime: file.type } };
  if (S.keepFiles && file.size < 600e6) { try { await DB.put('blobs', file, id); v.hasBlob = true; } catch {} }
  v.thumb = await videoThumb(file).catch(() => '');
  await saveV(v);
  location.hash = 'v=' + id;
  Jobs.add(signal => runPipeline(v, { kind: 'file', file }, signal));
}

async function hash(s) {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
}

function mediaDuration(blobOrUrl) {
  return new Promise(res => {
    const m = document.createElement('video');
    m.preload = 'metadata'; m.muted = true;
    m.onloadedmetadata = () => res(isFinite(m.duration) ? m.duration : 0);
    m.onerror = () => res(0);
    m.src = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    setTimeout(() => res(0), 15000);
  });
}
function videoThumb(file) {
  return new Promise((res, rej) => {
    const url = typeof file === 'string';
    if (!url && !/video/.test(file.type)) return res('');
    const m = document.createElement('video');
    m.muted = true; m.playsInline = true; m.preload = 'auto'; m.src = url ? file : URL.createObjectURL(file);
    m.onloadeddata = () => { m.currentTime = Math.min(5, (m.duration || 10) / 4); };
    m.onseeked = () => {
      const c = h('canvas', { width: 480, height: Math.round(480 * (m.videoHeight / m.videoWidth || 0.5625)) });
      c.getContext('2d').drawImage(m, 0, 0, c.width, c.height);
      URL.revokeObjectURL(m.src);
      res(c.toDataURL('image/jpeg', 0.7));
    };
    m.onerror = rej; setTimeout(() => rej(), 8000);
  });
}

async function runPipeline(v, src, signal) {
  const onWait = m => step(v, m);
  Jobs.liveV = v; // la vista usa este objeto vivo mientras se trabaja
  try {
    let media = null; // {uri, mime}
    // ---------- 1. fuente y metadatos ----------
    if (src.kind === 'yt') {
      await ytMeta(v, src, signal, onWait);
      media = { uri: v.url };
    } else if (src.kind === 'nfile') {
      step(v, 'Leyendo el archivo…', 2);
      v.duration = await mediaDuration(src.media);
      media = { local: src.media };
      if (S.key && txChoice() === 'gemini') {
        try {
          step(v, 'Subiendo a Gemini…', 4);
          const blob = await (await fetch(src.media)).blob();
          media = v.file = await Engine.upload(new File([blob], src.name, { type: src.mime || blob.type }), src.name, p => step(v, `Subiendo a Gemini… ${Math.round(p * 100)} %`, 4 + p * 10), signal);
        } catch (e) { if (e.name === 'AbortError') throw e; onWait('No se pudo subir a Gemini; transcribo en el Mac'); }
      }
    } else if (src.kind === 'file') {
      step(v, 'Leyendo el archivo…', 2);
      v.duration = await mediaDuration(src.file);
      if (txChoice() === 'groq' && S.groqKey) media = { blob: src.file };
      else {
      step(v, 'Subiendo a Gemini… 0 %', 4);
      media = await Engine.upload(src.file, src.file.name, p => step(v, `Subiendo a Gemini… ${Math.round(p * 100)} %`, 4 + p * 10), signal);
      v.file = media;
      }
    } else {
      const r = await webSource(v, src, signal, onWait);
      if (r === 'yt') return; // se redirigió a YouTube
      if (!r) { v.status = 'blocked'; await saveV(v); step(v, ''); View.refresh(v); return; }
      media = r;
    }
    await saveV(v);
    View.refresh(v);

    // ---------- 2. transcripción ----------
    if (!v.segments.length) await transcribeAny(v, media, signal, onWait);
    if (!v.segments.length) throw new Error('No se encontró voz que transcribir en el video.');
    v.lang = v.lang || '';
    await saveV(v);

    // ---------- 3. análisis ----------
    step(v, 'Analizando contenido: resumen, capítulos, enlaces, ideas…', 92);
    try { v.an = await Engine.analyze(v, { signal, onWait }); }
    catch (e) { if (e.name === 'AbortError') throw e; v.anError = e.message; toast('Transcripción lista; el análisis falló: ' + esc(e.message), 'err'); }
    if (v.an?.title && /^(Video de YouTube|[\w.-]+\.\w+)$/.test(v.title)) v.title = v.an.title;
    if (v.chaptersDesc?.length && v.an) v.an.chapters = v.chaptersDesc.map(c => ({ t: c.t, title: c.title, summary: (v.an.chapters.find(x => Math.abs(x.t - c.t) < 45) || {}).summary || '' }));
    v.links = collectLinks(v);
    v.status = v.an ? 'done' : 'partial';
    step(v, '', 100);
    await saveV(v);
    View.refresh(v);
    toast(icon('check') + ' Análisis completo: ' + esc(v.title), 'ok');
    notify(v);
  } catch (e) {
    v.status = v.segments.length ? 'partial' : 'error';
    v.error = e.name === 'AbortError' ? 'Cancelado' : e.message;
    if (v.segments.length) v.links = collectLinks(v);
    step(v, '');
    await saveV(v);
    View.refresh(v);
    if (e.name !== 'AbortError') toast(esc(e.message), 'err');
  } finally { if (Jobs.liveV === v) Jobs.liveV = null; }
}

function notify(v) {
  if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification('VideoTexto', { body: 'Listo: ' + v.title, icon: 'icon-192.png' }); } catch {}
}

async function ytMeta(v, src, signal, onWait) {
  step(v, 'Leyendo datos del video…', 2);
  const [oe, dur, info, nat] = await Promise.all([
    Engine.oembed(v.url),
    probeYTDuration(src.id),
    Engine.pageInfo(v.url, { yt: true, signal, onWait }).catch(e => { if (e.name === 'AbortError') throw e; return null; }),
    native || ios ? bridge('ytinfo', { id: src.id, subs: txChoice() === 'subs' }).catch(() => null) : null,
  ]);
  if (oe) { v.title = oe.title; v.channel = oe.author_name; v.channelUrl = oe.author_url; }
  if (nat?.meta) {
    const m = nat.meta;
    v.title = m.title || v.title; v.channel = m.uploader || v.channel; v.description = m.description || '';
    v.published = m.upload_date ? m.upload_date.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3') : '';
    v.views = m.view_count; v.duration = m.duration || 0;
    if (m.chapters?.length) v.chaptersDesc = m.chapters.map(c => ({ t: c.start_time, title: c.title }));
    if (m.tags) v.ytTags = m.tags.slice(0, 15);
  }
  if (info) {
    if (!v.description && info.description) v.description = info.description;
    v.descLinks = (info.links || []).filter(l => l.url);
    v.published = v.published || info.published || '';
    v.views = v.views || info.views;
    if (!v.chaptersDesc?.length && info.chapters?.length > 1) v.chaptersDesc = info.chapters.filter(c => c.title).map(c => ({ t: parseT(c.t), title: c.title }));
    if (!v.channel) v.channel = info.channel;
    if (v.title === 'Video de YouTube' && info.title) v.title = info.title;
  }
  v.duration = v.duration || dur || +info?.duration_seconds || 0;
  if (nat?.subs?.length) { v.segments = nat.subs; v.subsSource = nat.subsLang; v.txEngine = 'subs'; }
}

// Páginas web: en el Mac, yt-dlp descarga el video de casi cualquier sitio; en iPad/iPhone se busca el video dentro de la página.
async function webSource(v, src, signal, onWait) {
  const direct = /\.(mp4|m4v|webm|mov|mp3|m4a|wav|ogg|oga|aac|flac)(\?|#|$)/i.test(src.url);
  if (native && !direct) {
    step(v, 'Buscando el video en la página (Mac)…', 2);
    const off = e => { if (e.type === 'dl' && e.id === v.id) step(v, `Descargando video… ${e.pct.toFixed(0)} %`, 2 + e.pct * 0.06); };
    nativeListeners.add(off);
    try {
      const r = await bridge('grab', { url: src.url, id: v.id, ...(src.cred || {}) });
      const m = r.meta || {};
      if (/youtube/i.test(m.extractor || '') && m.id) { await redirectYT(v, m.id, {}); return 'yt'; }
      Object.assign(v, { title: m.title || v.title, channel: m.uploader || m.channel || domainOf(src.url), description: m.description || '', duration: m.duration || 0, thumb: m.thumbnail || '', published: m.upload_date ? m.upload_date.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3') : '', mediaUrl: r.media, pageUrl: m.webpage_url || src.url });
      if (m.chapters?.length) v.chaptersDesc = m.chapters.map(c => ({ t: c.start_time, title: c.title }));
      step(v, 'Preparando el video…', 9);
      const gem = S.key && txChoice() === 'gemini';
      const blob = gem ? await (await fetch(r.media)).blob() : null;
      if (!v.duration) v.duration = await mediaDuration(r.media);
      if (!gem) return { local: r.media };
      step(v, 'Subiendo a Gemini…', 10);
      try {
        const f = await Engine.upload(blob, v.title, p => step(v, `Subiendo a Gemini… ${Math.round(p * 100)} %`, 10 + p * 6), signal);
        v.file = f;
        return f;
      } catch (e) { if (e.name === 'AbortError') throw e; return { local: r.media }; }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      onWait(`El Mac no pudo descargarlo (${String(e.message || e).slice(0, 80)}); busco el video en la página…`);
    } finally { nativeListeners.delete(off); }
  }
  if (direct) return (await directMedia(v, src.url, signal)) || null;

  step(v, 'Leyendo la página y buscando videos…', 3);
  const info = src.info || await Engine.pageInfo(src.url, { signal, onWait }).catch(e => { if (e.name === 'AbortError') throw e; return null; });
  if (info) {
    v.title = info.title || v.title; v.channel = info.site || domainOf(src.url); v.description = info.description || '';
    v.pageLinks = (info.links || []).filter(l => l.url); v.published = info.published || '';
  }
  v.pageUrl = src.url;
  const vids = info?.videos || [];
  const yt = vids.map(x => Engine.parse(x.url)).find(p => p?.kind === 'yt');
  if (yt) { await redirectYT(v, yt.id, { pageUrl: src.url, pageTitle: v.title, pageLinks: v.pageLinks, pageDesc: v.description }); return 'yt'; }
  for (const f of vids.filter(x => /\.(mp4|webm|m4v|mov|mp3|m4a)(\?|$)/i.test(x.url))) {
    const r = await directMedia(v, new URL(f.url, src.url).href, signal);
    if (r) return r;
  }
  if (info?.transcript?.trim().length > 200) {
    v.segments = info.transcript.split(/\n+/).filter(Boolean).map((x, i) => ({ t: 0, s: '', x: x.trim(), i }));
    v.noTimes = true;
    return { uri: null };
  }
  v.error = vids.length
    ? 'Encontré el video, pero el sitio no permite descargarlo desde este dispositivo.'
    : 'No encontré un video que se pueda leer en esta página.';
  return null;
}

async function directMedia(v, url, signal) {
  step(v, 'Descargando el archivo de video…', 4);
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) throw 0;
    const blob = await r.blob();
    v.mediaUrl = url; v.duration = v.duration || await mediaDuration(url);
    v.file = await Engine.upload(blob, v.title || 'video', p => step(v, `Subiendo a Gemini… ${Math.round(p * 100)} %`, 6 + p * 8), signal);
    return v.file;
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    v.mediaUrl = url;
    return null;
  }
}

async function redirectYT(v, id, extra) {
  await DB.del('videos', v.id);
  const nv = { ...v, ...extra, id: 'yt-' + id, kind: 'yt', ytId: id, url: 'https://www.youtube.com/watch?v=' + id, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, status: 'working', segments: [], screen: [] };
  await saveV(nv);
  if (location.hash === '#v=' + v.id) history.replaceState(null, '', '#v=' + nv.id);
  View.v = View.v?.id === v.id ? nv : View.v;
  Jobs.queue.unshift(signal => runPipeline(nv, { kind: 'yt', id, url: nv.url }, signal));
  if (View.v?.id === nv.id) View.open(nv.id);
}

// Motores de transcripción. El usuario elige uno; si falla, se prueba el siguiente disponible.
const TX = {
  gemini: { name: 'Gemini', ic: 'sparkle', desc: 'IA completa: hablantes y texto en pantalla. Usa tu cuota de Gemini.' },
  groq: { name: 'Groq', ic: 'zap', desc: 'Whisper en la nube, ultrarrápido (1 h en ~30 s). Gratis con clave de Groq; solo audio.' },
  whisper: { name: 'Whisper Mac', ic: 'cpu', desc: 'Whisper en tu Mac: gratis, sin límites y sin internet. ~3 min por hora de video.', mac: true },
  subs: { name: 'Subtítulos', ic: 'text', desc: 'Subtítulos de YouTube: instantáneo. Si el video no tiene, uso otro motor.', mac: true, ios: true },
  apple: { name: 'Dictado Apple', ic: 'mic', desc: 'Dictado de Apple en el equipo: gratis, precisión básica.', mac: true, ios: true },
};
const txList = () => Object.keys(TX).filter(k => native || !TX[k].mac || (ios && TX[k].ios));
const txChoice = () => txList().includes(S.tx) ? S.tx : 'gemini';

async function transcribeAny(v, media, signal, onWait) {
  const first = txChoice();
  const order = { gemini: ['gemini', 'subs', 'whisper', 'apple'], groq: ['groq', 'whisper', 'gemini', 'apple'], whisper: ['whisper', 'apple', 'gemini'], subs: ['whisper', 'gemini', 'apple'], apple: ['apple', 'whisper', 'gemini'] }[first];
  const ok = e => txList().includes(e) && (e !== 'gemini' || (S.key && (media?.uri || media?.blob || media?.local))) && (e !== 'groq' || (S.groqKey && (native || media?.blob))) && (e !== 'subs' || v.kind === 'yt') && (e !== 'apple' || native || media?.blob);
  const chain = order.filter(ok);
  if (!chain.length) throw new Error(first === 'groq' && !S.groqKey ? 'Falta la clave de Groq (Ajustes).' : first === 'groq' ? 'En iPhone/iPad, Groq transcribe archivos subidos; para enlaces usa Gemini.' : 'Agrega tu clave de Gemini en Ajustes.');
  if (chain[0] !== first && first !== 'subs') onWait(`${TX[first].name} no está disponible para este video; uso ${TX[chain[0]].name}`);
  for (let i = 0; i < chain.length; i++) {
    const e = chain[i], t0 = Date.now();
    try {
      v.segments = []; v.screen = [];
      if (e === 'gemini') {
        if (!media.uri) {
          const blob = media.blob || await (await fetch(media.local)).blob();
          step(v, 'Subiendo a Gemini…', 8);
          Object.assign(media, v.file = await Engine.upload(blob, v.title || 'video', p => step(v, `Subiendo a Gemini… ${Math.round(p * 100)} %`, 8 + p * 7), signal));
        }
        await transcribe(v, media, signal, onWait);
      } else if (e === 'groq') await groqTranscribe(v, media, signal);
      else if (e === 'subs') {
        step(v, 'Buscando subtítulos de YouTube…', 18);
        const r = await bridge('ytinfo', { id: v.ytId, subs: true }).catch(() => null);
        if (!r?.subs?.length) throw new Error('el video no tiene subtítulos');
        v.segments = r.subs; v.subsSource = r.subsLang;
      } else await localTranscribe(v, media, e);
      if (!v.segments.length) throw new Error('no reconoció voz');
      v.txEngine = e; v.txSecs = Math.round((Date.now() - t0) / 1000);
      return;
    } catch (err) {
      if (err.name === 'AbortError' || i === chain.length - 1) throw err;
      onWait(`${TX[e].name} no funcionó (${String(err.message).slice(0, 70)}); pruebo con ${TX[chain[i + 1]].name}`);
    }
  }
}

// En el Mac: Whisper (whisper.cpp) o dictado de Apple, sin tokens
async function localTranscribe(v, media, engine) {
  const name = engine === 'whisper' ? 'Whisper' : 'el dictado de Apple';
  step(v, `Transcribiendo ${ios ? 'en el equipo' : 'en el Mac'} con ${name}…`, 20);
  const off = e => {
    if (e.id !== v.id) return;
    if (e.type === 'dl') step(v, `Descargando audio… ${Math.round(e.pct)} %`, 15 + e.pct * 0.08);
    if (e.type === 'model') step(v, `Descargando el modelo de Whisper (solo la primera vez, 550 MB)… ${Math.round(e.pct)} %`, 16 + e.pct * 0.06);
    if (e.type === 'tr') step(v, `Transcribiendo ${ios ? 'en el equipo' : 'en el Mac'} con ${name}… ${Math.round(e.pct)} %`, 24 + e.pct * 0.66);
  };
  nativeListeners.add(off);
  try {
    v.segments = ios ? await bridge('localtranscribe', { id: v.id, engine, data: await blobB64(media.blob), ext: (media.blob.type.split('/')[1] || 'm4a').split(';')[0], lang: (v.lang || S.lang || 'es').slice(0, 2) })
      : await bridge('localtranscribe', { id: v.id, engine, url: v.kind === 'yt' ? v.url : (v.pageUrl || v.url || ''), media: media?.local || v.mediaUrl || '', lang: engine === 'whisper' ? '' : (v.lang || S.lang || 'es').slice(0, 2) });
  } finally { nativeListeners.delete(off); }
}

// Groq: Whisper large-v3-turbo en la nube. En el Mac el audio se prepara con ffmpeg; en iPhone/iPad se envía el archivo subido.
async function groqTranscribe(v, media, signal) {
  let parts;
  if (native) {
    step(v, 'Preparando el audio para Groq…', 15);
    const off = e => { if (e.id === v.id && e.type === 'dl') step(v, `Descargando audio… ${Math.round(e.pct)} %`, 15 + e.pct * 0.1); };
    nativeListeners.add(off);
    try { parts = await bridge('localtranscribe', { id: v.id, engine: 'groq', url: v.kind === 'yt' ? v.url : (v.pageUrl || v.url || ''), media: media?.local || v.mediaUrl || '' }); }
    finally { nativeListeners.delete(off); }
    parts = parts.map(p => ({ t: p.t, get: async () => (await fetch(p.url)).blob() }));
  } else parts = await audioParts(media.blob);
  let done = 0;
  const report = () => step(v, `Transcribiendo con Groq${parts.length > 1 ? `: ${done} de ${parts.length} partes` : '…'}`, 26 + 64 * done / parts.length);
  report();
  await pool(parts, 3, async p => {
    const j = await groqFile(await p.get(), signal);
    v.segments.push(...(j.segments || []).map(s => ({ t: p.t + s.start, s: '', x: s.text.trim() })).filter(s => s.x));
    v.segments.sort((x, y) => x.t - y.t);
    if (j.language && !v.lang) v.lang = { spanish: 'es', english: 'en', portuguese: 'pt', french: 'fr', german: 'de', italian: 'it' }[j.language.toLowerCase()] || '';
    done++; report(); View.liveTranscript(v);
  });
}

async function groqFile(blob, signal, tries = 0) {
  const fd = new FormData();
  fd.append('file', blob, blob.name || (/mpeg|mp3/.test(blob.type) ? 'audio.mp3' : /wav/.test(blob.type) ? 'audio.wav' : 'audio.mp4'));
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('response_format', 'verbose_json');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + S.groqKey }, body: fd, signal });
  if (r.status === 429 && tries < 3) { await sleep(Math.min(60, +r.headers.get('retry-after') || 20) * 1000); return groqFile(blob, signal, tries + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'clave de Groq no válida' : r.status === 413 ? 'archivo demasiado grande para Groq' : j.error?.message || 'Groq respondió ' + r.status);
  return j;
}

// iPhone/iPad: archivos grandes se convierten a WAV mono 16 kHz en partes de 10 min (≈19 MB cada una)
async function audioParts(file) {
  if (file.size <= 24e6) return [{ t: 0, get: async () => file }];
  const Ctx = window.AudioContext || window.webkitAudioContext, ac = new Ctx();
  const audio = await ac.decodeAudioData(await file.arrayBuffer()); ac.close?.();
  const sr = 16000, off = new OfflineAudioContext(1, Math.ceil(audio.duration * sr), sr);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0), per = 600 * sr, out = [];
  for (let a = 0; a < pcm.length; a += per) {
    const d = pcm.subarray(a, Math.min(pcm.length, a + per)), buf = new DataView(new ArrayBuffer(44 + d.length * 2));
    const w = (o, str) => [...str].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); buf.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVEfmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
    buf.setUint32(24, sr, true); buf.setUint32(28, sr * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); w(36, 'data'); buf.setUint32(40, d.length * 2, true);
    for (let i = 0; i < d.length; i++) buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
    const blob = new Blob([buf], { type: 'audio/wav' });
    out.push({ t: a / sr, get: async () => blob });
  }
  return out;
}

async function transcribe(v, media, signal, onWait) {
  const D = v.duration || 0, size = +S.chunk || 600;
  let ranges = [];
  if (!D) ranges = [[0, 0]];
  else for (let a = 0; a < D; a += size) { let b = Math.min(D, a + size); if (D - b < 90) b = D; ranges.push([a, b]); if (b === D) break; }
  const total = ranges.length;
  let done = 0, speakers = [];
  const report = () => step(v, total > 1 ? `Transcribiendo con IA: ${done} de ${total} partes (${fmtT(D)} de video)` : 'Transcribiendo con IA (audio e imagen)…', 15 + 75 * done / total);
  const merge = j => {
    v.segments.push(...j.segments); v.screen.push(...(j.screen || []));
    v.segments.sort((x, y) => x.t - y.t); v.screen.sort((x, y) => x.t - y.t);
    if (j.lang && !v.lang) v.lang = j.lang;
  };
  const runOne = async ([a, b]) => {
    let j;
    if (!b) {
      const r = await Engine.gem({ parts: [{ file_data: { file_uri: media.uri, ...(media.mime ? { mime_type: media.mime } : {}) } }, { text: 'Transcribe COMPLETO y literal todo lo hablado en el video, en su idioma original, con t en segundos, hablante s y el texto visible en pantalla en "screen".' }], schema: Engine.chunkSchema, media: true, maxTokens: 60000, signal, onWait });
      j = Engine.json(r.text) || { segments: [] };
    } else j = await Engine.chunk(media, a, b, { speakers, signal, onWait });
    if (!j) { // respuesta truncada: se divide el tramo
      const m = (a + b) / 2;
      await runOne([a, m]); await runOne([m, b]); return;
    }
    merge(j);
    if (!speakers.length) speakers = [...new Set(j.segments.map(s => s.s).filter(Boolean))].slice(0, 12);
  };
  report();
  // la primera parte va sola para fijar idioma y hablantes; el resto en paralelo
  await runOne(ranges[0]); done++; report(); await saveV(v); View.liveTranscript(v);
  await pool(ranges.slice(1), Math.max(1, +S.conc || 2), async r => {
    await runOne(r); done++; report(); await saveV(v); View.liveTranscript(v);
  });
}

// =====================================================================
// Vista de video
// =====================================================================
const View = {
  v: null, tab: 'tr', timer: null, segEls: [], cur: -1, q: '', qi: 0, follow: true, userScroll: 0, autoUntil: 0,

  async open(id) {
    const v = await DB.get('videos', id);
    if (!v) { location.hash = ''; return; }
    // si hay un trabajo activo sobre este video, usar el objeto vivo
    this.v = (Jobs.active && Jobs.liveV?.id === id) ? Jobs.liveV : v;
    this.cur = -1; this.q = '';
    this.follow = S.follow;
    App.screen('video');
    this.render();
  },

  refresh(v) { if (this.v?.id === v.id) { this.v = v; this.renderTabs(); this.renderMeta(); this.progress(); this.renderTab(); } },

  close() { clearInterval(this.timer); if (this.v && Player.kind) { this.v.resume = Player.time(); DB.get('videos', this.v.id).then(x => x && x.status !== 'working' && DB.put('videos', { ...x, resume: this.v.resume })); } Player.destroy(); this.v = null; },

  render() {
    const v = this.v;
    const root = $('#video');
    root.innerHTML = '';
    root.append(
      h('header', { class: 'top glass' },
        h('button', { class: 'icon-btn', 'aria-label': 'Volver', html: icon('back'), onclick: () => { location.hash = ''; } }),
        h('div', { class: 'top-title' }, h('b', { id: 'vtitle' }, v.title), h('small', { id: 'vsub' }, v.channel || '')),
        h('button', { class: 'icon-btn', id: 'favbtn', 'aria-label': 'Favorito', html: icon(v.fav ? 'star-fill' : 'star'), onclick: () => this.toggleFav() }),
        h('button', { class: 'icon-btn', 'aria-label': 'Exportar', html: icon('share'), onclick: e => Exporter.menu(e.currentTarget, this.v) }),
        h('button', { class: 'icon-btn', 'aria-label': 'Más', html: icon('more'), onclick: e => this.more(e.currentTarget) })),
      h('div', { class: 'vgrid' },
        h('aside', { class: 'vleft' },
          h('div', { class: 'player', id: 'player' }),
          h('div', { class: 'timeline', id: 'timeline' }),
          h('div', { class: 'pctl', id: 'pctl' }),
          h('div', { id: 'vmeta' }),
          h('div', { id: 'vprog' })),
        h('main', { class: 'vright' },
          h('nav', { class: 'tabs', id: 'tabs' }),
          h('div', { class: 'tabbody', id: 'tabbody' }))));
    Player.mount(v, $('#player')).then(() => Player.setRate(Player.rate));
    this.renderCtl(); this.renderMeta(); this.renderTabs(); this.progress(); this.renderTab();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  },

  renderCtl() {
    const c = $('#pctl'); c.innerHTML = '';
    c.append(
      h('button', { class: 'chip', title: 'Retroceder 10 s (J)', html: icon('rew') + '10', onclick: () => Player.seek(Player.time() - 10) }),
      h('button', { class: 'chip', title: 'Reproducir / pausar (espacio)', html: icon('play'), onclick: () => Player.toggle() }),
      h('button', { class: 'chip', title: 'Avanzar 10 s (L)', html: '10' + icon('fwd'), onclick: () => Player.seek(Player.time() + 10) }),
      h('span', { class: 'sep' }),
      ...[0.75, 1, 1.25, 1.5, 2].map(r => h('button', { class: 'chip rate' + (Player.rate === r ? ' on' : ''), onclick: e => { Player.setRate(r); $$('.rate', c).forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, r + '×')),
      h('span', { class: 'grow' }),
      h('span', { class: 'clock', id: 'clock' }, '0:00'));
  },

  renderMeta() {
    const v = this.v, m = $('#vmeta'); if (!m) return;
    $('#vtitle').textContent = v.title; $('#vsub').textContent = v.channel || '';
    const words = v.segments.reduce((a, s) => a + s.x.split(/\s+/).length, 0);
    m.innerHTML = '';
    m.append(h('div', { class: 'vinfo' },
      h('h1', {}, v.title),
      h('div', { class: 'meta-row' },
        v.channel ? h('span', {}, v.channelUrl ? h('a', { href: v.channelUrl, target: '_blank', rel: 'noopener' }, v.channel) : v.channel) : null,
        v.duration ? h('span', { html: icon('clock') + fmtT(v.duration) }) : null,
        v.published ? h('span', {}, v.published) : null,
        words ? h('span', {}, words.toLocaleString('es-CL') + ' palabras') : null,
        TX[v.txEngine] ? h('span', { class: 'txbadge', html: icon(TX[v.txEngine].ic) + 'Transcrito con ' + TX[v.txEngine].name + (v.txSecs ? ` en ${fmtDur(v.txSecs)}` : '') }) : null,
        v.url || v.pageUrl ? h('a', { href: v.pageUrl || v.url, target: '_blank', rel: 'noopener', html: icon('external') + 'Original' }) : null),
      v.an?.tags?.length ? h('div', { class: 'tags' }, v.an.tags.map(t => h('span', { class: 'tag' }, '#' + t))) : null));
  },

  progress() {
    const v = this.v, p = $('#vprog'); if (!p) return;
    p.innerHTML = '';
    if (v.status === 'working') {
      const active = Jobs.active && (Jobs.liveV?.id === v.id);
      p.append(h('div', { class: 'card prog' },
        h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('b', {}, active ? (v.step || 'Preparando…') : 'En cola…'), h('span', { class: 'grow' }),
          h('button', { class: 'btn ghost sm', onclick: () => Jobs.cancel() }, 'Cancelar')),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(3, v.pct || 3)}%` })),
        h('small', { class: 'muted' }, 'Puedes seguir usando la app; la transcripción aparece a medida que avanza.')));
    } else if (v.status === 'error' || v.status === 'partial' || v.status === 'blocked') {
      const blocked = v.status === 'blocked';
      p.append(h('div', { class: 'card warn' },
        h('b', {}, blocked ? 'No se pudo obtener el video' : v.status === 'partial' ? 'Análisis incompleto' : 'Error'),
        h('p', {}, v.error || v.anError || ''),
        blocked ? h('p', { class: 'muted', html: native ? 'Prueba guardando el video y súbelo con <b>Subir video o audio</b>.' : 'Opciones: abre el enlace en <b>VideoTexto para Mac</b> (descarga videos de más de 1.000 sitios) o guarda el video en Archivos y usa <b>Subir video o audio</b>.' }) : null,
        h('div', { class: 'row' },
          !blocked || native ? h('button', { class: 'btn primary sm', onclick: () => this.reanalyze() }, v.status === 'partial' && v.segments.length ? 'Completar análisis' : 'Reintentar') : null,
          blocked ? h('button', { class: 'btn ghost sm', onclick: () => App.pickFile() }, 'Subir video o audio') : null)));
    }
  },

  tabsDef() {
    const v = this.v, an = v.an || {};
    return [
      ['tr', 'Transcripción', 'text'],
      ['sum', 'Resumen', 'sparkle'],
      ['ch', 'Capítulos', 'list', an.chapters?.length],
      ['links', 'Enlaces', 'link', (v.links || []).length],
      ['ideas', 'Ideas', 'bulb'],
      ['res', 'Recursos', 'book', (an.resources || []).length],
      ['chat', 'Chat', 'chat'],
      ['study', 'Estudio', 'cards'],
      ['notes', 'Notas', 'note'],
    ];
  },
  renderTabs() {
    const n = $('#tabs'); if (!n) return;
    n.innerHTML = '';
    for (const [k, l, ic, c] of this.tabsDef()) {
      n.append(h('button', { class: 'tab' + (this.tab === k ? ' on' : ''), onclick: () => { this.tab = k; this.renderTabs(); this.renderTab(); }, html: icon(ic) + `<span>${l}</span>` + (c ? `<em>${c}</em>` : '') }));
    }
    n.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  },

  renderTab() {
    const b = $('#tabbody'); if (!b) return;
    b.innerHTML = ''; b.scrollTop = 0;
    const v = this.v;
    const need = (cond, msg) => { if (cond) return false; b.append(this.empty(msg)); return true; };
    switch (this.tab) {
      case 'tr': return this.tabTranscript(b);
      case 'sum': if (need(v.an, 'El resumen aparecerá al terminar la transcripción.')) return; return this.tabSummary(b);
      case 'ch': if (need(v.an?.chapters?.length, 'Los capítulos aparecerán al terminar.')) return; return this.tabChapters(b);
      case 'links': return this.tabLinks(b);
      case 'ideas': if (need(v.an, 'Las ideas clave aparecerán al terminar.')) return; return this.tabIdeas(b);
      case 'res': if (need(v.an, 'Los recursos mencionados aparecerán al terminar.')) return; return this.tabResources(b);
      case 'chat': if (need(v.segments.length, 'Podrás conversar con el video cuando haya transcripción.')) return; return this.tabChat(b);
      case 'study': if (need(v.an, 'Las tarjetas y el cuestionario aparecerán al terminar.')) return; return this.tabStudy(b);
      case 'notes': return this.tabNotes(b);
    }
  },
  empty(msg) {
    return h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: icon(this.v.status === 'working' ? 'sparkle' : 'text') }), h('p', {}, this.v.status === 'working' ? msg : 'Sin datos todavía.'));
  },

  // ---------------- Transcripción ----------------
  tabTranscript(b) {
    const v = this.v;
    const langs = Object.keys(v.tr || {});
    const tools = h('div', { class: 'trtools glass' },
      h('div', { class: 'search' }, h('span', { html: icon('search') }),
        h('input', { id: 'trq', type: 'search', placeholder: 'Buscar en la transcripción', value: this.q, oninput: e => { this.q = e.target.value; this.qi = 0; this.applySearch(); }, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); this.nextHit(e.shiftKey ? -1 : 1); } } }),
        h('span', { id: 'trhits', class: 'muted' }),
        h('button', { class: 'icon-btn sm', title: 'Anterior', html: icon('up'), onclick: () => this.nextHit(-1) }),
        h('button', { class: 'icon-btn sm', title: 'Siguiente', html: icon('down'), onclick: () => this.nextHit(1) })),
      h('div', { class: 'row tight' },
        h('button', { class: 'chip' + (this.follow ? ' on' : ''), title: 'Seguir la reproducción', html: icon('follow') + 'Seguir', onclick: e => { this.follow = !this.follow; e.currentTarget.classList.toggle('on', this.follow); if (this.follow) this.scrollToCur(true); } }),
        h('button', { class: 'chip' + (S.speakers ? ' on' : ''), html: icon('user') + 'Hablantes', onclick: () => { saveSettings({ speakers: !S.speakers }); this.renderTab(); } }),
        h('button', { class: 'chip' + (v.trMode ? ' on' : ''), html: icon('translate') + (v.trMode ? langName(v.trMode) : 'Traducir'), onclick: e => this.translateMenu(e.currentTarget, langs) }),
        h('button', { class: 'chip', html: icon('copy') + 'Copiar', onclick: () => copyText(Exporter.txt(v, true), 'Transcripción copiada') }),
        h('button', { class: 'chip', title: 'Texto más pequeño', onclick: () => this.font(-1) }, 'A−'),
        h('button', { class: 'chip', title: 'Texto más grande', onclick: () => this.font(1) }, 'A+')));
    const list = h('div', { class: 'transcript', id: 'transcript' });
    b.append(tools, list);
    this.fillTranscript(list);
    b.onscroll = () => { if (Date.now() > this.autoUntil) this.userScroll = Date.now(); };
  },

  fillTranscript(list) {
    const v = this.v;
    list.innerHTML = '';
    this.segEls = [];
    if (!v.segments.length) { list.append(this.empty('La transcripción aparecerá aquí en unos segundos…')); return; }
    const tr = v.trMode && v.tr?.[v.trMode];
    const chapters = (v.an?.chapters || []).slice().sort((a, b) => a.t - b.t);
    const screen = (v.screen || []).filter(s => s.kind !== 'other' || s.url);
    let ci = 0, si = 0, para = null, lastSpk = null, lastT = -999;
    const spkColor = {}; let nc = 0;
    const frag = document.createDocumentFragment();
    v.segments.forEach((s, i) => {
      let newPara = !para || (S.speakers && s.s && s.s !== lastSpk) || s.t - lastT > 40 || para.childElementCount > 6;
      while (ci < chapters.length && chapters[ci].t <= s.t + 0.5) {
        const c = chapters[ci];
        frag.append(h('div', { class: 'chap-h', onclick: () => Player.seek(c.t) }, h('span', { class: 'ts' }, fmtT(c.t)), h('b', {}, c.title)));
        ci++; newPara = true;
      }
      if (newPara) {
        const showSpk = S.speakers && s.s && s.s !== lastSpk;
        if (s.s && !(s.s in spkColor)) spkColor[s.s] = SPK_COLORS[nc++ % SPK_COLORS.length];
        para = h('p', { class: 'para' });
        const head = h('div', { class: 'para-h' },
          v.noTimes ? null : h('button', { class: 'ts', onclick: () => Player.seek(s.t) }, fmtT(s.t)),
          showSpk ? h('span', { class: 'spk', style: `--c:${spkColor[s.s]}` }, s.s) : null);
        frag.append(h('div', { class: 'pblock' }, head, para));
        lastSpk = s.s;
      }
      const span = h('span', { class: 'seg' + (v.marks?.[i] ? ' mark' : ''), 'data-i': i }, (tr ? tr[i] : s.x) + ' ');
      if (tr && v.trBoth) span.append(h('small', { class: 'orig' }, s.x + ' '));
      para.append(span);
      this.segEls[i] = span;
      lastT = s.t;
      while (si < screen.length && screen[si].t <= s.t) {
        const it = screen[si++];
        if (it.kind === 'link' || it.kind === 'qr' || it.url) para.parentNode.append(h('div', { class: 'scr', html: icon(it.kind === 'qr' ? 'qr' : 'eye') + `<span>${esc(it.text)}</span>` + (it.url ? ` <a href="${esc(normUrl(it.url))}" target="_blank" rel="noopener">${esc(domainOf(it.url))}</a>` : '') }));
      }
    });
    list.append(frag);
    list.onclick = e => {
      const sp = e.target.closest('.seg');
      if (sp && !window.getSelection().toString()) { Player.seek(v.segments[+sp.dataset.i].t); this.follow = true; }
    };
    list.oncontextmenu = e => {
      const sp = e.target.closest('.seg'); if (!sp) return;
      e.preventDefault(); this.segMenu(sp, +sp.dataset.i);
    };
    let lp; // pulsación larga en táctil
    list.ontouchstart = e => { const sp = e.target.closest('.seg'); if (sp) lp = setTimeout(() => this.segMenu(sp, +sp.dataset.i), 550); };
    list.ontouchend = list.ontouchmove = () => clearTimeout(lp);
    if (this.q) this.applySearch();
    this.cur = -1;
  },

  liveTranscript(v) {
    if (this.v?.id !== v.id) return;
    this.v = v;
    this.renderMeta();
    if (this.tab === 'tr' && $('#transcript')) {
      const b = $('#tabbody'), keep = b.scrollTop;
      this.fillTranscript($('#transcript')); b.scrollTop = keep;
    }
    this.renderTimeline();
  },

  segMenu(anchor, i) {
    const v = this.v, s = v.segments[i];
    const link = v.kind === 'yt' ? `https://youtu.be/${v.ytId}?t=${Math.floor(s.t)}` : '';
    menu(anchor, [
      { label: 'Reproducir desde aquí', icon: 'play', run: () => Player.seek(s.t) },
      { label: v.marks?.[i] ? 'Quitar resaltado' : 'Resaltar', icon: 'highlight', run: () => { v.marks = v.marks || {}; v.marks[i] ? delete v.marks[i] : v.marks[i] = 1; anchor.classList.toggle('mark'); saveV(v); } },
      { label: 'Copiar', icon: 'copy', run: () => copyText(`[${fmtT(s.t)}] ${s.x}`) },
      link ? { label: 'Copiar enlace a este momento', icon: 'link', run: () => copyText(link, 'Enlace copiado') } : null,
      { label: 'Explicar con IA', icon: 'sparkle', run: () => { this.tab = 'chat'; this.renderTabs(); this.renderTab(); this.ask(`Explícame lo que se dice en [${fmtT(s.t)}]: "${s.x}"`); } },
      { label: 'Añadir a notas', icon: 'note', run: () => { v.notes = (v.notes ? v.notes + '\n\n' : '') + `[${fmtT(s.t)}] ${s.x}`; saveV(v); toast('Añadido a notas'); } },
    ].filter(Boolean));
  },

  applySearch() {
    const q = this.q.trim().toLowerCase();
    let hits = 0;
    const tr = this.v.trMode && this.v.tr?.[this.v.trMode];
    this.segEls.forEach((el, i) => {
      if (!el) return;
      const text = (tr ? tr[i] : this.v.segments[i].x);
      const orig = el.querySelector('.orig');
      if (!q) { el.classList.remove('hit'); el.innerHTML = esc(text) + ' '; if (orig) el.append(orig); return; }
      const low = text.toLowerCase();
      if (!low.includes(q)) { el.innerHTML = esc(text) + ' '; el.classList.remove('hit'); if (orig) el.append(orig); return; }
      let out = '', p = 0, k;
      while ((k = low.indexOf(q, p)) >= 0) { out += esc(text.slice(p, k)) + '<mark>' + esc(text.slice(k, k + q.length)) + '</mark>'; p = k + q.length; hits++; }
      el.innerHTML = out + esc(text.slice(p)) + ' ';
      if (orig) el.append(orig);
      el.classList.add('hit');
    });
    const c = $('#trhits'); if (c) c.textContent = q ? (hits ? `${hits}` : '0') : '';
    if (q && hits) this.nextHit(0);
  },
  nextHit(d) {
    const marks = $$('#transcript mark'); if (!marks.length) return;
    this.qi = (this.qi + d + marks.length) % marks.length;
    marks.forEach((m, i) => m.classList.toggle('cur', i === this.qi));
    marks[this.qi].scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.follow = false;
    $('#trhits').textContent = `${this.qi + 1}/${marks.length}`;
  },

  font(d) { saveSettings({ font: Math.min(26, Math.max(13, S.font + d)) }); applyTheme(); },

  translateMenu(anchor, langs) {
    const v = this.v;
    const items = [{ label: 'Original', icon: v.trMode ? 'dot' : 'check', run: () => { v.trMode = ''; saveV(v); this.renderTab(); } }];
    for (const [c, n] of Object.entries(LANGS)) {
      items.push({ label: (v.tr?.[c] ? '' : 'Traducir al ') + n, icon: v.trMode === c ? 'check' : (v.tr?.[c] ? 'translate' : 'dot'), run: () => this.translate(c) });
      if (items.length > 7) break;
    }
    items.push('-', { label: v.trBoth ? 'Ocultar original bajo la traducción' : 'Mostrar original bajo la traducción', icon: 'layers', run: () => { v.trBoth = !v.trBoth; saveV(v); this.renderTab(); } });
    menu(anchor, items);
  },
  async translate(lang) {
    const v = this.v;
    if (!v.tr?.[lang]) {
      const t = toastProgress(`Traduciendo al ${langName(lang)}…`);
      try { v.tr = v.tr || {}; v.tr[lang] = await Engine.translate(v, lang, p => t.set(p)); }
      catch (e) { t.done(); toast(esc(e.message), 'err'); return; }
      t.done();
    }
    v.trMode = lang; await saveV(v); this.renderTab();
  },

  tick() {
    if (!this.v || !Player.kind) return;
    const t = Player.time();
    const c = $('#clock'); if (c) c.textContent = fmtT(t) + (this.v.duration ? ' / ' + fmtT(this.v.duration) : '');
    const cur = $('#tlcur'); if (cur && this.v.duration) cur.style.left = (100 * t / this.v.duration) + '%';
    const segs = this.v.segments;
    if (!segs.length || this.v.noTimes) return;
    let lo = 0, hi = segs.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (segs[m].t <= t + 0.25) { i = m; lo = m + 1; } else hi = m - 1; }
    if (i !== this.cur) {
      this.segEls[this.cur]?.classList.remove('now');
      this.cur = i;
      this.segEls[i]?.classList.add('now');
      if (this.follow && Player.playing()) this.scrollToCur();
      $$('.chap.on').forEach(e => e.classList.remove('on'));
      const ch = this.v.an?.chapters || [];
      let k = -1; ch.forEach((x, j) => { if (x.t <= t) k = j; });
      $(`.chap[data-k="${k}"]`)?.classList.add('on');
    }
  },
  scrollToCur(force) {
    const el = this.segEls[this.cur]; if (!el) return;
    if (!force && Date.now() - this.userScroll < 2500) return;
    const b = $('#tabbody'), r = el.getBoundingClientRect(), br = b.getBoundingClientRect();
    if (force || r.top < br.top + 90 || r.bottom > br.bottom - 60) {
      this.autoUntil = Date.now() + 900; this.userScroll = 0;
      b.scrollTo({ top: b.scrollTop + r.top - br.top - br.height * 0.35, behavior: 'smooth' });
    }
  },

  renderTimeline() {
    const tl = $('#timeline'), v = this.v; if (!tl) return;
    tl.innerHTML = '';
    if (!v.duration || v.noTimes) { tl.style.display = 'none'; return; }
    tl.style.display = '';
    const ch = (v.an?.chapters || []).slice().sort((a, b) => a.t - b.t);
    const track = h('div', { class: 'tl-track' });
    if (ch.length) ch.forEach((c, i) => {
      const end = ch[i + 1]?.t ?? v.duration;
      track.append(h('div', { class: 'tl-ch', style: `left:${100 * c.t / v.duration}%;width:${100 * (end - c.t) / v.duration}%`, title: `${fmtT(c.t)} · ${c.title}` }));
    });
    else if (v.segments.length) {
      const done = Math.max(...v.segments.map(s => s.t));
      track.append(h('div', { class: 'tl-ch', style: `left:0;width:${100 * Math.min(1, done / v.duration)}%` }));
    }
    for (const s of v.screen || []) if (s.url || s.kind === 'link' || s.kind === 'qr') track.append(h('i', { class: 'tl-dot', style: `left:${100 * s.t / v.duration}%`, title: s.text }));
    for (const k of Object.keys(v.marks || {})) { const s = v.segments[k]; if (s) track.append(h('i', { class: 'tl-mark', style: `left:${100 * s.t / v.duration}%` })); }
    track.append(h('div', { class: 'tl-cur', id: 'tlcur' }));
    const tip = h('div', { class: 'tl-tip' });
    tl.append(track, tip);
    const at = e => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration; };
    track.onpointermove = e => {
      const t = at(e), c = [...ch].reverse().find(x => x.t <= t);
      tip.textContent = fmtT(t) + (c ? ' · ' + c.title : '');
      tip.style.left = (100 * t / v.duration) + '%'; tip.classList.add('in');
    };
    track.onpointerleave = () => tip.classList.remove('in');
    track.onclick = e => Player.seek(at(e));
  },

  // ---------------- Resumen ----------------
  tabSummary(b) {
    const v = this.v, an = v.an;
    const words = v.segments.reduce((a, s) => a + s.x.split(/\s+/).length, 0);
    const spk = {};
    v.segments.forEach(s => { if (s.s) spk[s.s] = (spk[s.s] || 0) + s.x.split(/\s+/).length; });
    const spkArr = Object.entries(spk).sort((a, b) => b[1] - a[1]);
    const stat = (k, val) => h('div', { class: 'stat' }, h('b', {}, val), h('small', {}, k));
    b.append(
      h('section', { class: 'card hero-card' },
        h('div', { class: 'eyebrow', html: icon('sparkle') + 'En pocas palabras' }),
        h('ul', { class: 'tldr' }, (an.tldr || []).map(x => h('li', { html: md(x).replace(/^<p>|<\/p>$/g, '') }))),
        h('p', { class: 'lead', html: md(an.summary).replace(/^<p>|<\/p>$/g, '') })),
      h('section', { class: 'stats' },
        stat('Duración', fmtT(v.duration)), stat('Palabras', words.toLocaleString('es-CL')),
        stat('Ritmo', v.duration ? Math.round(words / (v.duration / 60)) + ' ppm' : '—'), stat('Lectura', Math.max(1, Math.round(words / 230)) + ' min'),
        stat('Hablantes', spkArr.length || '—'), stat('Idioma', (v.lang || '—').toUpperCase())),
      spkArr.length > 1 ? h('section', { class: 'card' }, h('h3', {}, 'Participación'),
        h('div', { class: 'spkbars' }, spkArr.slice(0, 8).map(([n, w], i) => h('div', { class: 'spkbar' }, h('span', {}, n), h('div', {}, h('i', { style: `width:${100 * w / words}%;background:${SPK_COLORS[i % 8]}` })), h('small', {}, Math.round(100 * w / words) + ' %'))))) : null,
      h('section', { class: 'card' },
        h('div', { class: 'kv' },
          an.category ? h('div', {}, h('small', {}, 'Categoría'), h('span', {}, an.category)) : null,
          an.tone ? h('div', {}, h('small', {}, 'Tono'), h('span', {}, an.tone)) : null,
          an.audience ? h('div', {}, h('small', {}, 'Público'), h('span', {}, an.audience)) : null)),
      h('section', { class: 'card' }, h('h3', {}, 'Transformar en…'),
        h('div', { class: 'row wrap' }, [['article', 'Artículo', 'text'], ['notes', 'Apuntes de estudio', 'book'], ['mindmap', 'Mapa mental', 'layers'], ['clean', 'Transcripción limpia', 'sparkle'], ['thread', 'Hilo para redes', 'chat'], ['email', 'Correo', 'send']]
          .map(([k, l, ic]) => h('button', { class: 'chip big', html: icon(ic) + l, onclick: () => this.rewrite(k, l) })))),
      h('section', { class: 'card prose', html: '<h3>Resumen detallado</h3>' + md(an.detailed) }));
  },

  async rewrite(kind, label) {
    const v = this.v;
    v.rw = v.rw || {};
    const show = text => {
      const body = h('div', {}, h('div', { class: 'prose', html: md(text) }),
        h('div', { class: 'row end sticky-actions' },
          h('button', { class: 'btn ghost', html: icon('refresh') + 'Regenerar', onclick: () => { s.close(); delete v.rw[kind]; this.rewrite(kind, label); } }),
          h('button', { class: 'btn ghost', html: icon('note') + 'A notas', onclick: () => { v.notes = (v.notes ? v.notes + '\n\n' : '') + text; saveV(v); toast('Añadido a notas'); } }),
          h('button', { class: 'btn ghost', html: icon('download') + 'Guardar', onclick: () => saveFile(slug(v.title) + '-' + kind + '.md', text, 'text/markdown') }),
          h('button', { class: 'btn primary', html: icon('copy') + 'Copiar', onclick: () => copyText(text) })));
      const s = sheet(label, body, { wide: true });
      bindTimes(body);
    };
    if (v.rw[kind]) return show(v.rw[kind]);
    const t = toastProgress(`Generando ${label.toLowerCase()}…`);
    try { v.rw[kind] = await Engine.rewrite(v, kind); await saveV(v); t.done(); show(v.rw[kind]); }
    catch (e) { t.done(); toast(esc(e.message), 'err'); }
  },

  // ---------------- Capítulos ----------------
  tabChapters(b) {
    const v = this.v, ch = v.an.chapters.slice().sort((a, b) => a.t - b.t);
    b.append(h('div', { class: 'chapters' }, ch.map((c, k) => {
      const end = ch[k + 1]?.t ?? v.duration;
      return h('button', { class: 'chap', 'data-k': k, onclick: () => Player.seek(c.t) },
        h('div', { class: 'chap-n' }, String(k + 1).padStart(2, '0')),
        h('div', { class: 'chap-b' },
          h('div', { class: 'row tight' }, h('span', { class: 'ts' }, fmtT(c.t)), h('small', { class: 'muted' }, fmtDur(end - c.t))),
          h('b', {}, c.title), c.summary ? h('p', {}, c.summary) : null));
    })),
    h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm', html: icon('copy') + 'Copiar capítulos (formato YouTube)', onclick: () => copyText(ch.map(c => `${fmtT(c.t)} ${c.title}`).join('\n')) })));
  },

  // ---------------- Enlaces ----------------
  tabLinks(b) {
    const v = this.v;
    const links = v.links?.length ? v.links : collectLinks(v);
    const srcs = ['todos', ...new Set(links.flatMap(l => l.srcs))];
    let f = 'todos';
    const list = h('div', { class: 'links' });
    const draw = () => {
      list.innerHTML = '';
      const arr = links.filter(l => f === 'todos' || l.srcs.includes(f));
      if (!arr.length) { list.append(h('p', { class: 'muted center' }, v.status === 'working' ? 'Buscando enlaces…' : 'No se encontraron enlaces.')); return; }
      for (const l of arr) {
        const d = domainOf(l.url);
        list.append(h('div', { class: 'link' },
          h('img', { src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`, alt: '', loading: 'lazy', onerror: e => e.target.style.visibility = 'hidden' }),
          h('a', { class: 'link-b', href: l.url, target: '_blank', rel: 'noopener' }, h('b', {}, l.label && l.label.length < 90 ? l.label : d), h('small', {}, l.url.replace(/^https?:\/\//, ''))),
          h('div', { class: 'link-tags' }, l.srcs.map(s => h('span', { class: 'badge b-' + s.replace(/\W/g, '') }, SRC_LABEL[s] || s)),
            l.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(l.t) }, fmtT(l.t)) : null),
          h('button', { class: 'icon-btn sm', title: 'Copiar', html: icon('copy'), onclick: () => copyText(l.url, 'Enlace copiado') })));
      }
    };
    const scr = (v.screen || []).filter(s => !s.url && s.kind !== 'link');
    b.append(
      h('div', { class: 'row wrap filters' }, srcs.map(s => h('button', { class: 'chip' + (s === f ? ' on' : ''), onclick: e => { f = s; $$('.filters .chip', b).forEach(x => x.classList.remove('on')); e.currentTarget.classList.add('on'); draw(); } }, (s === 'todos' ? 'Todos' : SRC_LABEL[s] || s) + ' ' + (s === 'todos' ? links.length : links.filter(l => l.srcs.includes(s)).length))),
        h('span', { class: 'grow' }),
        links.length ? h('button', { class: 'chip', html: icon('copy') + 'Copiar todos', onclick: () => copyText(links.map(l => (l.label ? l.label + ' — ' : '') + l.url).join('\n'), 'Enlaces copiados') }) : null),
      list,
      scr.length ? h('section', { class: 'card' }, h('h3', { html: icon('eye') + ' Texto visto en pantalla' }),
        h('div', { class: 'scrlist' }, scr.map(s => h('div', { class: 'scr-row' }, h('button', { class: 'ts', onclick: () => Player.seek(s.t) }, fmtT(s.t)), h('span', { class: 'badge' }, ({ slide: 'Diapositiva', product: 'Producto', person: 'Rótulo', code: 'Código', data: 'Dato', qr: 'QR', other: 'Texto' })[s.kind] || s.kind), h('span', {}, s.text))))) : null,
      v.description ? h('details', { class: 'card' }, h('summary', {}, 'Descripción original'), h('div', { class: 'desc', html: esc(v.description).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>') })) : null);
    draw();
  },

  // ---------------- Ideas ----------------
  tabIdeas(b) {
    const v = this.v, an = v.an;
    const sec = (title, ic, kids) => kids && kids.length ? h('section', { class: 'card' }, h('h3', { html: icon(ic) + ' ' + title }), kids) : null;
    const verdict = { respaldado: 'ok', dudoso: 'warn', falso: 'bad', 'opinión': 'info' };
    b.append(
      sec('Ideas clave', 'bulb', h('ol', { class: 'kp' }, (an.keyPoints || []).map(k => h('li', {}, k.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(k.t) }, fmtT(k.t)) : null, ' ', k.text)))),
      sec('Citas destacadas', 'quote', (an.quotes || []).map(q => h('blockquote', { class: 'quote' }, h('p', {}, '“' + q.text + '”'),
        h('footer', {}, q.s ? h('span', {}, '— ' + q.s) : null, q.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(q.t) }, fmtT(q.t)) : null,
          h('button', { class: 'icon-btn sm', html: icon('copy'), onclick: () => copyText(`“${q.text}”${q.s ? ' — ' + q.s : ''}`) }))))),
      sec('Qué hacer', 'check', h('div', { class: 'todo' }, (an.actions || []).map((a, i) => h('label', {}, h('input', { type: 'checkbox', checked: v.done?.[i], onchange: e => { v.done = v.done || {}; v.done[i] = e.target.checked; saveV(v); } }), h('span', {}, a))))),
      sec('Verificación de afirmaciones', 'flag', (an.claims || []).map(c => h('div', { class: 'claim' }, h('span', { class: 'verdict v-' + (verdict[c.verdict] || 'info') }, c.verdict), h('div', {}, h('b', {}, c.claim), c.note ? h('p', { class: 'muted' }, c.note) : null), c.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(c.t) }, fmtT(c.t)) : null))),
      sec('Preguntas frecuentes', 'help', (an.faq || []).map(f => h('details', { class: 'faq' }, h('summary', {}, f.q), h('p', {}, f.a)))),
      sec('Glosario', 'book', h('dl', { class: 'gloss' }, (an.glossary || []).flatMap(g => [h('dt', {}, g.term), h('dd', {}, g.def)]))));
  },

  // ---------------- Recursos ----------------
  tabResources(b) {
    const an = this.v.an;
    const groups = {};
    (an.resources || []).forEach(r => (groups[r.kind] = groups[r.kind] || []).push(r));
    const ic = { libro: 'book', herramienta: 'tool', sitio: 'globe', producto: 'box', app: 'app', estudio: 'flask', curso: 'cap', persona: 'user', 'organización': 'org', video: 'play', otro: 'dot' };
    if (!Object.keys(groups).length && !an.people?.length) { b.append(this.empty('No se mencionaron recursos.')); return; }
    for (const [k, arr] of Object.entries(groups)) {
      b.append(h('section', { class: 'card' }, h('h3', { html: icon(ic[k] || 'dot') + ' ' + k[0].toUpperCase() + k.slice(1) + (arr.length > 1 ? 's' : '') }),
        h('div', { class: 'res' }, arr.map(r => {
          const url = normUrl(r.url) || `https://www.google.com/search?q=${encodeURIComponent(r.name)}`;
          return h('div', { class: 'res-row' },
            h('a', { href: url, target: '_blank', rel: 'noopener' }, h('b', {}, r.name), r.note ? h('small', {}, r.note) : null),
            r.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(r.t) }, fmtT(r.t)) : null,
            h('span', { class: 'muted', html: icon(normUrl(r.url) ? 'external' : 'search') }));
        }))));
    }
    if (an.people?.length) b.append(h('section', { class: 'card' }, h('h3', { html: icon('user') + ' Personas' }),
      h('div', { class: 'people' }, an.people.map(p => h('div', { class: 'person' }, h('div', { class: 'avatar' }, p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('')), h('div', {}, h('b', {}, p.name), p.role ? h('small', {}, p.role) : null))))));
  },

  // ---------------- Chat ----------------
  tabChat(b) {
    const v = this.v;
    const log = h('div', { class: 'chatlog', id: 'chatlog' });
    const input = h('textarea', { rows: 1, placeholder: 'Pregunta lo que quieras sobre el video…', onkeydown: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }, oninput: e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; } });
    const send = () => { const q = input.value.trim(); if (q) { input.value = ''; input.style.height = 'auto'; this.ask(q); } };
    const sugg = ['¿Cuál es la idea principal?', '¿Qué recomienda hacer, paso a paso?', 'Explícalo como si tuviera 12 años', '¿Qué argumentos o datos presenta?', '¿Hay algo cuestionable o polémico?', 'Dame 5 preguntas para reflexionar'];
    b.append(log, h('div', { class: 'chat-in glass' },
      v.chat?.length ? null : h('div', { class: 'row wrap sugg' }, sugg.map(s => h('button', { class: 'chip', onclick: () => this.ask(s) }, s))),
      h('div', { class: 'row' }, input,
        v.chat?.length ? h('button', { class: 'icon-btn', title: 'Borrar conversación', html: icon('trash'), onclick: () => { v.chat = []; saveV(v); this.renderTab(); } }) : null,
        h('button', { class: 'btn primary round', 'aria-label': 'Enviar', html: icon('send'), onclick: send }))));
    for (const m of v.chat || []) log.append(this.msg(m));
    if (!v.chat?.length) log.append(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: icon('chat') }), h('p', {}, 'Conversa con el video. Las respuestas citan los minutos exactos; tócalos para ir a ese momento.')));
    setTimeout(() => { b.scrollTop = b.scrollHeight; }, 30);
  },
  msg(m) {
    const el = h('div', { class: 'msg ' + (m.r === 'u' ? 'me' : 'ai'), html: m.r === 'u' ? esc(m.x) : md(m.x) });
    if (m.r !== 'u') { bindTimes(el); el.append(h('button', { class: 'icon-btn sm msg-copy', html: icon('copy'), onclick: () => copyText(m.x) })); }
    return el;
  },
  async ask(q) {
    const v = this.v;
    if (this.tab !== 'chat') { this.tab = 'chat'; this.renderTabs(); this.renderTab(); }
    v.chat = v.chat || [];
    const hist = v.chat.slice();
    v.chat.push({ r: 'u', x: q });
    this.renderTab();
    const log = $('#chatlog'), wait = h('div', { class: 'msg ai typing', html: '<i></i><i></i><i></i>' });
    log?.append(wait); $('#tabbody').scrollTop = 1e9;
    try {
      const a = await Engine.chat(v, hist, q);
      v.chat.push({ r: 'a', x: a });
      await saveV(v);
    } catch (e) { v.chat.pop(); toast(esc(e.message), 'err'); }
    if (this.v === v && this.tab === 'chat') this.renderTab();
  },

  // ---------------- Estudio ----------------
  tabStudy(b) {
    const v = this.v, cards = v.an.cards || [];
    let i = 0, known = 0;
    const card = h('div', { class: 'flash', onclick: () => card.classList.toggle('flip') });
    const counter = h('small', { class: 'muted' });
    const show = () => {
      card.classList.remove('flip');
      const c = cards[i];
      card.innerHTML = `<div class="face front"><small>Pregunta ${i + 1}/${cards.length}</small><p>${esc(c.q)}</p><em>Toca para ver la respuesta</em></div><div class="face back"><small>Respuesta</small><p>${esc(c.a)}</p></div>`;
      counter.textContent = `${known} dominadas`;
    };
    if (cards.length) {
      b.append(h('section', { class: 'card' }, h('h3', { html: icon('cards') + ' Tarjetas de estudio' }), card,
        h('div', { class: 'row center' },
          h('button', { class: 'icon-btn', html: icon('chev-l'), onclick: () => { i = (i - 1 + cards.length) % cards.length; show(); } }),
          h('button', { class: 'btn ghost sm', onclick: () => { i = (i + 1) % cards.length; show(); } }, 'Repasar'),
          h('button', { class: 'btn primary sm', onclick: () => { known++; i = (i + 1) % cards.length; show(); } }, 'La sé'),
          h('button', { class: 'icon-btn', html: icon('chev-r'), onclick: () => { i = (i + 1) % cards.length; show(); } }),
          h('button', { class: 'icon-btn', title: 'Mezclar', html: icon('shuffle'), onclick: () => { cards.sort(() => Math.random() - 0.5); i = 0; show(); } })),
        h('div', { class: 'center' }, counter),
        h('div', { class: 'row end' }, h('button', { class: 'chip', html: icon('download') + 'Exportar para Anki (CSV)', onclick: () => saveFile(slug(v.title) + '-tarjetas.csv', cards.map(c => `"${c.q.replace(/"/g, '""')}","${c.a.replace(/"/g, '""')}"`).join('\n'), 'text/csv') }))));
      show();
    }
    const qz = h('section', { class: 'card' }, h('h3', { html: icon('check') + ' Cuestionario' }));
    b.append(qz);
    const runQuiz = qs => {
      qz.querySelectorAll('.quiz, .qbtn').forEach(e => e.remove());
      let score = 0, answered = 0;
      const box = h('div', { class: 'quiz' });
      const res = h('div', { class: 'quiz-res' });
      qs.forEach((q, n) => {
        const opts = h('div', { class: 'opts' });
        q.options.forEach((o, k) => opts.append(h('button', { class: 'opt', onclick: e => {
          if (opts.dataset.done) return; opts.dataset.done = 1; answered++;
          const ok = k === q.correct; if (ok) score++;
          e.currentTarget.classList.add(ok ? 'ok' : 'bad'); opts.children[q.correct].classList.add('ok');
          opts.after(h('p', { class: 'why' }, (ok ? '✓ ' : '✗ ') + (q.why || ''), q.t != null ? h('button', { class: 'ts', onclick: () => Player.seek(q.t) }, fmtT(q.t)) : null));
          res.textContent = `${score} de ${answered} correctas` + (answered === qs.length ? ` · ${Math.round(100 * score / qs.length)} %` : '');
        } }, o)));
        box.append(h('div', { class: 'q' }, h('b', {}, `${n + 1}. ${q.q}`), opts));
      });
      qz.append(box, res, h('button', { class: 'btn ghost sm qbtn', html: icon('refresh') + 'Nuevo cuestionario', onclick: () => gen(true) }));
    };
    const gen = async force => {
      if (v.quiz?.length && !force) return runQuiz(v.quiz);
      const t = toastProgress('Creando cuestionario…');
      try { v.quiz = await Engine.quiz(v); await saveV(v); t.done(); runQuiz(v.quiz); } catch (e) { t.done(); toast(esc(e.message), 'err'); }
    };
    if (v.quiz?.length) runQuiz(v.quiz);
    else qz.append(h('p', { class: 'muted' }, '10 preguntas de selección múltiple para comprobar lo que aprendiste.'), h('button', { class: 'btn primary qbtn', html: icon('sparkle') + 'Crear cuestionario', onclick: () => gen() }));
  },

  // ---------------- Notas ----------------
  tabNotes(b) {
    const v = this.v;
    let tm;
    const ta = h('textarea', { class: 'notes', placeholder: 'Escribe tus notas. Usa “Insertar momento” para anclar un minuto del video.', oninput: () => { clearTimeout(tm); tm = setTimeout(() => { v.notes = ta.value; saveV(v); }, 400); } });
    ta.value = v.notes || '';
    const marks = Object.keys(v.marks || {}).map(Number).sort((a, b) => a - b);
    b.append(h('div', { class: 'row wrap' },
      h('button', { class: 'chip', html: icon('clock') + 'Insertar momento actual', onclick: () => { const s = ta.selectionStart, ins = `[${fmtT(Player.time())}] `; ta.setRangeText(ins, s, ta.selectionEnd, 'end'); ta.focus(); ta.dispatchEvent(new Event('input')); } }),
      h('button', { class: 'chip', html: icon('copy') + 'Copiar', onclick: () => copyText(ta.value) })),
      ta,
      marks.length ? h('section', { class: 'card' }, h('h3', { html: icon('highlight') + ' Resaltados' }), marks.map(i => h('div', { class: 'scr-row' }, h('button', { class: 'ts', onclick: () => Player.seek(v.segments[i].t) }, fmtT(v.segments[i].t)), h('span', {}, v.segments[i].x)))) : h('p', { class: 'muted small' }, 'Consejo: mantén presionado (o clic derecho) un fragmento de la transcripción para resaltarlo.'));
  },

  async toggleFav() {
    this.v.fav = !this.v.fav; await saveV(this.v);
    $('#favbtn').innerHTML = icon(this.v.fav ? 'star-fill' : 'star');
  },
  more(anchor) {
    const v = this.v;
    menu(anchor, [
      { label: 'Volver a analizar', icon: 'refresh', run: () => this.reanalyze(true) },
      v.status !== 'working' && v.segments.length ? { label: 'Regenerar solo el análisis', icon: 'sparkle', run: () => this.reanalyze(false) } : null,
      { label: 'Renombrar', icon: 'text', run: () => { const n = prompt('Nombre', v.title); if (n) { v.title = n; saveV(v); this.renderMeta(); } } },
      v.url ? { label: 'Copiar enlace del video', icon: 'link', run: () => copyText(v.pageUrl || v.url) } : null,
      '-',
      { label: 'Eliminar', icon: 'trash', danger: true, run: async () => { if (await confirmBox('¿Eliminar este video de la biblioteca?', 'Eliminar', true)) { await DB.del('videos', v.id); await DB.del('blobs', v.id); location.hash = ''; } } },
    ].filter(Boolean));
  },
  async reanalyze(full) {
    const v = this.v;
    if (full === undefined) full = !v.segments.length;
    if (!full) {
      v.status = 'working'; v.error = v.anError = ''; await saveV(v); this.progress();
      Jobs.add(async signal => {
        Jobs.liveV = v;
        try {
          step(v, 'Analizando contenido…', 92);
          v.an = await Engine.analyze(v, { signal, onWait: m => step(v, m) });
          v.links = collectLinks(v); v.status = 'done';
        } catch (e) { v.status = 'partial'; v.anError = e.message; toast(esc(e.message), 'err'); }
        await saveV(v); this.refresh(v);
      });
      return;
    }
    if (v.kind === 'file' && v.mediaUrl && native) {
      Object.assign(v, { segments: [], screen: [], an: null, status: 'working', error: '' }); await saveV(v); this.refresh(v);
      Jobs.add(signal => runPipeline(v, { kind: 'nfile', media: v.mediaUrl, mime: v.file?.mime, name: v.title }, signal));
      return;
    }
    if (v.kind === 'file') {
      if (v.file?.uri && v.file.expires > Date.now()) {
        Object.assign(v, { segments: [], screen: [], an: null, status: 'working', error: '' }); await saveV(v); this.refresh(v);
        Jobs.add(signal => runPipelineFile(v, signal));
      } else if (v.hasBlob) {
        const blob = await DB.get('blobs', v.id);
        Object.assign(v, { segments: [], screen: [], an: null, status: 'working', error: '' }); await saveV(v); this.refresh(v);
        Jobs.add(signal => runPipeline(v, { kind: 'file', file: new File([blob], v.title, { type: blob.type }) }, signal));
      } else toast('El archivo ya no está disponible; súbelo de nuevo.', 'err');
      return;
    }
    const src = v.kind === 'yt' ? v.url : (v.pageUrl || v.url);
    await DB.del('videos', v.id);
    startInput(src);
  },
};

async function runPipelineFile(v, signal) {
  try {
    await transcribe(v, v.file, signal, m => step(v, m));
    step(v, 'Analizando contenido…', 92);
    v.an = await Engine.analyze(v, { signal });
    v.links = collectLinks(v); v.status = 'done';
  } catch (e) { v.status = v.segments.length ? 'partial' : 'error'; v.error = e.message; }
  step(v, ''); await saveV(v); View.refresh(v);
}


function bindTimes(root) {
  root.addEventListener('click', e => { const b = e.target.closest('.ts[data-t]'); if (b) Player.seek(parseT(b.dataset.t)); });
}
$('#app')?.addEventListener('click', e => { const b = e.target.closest('.prose .ts[data-t], .msg .ts[data-t], .tldr .ts[data-t], .lead .ts[data-t]'); if (b) Player.seek(parseT(b.dataset.t)); });

function toastProgress(msg) {
  const t = h('div', { class: 'toast in prog' }, h('div', { class: 'spinner sm' }), h('span', {}, msg), h('i', { class: 'tbar' }));
  $('#toasts').append(t);
  return { set: p => { t.querySelector('.tbar').style.width = (p * 100) + '%'; }, done: () => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); } };
}

const slug = s => String(s || 'video').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'video';

// =====================================================================
// Exportar
// =====================================================================
const Exporter = {
  menu(anchor, v) {
    if (!v.segments.length) { toast('Aún no hay transcripción para exportar'); return; }
    menu(anchor, [
      { label: 'Copiar transcripción', icon: 'copy', run: () => copyText(this.txt(v, false), 'Transcripción copiada') },
      { label: 'Copiar informe completo', icon: 'copy', run: () => copyText(this.md(v), 'Informe copiado') },
      '-',
      { label: 'Enviar a Obsidian', icon: 'gem', run: () => this.obsidian(v) },
      { label: 'Imprimir o guardar PDF', icon: 'print', run: () => this.print(v) },
      { label: 'Markdown (.md)', icon: 'download', run: () => saveFile(slug(v.title) + '.md', this.md(v), 'text/markdown') },
      { label: 'Texto (.txt)', icon: 'download', run: () => saveFile(slug(v.title) + '.txt', this.txt(v, true)) },
      { label: 'Subtítulos (.srt)', icon: 'download', run: () => saveFile(slug(v.title) + '.srt', this.srt(v)) },
      { label: 'Subtítulos web (.vtt)', icon: 'download', run: () => saveFile(slug(v.title) + '.vtt', this.vtt(v), 'text/vtt') },
      { label: 'Datos (.json)', icon: 'download', run: () => saveFile(slug(v.title) + '.json', JSON.stringify(v, null, 1), 'application/json') },
      navigator.share ? '-' : null,
      navigator.share ? { label: 'Compartir resumen', icon: 'share', run: () => navigator.share({ title: v.title, text: `${v.title}\n\n${(v.an?.tldr || []).map(x => '• ' + x).join('\n')}\n\n${v.pageUrl || v.url || ''}` }).catch(() => {}) } : null,
    ].filter(Boolean));
  },
  txt(v, times) {
    const tr = v.trMode && v.tr?.[v.trMode];
    return v.segments.map((s, i) => (times && !v.noTimes ? `[${fmtT(s.t)}] ` : '') + (S.speakers && s.s ? s.s + ': ' : '') + (tr ? tr[i] : s.x)).join(times ? '\n' : ' ').replace(/ {2,}/g, ' ');
  },
  ends(v) { return v.segments.map((s, i) => Math.min(v.segments[i + 1]?.t ?? s.t + 6, s.t + 12)); },
  stamp(t, sep) {
    const ms = Math.round(t * 1000), hh = Math.floor(ms / 3600000), mm = Math.floor(ms % 3600000 / 60000), ss = Math.floor(ms % 60000 / 1000), r = ms % 1000;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
  },
  srt(v) { const e = this.ends(v); return v.segments.map((s, i) => `${i + 1}\n${this.stamp(s.t, ',')} --> ${this.stamp(Math.max(e[i], s.t + 1), ',')}\n${s.x}\n`).join('\n'); },
  vtt(v) { const e = this.ends(v); return 'WEBVTT\n\n' + v.segments.map((s, i) => `${this.stamp(s.t, '.')} --> ${this.stamp(Math.max(e[i], s.t + 1), '.')}\n${s.s ? `<v ${s.s}>` : ''}${s.x}\n`).join('\n'); },
  md(v, { obsidian = false } = {}) {
    const an = v.an || {}, L = [];
    const link = t => v.kind === 'yt' ? `[${fmtT(t)}](https://youtu.be/${v.ytId}?t=${Math.floor(t)})` : `[${fmtT(t)}]`;
    if (obsidian) L.push('---', `title: "${v.title.replace(/"/g, "'")}"`, `url: ${v.pageUrl || v.url || ''}`, `canal: "${(v.channel || '').replace(/"/g, "'")}"`, `fecha: ${new Date().toISOString().slice(0, 10)}`, v.published ? `publicado: ${v.published}` : '', `duracion: ${fmtT(v.duration)}`, `tags: [video, research${(an.tags || []).slice(0, 6).map(t => ', ' + slug(t)).join('')}]`, '---', '');
    L.push(`# ${v.title}`, '', `**${v.channel || ''}** · ${fmtT(v.duration)}${v.url ? ` · [Ver original](${v.pageUrl || v.url})` : ''}`, '');
    if (obsidian) L.push(`#video #research ${(an.tags || []).slice(0, 6).map(t => '#' + slug(t)).join(' ')}`, '');
    if (an.tldr) L.push('## En pocas palabras', ...an.tldr.map(x => '- ' + x), '', an.summary || '', '');
    if (an.keyPoints?.length) L.push('## Ideas clave', ...an.keyPoints.map(k => `- ${k.t != null ? link(k.t) + ' ' : ''}${k.text}`), '');
    if (an.chapters?.length) L.push('## Capítulos', ...an.chapters.map(c => `- ${link(c.t)} **${c.title}**${c.summary ? ' — ' + c.summary : ''}`), '');
    const links = v.links || [];
    if (links.length) L.push('## Enlaces', ...links.map(l => `- [${(l.label || domainOf(l.url)).replace(/[[\]]/g, '')}](${l.url}) _(${l.srcs.map(s => SRC_LABEL[s] || s).join(', ')})_`), '');
    if (an.resources?.length) L.push('## Recursos mencionados', ...an.resources.map(r => `- **${r.name}** (${r.kind})${r.note ? ': ' + r.note : ''}${normUrl(r.url) ? ' — ' + normUrl(r.url) : ''}`), '');
    if (an.quotes?.length) L.push('## Citas', ...an.quotes.map(q => `> “${q.text}”${q.s ? ' — ' + q.s : ''}${q.t != null ? ' ' + link(q.t) : ''}\n`), '');
    if (an.actions?.length) L.push('## Qué hacer', ...an.actions.map(a => '- [ ] ' + a), '');
    if (an.detailed) L.push('## Resumen detallado', an.detailed, '');
    if (v.notes) L.push('## Mis notas', v.notes, '');
    L.push('## Transcripción', '');
    let last = null;
    for (const s of v.segments) {
      if (s.s && s.s !== last) { L.push('', `**${s.s}** ${v.noTimes ? '' : link(s.t)}`); last = s.s; }
      else if (!s.s && !v.noTimes) L.push('', link(s.t));
      L[L.length - 1] += ' ' + s.x;
    }
    if (obsidian) L.push('', '## 🔗 Relacionado', '', ...(an.tags || []).slice(0, 4).map(t => `- [[${t}]]`));
    return L.filter(x => x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
  },
  async obsidian(v) {
    const text = this.md(v, { obsidian: true }), name = slug(v.title);
    if (native) {
      try { const p = await bridge('obsidian', { vault: S.vault, folder: S.folder, name, text }); toast(icon('check') + ' Guardado en Obsidian: ' + esc(p)); } catch (e) { toast(esc(e.message || e), 'err'); }
      return;
    }
    await copyText(text, 'Nota copiada');
    location.href = `obsidian://new?vault=${encodeURIComponent(S.vault)}&file=${encodeURIComponent(S.folder.replace(/\/$/, '') + '/' + name)}&clipboard=true`;
  },
  print(v) {
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(v.title)}</title><style>
      body{font:12pt/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px}
      h1{font-size:22pt;margin:0 0 4px}h2{font-size:14pt;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
      a{color:#4b3fd6}blockquote{border-left:3px solid #7c6cff;margin:8px 0;padding:2px 12px;color:#333}
      .meta{color:#666;font-size:10pt}code{background:#f2f2f2;padding:0 3px}p{margin:6px 0}</style></head><body>${md(this.md(v)).replace(/<button class="ts" data-t="([^"]+)">[^<]*<\/button>/g, '<b>$1</b>')}</body></html>`;
    if (native || ios) { bridge('print', { html }).catch(e => toast(esc(e.message || e), 'err')); return; }
    const w = window.open('', '_blank');
    if (!w) { saveFile(slug(v.title) + '.html', html, 'text/html'); return; }
    w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400);
  },
};

// =====================================================================
// Inicio y biblioteca
// =====================================================================
const App = {
  filter: 'all', q: '',
  async init() {
    applyTheme();
    if (!native && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    this.home();
    addEventListener('hashchange', () => this.route());
    document.addEventListener('keydown', e => this.keys(e));
    const u = new URLSearchParams(location.search).get('u') || new URLSearchParams(location.search).get('url') || new URLSearchParams(location.search).get('text');
    if (u) { history.replaceState(null, '', location.pathname); setTimeout(() => startInput(u), 300); }
    else this.route();
    // trabajos interrumpidos (app cerrada a mitad)
    for (const v of await DB.all('videos')) if (v.status === 'working') { v.status = v.segments.length ? 'partial' : 'error'; v.error = 'Se interrumpió el análisis. Vuelve a intentarlo.'; await DB.put('videos', v); }
    this.renderLib();
  },
  route() {
    const m = location.hash.match(/v=([\w-]+)/);
    if (m) View.open(m[1]);
    else { View.close(); this.screen('home'); this.renderLib(); }
  },
  screen(n) { $('#home').hidden = n !== 'home'; $('#video').hidden = n !== 'video'; document.body.dataset.screen = n; window.scrollTo(0, 0); },

  home() {
    const el = $('#home');
    const inp = h('input', { id: 'omni', type: 'url', inputmode: 'url', autocomplete: 'off', placeholder: 'Pega un enlace de YouTube o de una página con video', oninput: () => this.preview(inp.value), onkeydown: e => { if (e.key === 'Enter') go(); } });
    const go = () => { if (inp.value.trim()) { startInput(inp.value); inp.value = ''; this.preview(''); } else paste(); };
    const paste = async () => {
      try {
        const t = native || ios ? await bridge('paste') : await navigator.clipboard.readText();
        if (t) { inp.value = t.trim(); this.preview(inp.value); if (Engine.parse(t)) go(); }
      } catch { inp.focus(); toast('Mantén presionado el campo y elige «Pegar»'); }
    };
    el.innerHTML = '';
    el.append(
      h('header', { class: 'top glass' },
        h('div', { class: 'brand' }, h('img', { src: 'icon-192.png', alt: '' }), h('b', {}, 'VideoTexto')),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn', 'aria-label': 'Ayuda', html: icon('help'), onclick: () => this.help() }),
        h('button', { class: 'icon-btn', 'aria-label': 'Ajustes', html: icon('settings'), onclick: () => this.settings() })),
      h('section', { class: 'hero' },
        h('div', { class: 'glow' }),
        h('h1', {}, 'Todo lo que dice un video,', h('br'), h('span', { class: 'grad' }, 'en segundos.')),
        h('p', { class: 'sub' }, 'Transcripción completa, enlaces de la descripción y de la pantalla, resumen, capítulos, ideas clave, chat y más — desde YouTube, cualquier página web o tus propios archivos.'),
        h('div', { class: 'omni glass' }, h('span', { class: 'omni-ic', html: icon('link') }), inp,
          h('button', { class: 'btn ghost', html: icon('paste') + '<span class="hide-sm">Pegar</span>', onclick: paste }),
          h('button', { class: 'btn primary', html: icon('sparkle') + 'Analizar', onclick: go })),
        h('div', { id: 'txsel' }),
        h('div', { id: 'preview' }),
        h('div', { class: 'row center wrap hero-actions' },
          h('button', { class: 'chip big', html: icon('upload') + 'Subir video o audio', onclick: () => this.pickFile() }),
          h('button', { class: 'chip big', html: icon('help') + 'Cómo compartir desde YouTube', onclick: () => this.help('share') })),
        S.key ? null : h('div', { class: 'card setup' },
          h('div', { class: 'setup-ic', html: icon('key') }),
          h('div', {}, h('b', {}, 'Activa la IA gratis (1 minuto)'), h('p', { class: 'muted' }, 'VideoTexto usa Gemini de Google, que tiene un nivel gratuito generoso. Solo necesitas pegar tu clave una vez.')),
          h('button', { class: 'btn primary', onclick: () => this.settings() }, 'Configurar'))),
      h('section', { class: 'lib' },
        h('div', { class: 'lib-h' }, h('h2', {}, 'Biblioteca'), h('span', { class: 'grow' }),
          h('div', { class: 'search sm' }, h('span', { html: icon('search') }), h('input', { type: 'search', placeholder: 'Buscar en títulos y transcripciones', oninput: e => { this.q = e.target.value; this.renderLib(); } }))),
        h('div', { class: 'row wrap filters', id: 'libf' }),
        h('div', { class: 'grid', id: 'grid' })));
    this.renderTx();
    this.renderLib();
  },

  renderTx() {
    const el = $('#txsel'); if (!el) return;
    const cur = txChoice();
    el.className = 'txsel';
    el.innerHTML = '';
    el.append(
      h('div', { class: 'row center wrap' }, h('span', { class: 'txlab' }, 'Transcribir con'),
        txList().map(k => h('button', { class: 'chip big' + (k === cur ? ' on' : ''), 'aria-pressed': String(k === cur), html: icon(TX[k].ic) + TX[k].name, onclick: () => {
          saveSettings({ tx: k }); this.renderTx();
          if (k === 'groq' && !S.groqKey) this.settings();
          if (k === 'gemini' && !S.key) this.settings();
        } }))),
      h('p', { class: 'txdesc' }, TX[cur].desc + (cur === 'groq' && !S.groqKey ? ' — falta tu clave de Groq.' : '') + (cur === 'groq' && !native ? ' En iPhone/iPad: solo archivos subidos.' : '')));
  },

  async preview(val) {
    const p = $('#preview'); if (!p) return;
    const src = Engine.parse(val);
    if (!src) { p.innerHTML = ''; return; }
    if (src.kind === 'yt') {
      p.innerHTML = `<div class="pv glass"><img src="https://i.ytimg.com/vi/${src.id}/mqdefault.jpg" alt=""><div><small>YouTube</small><b id="pvt">Video de YouTube</b></div></div>`;
      const oe = await Engine.oembed(src.url);
      if (oe && $('#pvt')) $('#pvt').textContent = oe.title + ' · ' + oe.author_name;
    } else p.innerHTML = `<div class="pv glass"><div class="pv-ic">${icon('globe')}</div><div><small>Página web</small><b>${esc(domainOf(src.url))}</b></div></div>`;
  },

  async pickFile() {
    if (native) { // en el Mac: selector nativo; el archivo se copia a la carpeta de VideoTexto y se sirve localmente
      try { const r = await bridge('pickfile'); if (r) this.nativeFile(r); } catch (e) { toast(esc(e.message || e), 'err'); }
      return;
    }
    const i = h('input', { type: 'file', accept: 'video/*,audio/*', style: 'position:fixed;left:-9999px', onchange: () => { if (i.files[0]) startFile(i.files[0]); i.remove(); } });
    document.body.append(i);
    i.click();
  },
  async nativeFile(r) {
    const id = 'f-' + uid();
    const v = { id, kind: 'file', title: r.name.replace(/\.[^.]+$/, ''), channel: 'Archivo local', added: Date.now(), segments: [], screen: [], chat: [], marks: {}, notes: '', tr: {}, done: {}, status: 'working', mediaUrl: r.media, file: { mime: r.mime } };
    v.thumb = await videoThumb(r.media).catch(() => '');
    await saveV(v);
    location.hash = 'v=' + id;
    Jobs.add(signal => runPipeline(v, { kind: 'nfile', media: r.media, mime: r.mime, name: r.name }, signal));
  },

  async renderLib() {
    const grid = $('#grid'); if (!grid) return;
    let all = (await DB.all('videos')).sort((a, b) => (b.updated || b.added) - (a.updated || a.added));
    const counts = { all: all.length, fav: all.filter(v => v.fav).length, yt: all.filter(v => v.kind === 'yt').length, web: all.filter(v => v.kind === 'web').length, file: all.filter(v => v.kind === 'file').length };
    const f = $('#libf'); f.innerHTML = '';
    if (all.length) for (const [k, l] of [['all', 'Todos'], ['fav', 'Favoritos'], ['yt', 'YouTube'], ['web', 'Web'], ['file', 'Archivos']]) {
      if (k !== 'all' && !counts[k]) continue;
      f.append(h('button', { class: 'chip' + (this.filter === k ? ' on' : ''), onclick: () => { this.filter = k; this.renderLib(); } }, `${l} ${counts[k]}`));
    }
    if (this.filter === 'fav') all = all.filter(v => v.fav); else if (this.filter !== 'all') all = all.filter(v => v.kind === this.filter);
    const q = this.q.trim().toLowerCase();
    let hits = {};
    if (q) all = all.filter(v => {
      if ((v.title + ' ' + (v.channel || '') + ' ' + (v.an?.tags || []).join(' ')).toLowerCase().includes(q)) return true;
      const s = v.segments?.find(s => s.x.toLowerCase().includes(q));
      if (s) { hits[v.id] = s; return true; }
    });
    grid.innerHTML = '';
    if (!all.length) {
      grid.append(h('div', { class: 'empty wide' }, h('div', { class: 'empty-ic', html: icon(q ? 'search' : 'play') }), h('p', {}, q ? 'Sin resultados.' : 'Aquí aparecerán los videos que analices.')));
      return;
    }
    for (const v of all) {
      const st = { working: ['Analizando…', 'busy'], error: ['Error', 'bad'], partial: ['Incompleto', 'warn'], blocked: ['Sin video', 'warn'] }[v.status];
      const hit = hits[v.id];
      grid.append(h('article', { class: 'vcard', onclick: () => { location.hash = 'v=' + v.id; } },
        h('div', { class: 'thumb' }, v.thumb ? h('img', { src: v.thumb, alt: '', loading: 'lazy' }) : h('div', { class: 'thumb-ph', html: icon(v.kind === 'file' ? 'file' : 'globe') }),
          v.duration ? h('span', { class: 'dur' }, fmtT(v.duration)) : null,
          st ? h('span', { class: 'st st-' + st[1] }, st[0]) : null,
          h('span', { class: 'kind', html: icon(v.kind === 'yt' ? 'yt' : v.kind === 'file' ? 'file' : 'globe') })),
        h('div', { class: 'vc-b' },
          h('b', {}, v.title),
          h('small', {}, [v.channel, relDate(v.updated || v.added)].filter(Boolean).join(' · ')),
          hit ? h('p', { class: 'hit-snip' }, h('button', { class: 'ts' }, fmtT(hit.t)), ' …' + snippet(hit.x, q) + '…') : (v.an?.summary ? h('p', { class: 'snip' }, v.an.summary) : null)),
        h('button', { class: 'icon-btn sm vc-more', 'aria-label': 'Opciones', html: icon(v.fav ? 'star-fill' : 'more'), onclick: e => { e.stopPropagation(); this.cardMenu(e.currentTarget, v); } })));
    }
  },
  cardMenu(anchor, v) {
    menu(anchor, [
      { label: v.fav ? 'Quitar de favoritos' : 'Favorito', icon: 'star', run: async () => { v.fav = !v.fav; await DB.put('videos', v); this.renderLib(); } },
      { label: 'Exportar Markdown', icon: 'download', run: () => saveFile(slug(v.title) + '.md', Exporter.md(v), 'text/markdown') },
      { label: 'Enviar a Obsidian', icon: 'gem', run: () => Exporter.obsidian(v) },
      '-',
      { label: 'Eliminar', icon: 'trash', danger: true, run: async () => { if (await confirmBox(`¿Eliminar «${esc(v.title)}»?`, 'Eliminar', true)) { await DB.del('videos', v.id); await DB.del('blobs', v.id); this.renderLib(); } } },
    ]);
  },

  keys(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.metaKey || e.ctrlKey) {
      if (e.key === 'f' && View.v) { e.preventDefault(); View.tab = 'tr'; View.renderTabs(); View.renderTab(); $('#trq')?.focus(); }
      if (e.key === 'k') { e.preventDefault(); location.hash = ''; setTimeout(() => $('#omni')?.focus(), 50); }
      return;
    }
    if (!View.v) { if (e.key === '/') { e.preventDefault(); $('#omni')?.focus(); } return; }
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); Player.toggle(); }
    else if (k === 'j' || e.key === 'ArrowLeft') Player.seek(Player.time() - (k === 'j' ? 10 : 5));
    else if (k === 'l' || e.key === 'ArrowRight') Player.seek(Player.time() + (k === 'l' ? 10 : 5));
    else if (k === '/') { e.preventDefault(); View.tab = 'tr'; View.renderTabs(); View.renderTab(); $('#trq')?.focus(); }
    else if (k === 'escape') location.hash = '';
    else if (/^[1-9]$/.test(k)) { const t = View.tabsDef()[+k - 1]; if (t) { View.tab = t[0]; View.renderTabs(); View.renderTab(); } }
  },

  settings() {
    const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', { class: 'muted', html: hint }) : null);
    const sel = (key, opts, num) => { const s = h('select', { onchange: () => { saveSettings({ [key]: num ? +s.value : s.value }); if (key === 'tx') this.renderTx(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(S[key]) === String(v) }, l))); return s; };
    const key = h('input', { type: 'password', value: S.key, placeholder: 'AIza…', autocomplete: 'off', spellcheck: 'false' });
    const keyMsg = h('small', { class: 'muted' });
    const test = async () => {
      const k = key.value.trim(); if (!k) return;
      keyMsg.textContent = 'Probando…';
      try { await Engine.testKey(k); saveSettings({ key: k }); keyMsg.innerHTML = '<span class="okc">✓ Clave válida y guardada</span>'; this.home(); }
      catch (e) { keyMsg.innerHTML = `<span class="badc">✗ ${esc(e.message)}</span>`; }
    };
    key.onchange = test;
    const gkey = h('input', { type: 'password', value: S.groqKey || '', placeholder: 'gsk_…', autocomplete: 'off', spellcheck: 'false' });
    const gMsg = h('small', { class: 'muted' });
    const gtest = async () => {
      const k = gkey.value.trim(); if (!k) return;
      gMsg.textContent = 'Probando…';
      try {
        const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + k } });
        if (!r.ok) throw new Error(r.status === 401 ? 'Clave no válida' : 'Groq respondió ' + r.status);
        saveSettings({ groqKey: k }); gMsg.innerHTML = '<span class="okc">✓ Clave de Groq válida y guardada</span>'; this.renderTx();
      } catch (e) { gMsg.innerHTML = `<span class="badc">✗ ${esc(e.message)}</span>`; }
    };
    gkey.onchange = gtest;
    const usage = Object.values(S.usage)[0];
    const body = h('div', { class: 'settings' },
      h('section', {}, h('h3', { html: icon('sparkle') + ' Inteligencia artificial' }),
        field('Clave de Gemini (gratis)', h('div', { class: 'row' }, key, h('button', { class: 'btn ghost sm', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, 'Ver'), h('button', { class: 'btn primary sm', onclick: test }, 'Guardar')),
          '1) Entra a <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> con tu cuenta Google · 2) «Create API key» · 3) Pégala aquí. Se guarda solo en este dispositivo.'),
        keyMsg,
        field('Modelo', sel('model', [['gemini-flash-latest', 'Gemini Flash — recomendado (rápido y preciso)'], ['gemini-flash-lite-latest', 'Gemini Flash-Lite — más rápido y con más cuota'], ['gemini-pro-latest', 'Gemini Pro — máxima calidad (cuota menor)']])),
        field('Idioma de resúmenes y chat', sel('lang', Object.entries(LANGS).map(([c, n]) => [c, n[0].toUpperCase() + n.slice(1)])))),
      h('section', {}, h('h3', { html: icon('text') + ' Transcripción' }),
        field('Motor de transcripción', sel('tx', txList().map(k => [k, TX[k].name + ' — ' + TX[k].desc])), 'También se elige en la pantalla de inicio. Si el motor falla, VideoTexto prueba el siguiente disponible.'),
        field('Clave de Groq (gratis)', h('div', { class: 'row' }, gkey, h('button', { class: 'btn ghost sm', onclick: () => { gkey.type = gkey.type === 'password' ? 'text' : 'password'; } }, 'Ver'), h('button', { class: 'btn primary sm', onclick: gtest }, 'Guardar')),
          '1) Entra a <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a> · 2) «Create API Key» · 3) Pégala aquí. Se guarda solo en este dispositivo.'),
        gMsg,
        field('Tamaño de cada parte', sel('chunk', [[600, '10 min — más preciso'], [1200, '20 min — recomendado'], [1800, '30 min — ahorra cuota gratuita']], true), 'Los videos largos se dividen y se transcriben en paralelo.'),
        field('Partes en paralelo', sel('conc', [[1, '1 (cuenta gratuita, más estable)'], [2, '2 (recomendado)'], [3, '3'], [4, '4 (cuenta con facturación)']], true)),
        field('Lectura de pantalla', sel('res', [['low', 'Normal — más rápido y económico'], ['std', 'Detallada — lee mejor texto pequeño y enlaces']])),
        native ? field('Si la API no funciona (Mac)', sel('fallback', [['codex', 'Usar mi cuenta de ChatGPT (Codex)'], ['gemini', 'Usar mi cuenta de Google (Gemini CLI)'], ['off', 'No usar respaldo']]),
          'La transcripción pasa a los subtítulos de YouTube o al dictado de Apple en este Mac (gratis, solo audio: sin hablantes ni texto en pantalla). El resumen, el chat y lo demás usan tu cuenta.') : null),
      h('section', {}, h('h3', { html: icon('eye') + ' Apariencia' }),
        field('Tema', sel('theme', [['auto', 'Automático'], ['dark', 'Oscuro'], ['light', 'Claro']])),
        field('Tamaño del texto', h('input', { type: 'range', min: 13, max: 26, value: S.font, oninput: e => { saveSettings({ font: +e.target.value }); applyTheme(); } })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.follow, onchange: e => saveSettings({ follow: e.target.checked }) }), 'Seguir la reproducción en la transcripción')),
      h('section', {}, h('h3', { html: icon('gem') + ' Obsidian' }),
        field('Nombre de la bóveda', h('input', { value: S.vault, onchange: e => saveSettings({ vault: e.target.value.trim() }) })),
        field('Carpeta', h('input', { value: S.folder, onchange: e => saveSettings({ folder: e.target.value.trim() }) }))),
      h('section', {}, h('h3', { html: icon('box') + ' Datos' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.keepFiles, onchange: e => saveSettings({ keepFiles: e.target.checked }) }), 'Guardar copia de los archivos que subo (para reproducirlos después)'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn ghost sm', html: icon('download') + 'Exportar biblioteca', onclick: async () => saveFile(`glosa-biblioteca-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await DB.all('videos')), 'application/json') }),
          h('button', { class: 'btn ghost sm', html: icon('upload') + 'Importar', onclick: () => { const i = h('input', { type: 'file', accept: '.json,application/json', onchange: async () => { try { const arr = JSON.parse(await i.files[0].text()); for (const v of arr) if (v.id && v.segments) await DB.put('videos', v); toast(`${arr.length} videos importados`); this.renderLib(); } catch { toast('Archivo no válido', 'err'); } } }); i.click(); } }),
          h('button', { class: 'btn danger sm', html: icon('trash') + 'Borrar todo', onclick: async () => { if (await confirmBox('Se borrará toda la biblioteca de este dispositivo.', 'Borrar todo', true)) { await DB.clear('videos'); await DB.clear('blobs'); this.renderLib(); toast('Biblioteca vacía'); } } })),
        usage ? h('p', { class: 'muted small' }, `Hoy: ${usage.n} solicitudes a Gemini · ${(usage.in / 1000).toFixed(0)} mil tokens de entrada · ${(usage.out / 1000).toFixed(0)} mil de salida.`) : null,
        h('p', { class: 'muted small' }, `VideoTexto ${VERSION} ${native ? '· Mac' : ''} · Tus videos y tu clave se guardan solo en este dispositivo.`)));
    sheet('Ajustes', body);
  },

  help(section) {
    const base = location.origin + location.pathname;
    const bm = `javascript:location.href='${native ? 'glosa://open?u=' : base + '?u='}'+encodeURIComponent(location.href)`;
    const body = h('div', { class: 'prose help' },
      h('h3', { id: 'h-share' }, 'Compartir un video desde el iPhone o iPad'),
      h('ol', {},
        h('li', { html: 'En la app de YouTube toca <b>Compartir › Copiar enlace</b>.' }),
        h('li', { html: 'Abre VideoTexto y toca <b>Pegar</b>: el análisis empieza solo.' })),
      h('p', { class: 'muted', html: 'Instala VideoTexto en tu pantalla de inicio: en Safari toca <b>Compartir › Añadir a pantalla de inicio</b>. Se abre como una app, sin barras del navegador y funciona sin conexión para leer tu biblioteca.' }),
      h('h3', {}, 'Atajo para la hoja de compartir (opcional)'),
      h('ol', {},
        h('li', { html: 'App <b>Atajos</b> › <b>+</b> › activa «Mostrar en hoja de compartir» y acepta <b>URL</b>.' }),
        h('li', { html: 'Añade «<b>Codificar URL</b>» con la entrada del atajo.' }),
        h('li', { html: `Añade «<b>Abrir URL</b>» con: <code>${esc(base)}?u=</code> seguido de la URL codificada.` })),
      h('p', { class: 'muted', html: 'El atajo abre VideoTexto en Safari (iOS no permite abrir directamente la app de pantalla de inicio); la biblioteca de Safari y la de la app instalada son independientes.' }),
      h('h3', {}, 'En el Mac'),
      h('p', { html: 'La app <b>VideoTexto para Mac</b> descarga videos de más de 1.000 sitios (Vimeo, X, Instagram, TikTok, noticias…) con <code>yt-dlp</code>, usa subtítulos oficiales si lo eliges y guarda directo en tu bóveda de Obsidian. <b>⌘⇧V</b> analiza el enlace copiado.' }),
      h('p', {}, 'Marcador para cualquier navegador (arrástralo a tu barra de favoritos):'),
      h('p', {}, h('a', { class: 'btn ghost sm', href: bm }, 'Analizar con VideoTexto')),
      h('h3', {}, 'Páginas web con video'),
      h('p', { html: 'Pega el enlace de la página: VideoTexto lee la página, encuentra el video (YouTube o Vimeo incrustado, archivos MP4) y lo transcribe. Si el sitio bloquea la descarga en el iPad, usa el Mac o guarda el video y <b>súbelo</b>.' }),
      h('h3', {}, 'Atajos de teclado'),
      h('div', { class: 'keys' }, [['Espacio / K', 'Reproducir o pausar'], ['J / L', '−10 s / +10 s'], ['← / →', '−5 s / +5 s'], ['/', 'Buscar en la transcripción'], ['1 – 9', 'Cambiar de pestaña'], ['⌘K', 'Nuevo enlace'], ['Esc', 'Volver']].map(([k, d]) => h('div', {}, h('kbd', {}, k), h('span', {}, d)))),
      h('h3', {}, 'Costo'),
      h('p', { html: 'VideoTexto es gratuita. La IA usa el <b>nivel gratuito de Gemini</b> de Google: alcanza para varios videos largos al día. Si algún día necesitas más, puedes activar facturación en AI Studio (centavos de dólar por hora de video).' }),
      h('h3', {}, 'Privacidad'),
      h('p', {}, 'No hay servidores de VideoTexto: tu biblioteca y tu clave se guardan en tu dispositivo, y el video solo se envía a Google Gemini para transcribirlo.'));
    sheet('Ayuda', body, { wide: true });
    if (section) setTimeout(() => $('#h-' + section)?.scrollIntoView(), 50);
  },

  nativeOpen(u) { startInput(u); },
};

function snippet(x, q) {
  const i = x.toLowerCase().indexOf(q);
  return x.slice(Math.max(0, i - 40), i + q.length + 60);
}

window.App = App;
App.init();

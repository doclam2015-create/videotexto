'use strict';
// Glosa — motor: detecta la fuente, obtiene metadatos, transcribe por fragmentos en paralelo con Gemini
// (video + audio, incluido el texto en pantalla) y genera el análisis a partir de la transcripción.

const API = 'https://generativelanguage.googleapis.com';

const Engine = {
  parse(input) {
    const s = String(input || '').trim();
    const urlM = s.match(/https?:\/\/[^\s<>"']+/i);
    const raw = urlM ? urlM[0] : (/^[\w-]{11}$/.test(s) ? 'https://youtu.be/' + s : (/^[\w.-]+\.[a-z]{2,}\//i.test(s) ? 'https://' + s : ''));
    if (!raw) return null;
    const yt = raw.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/i);
    if (/youtube\.com\/(playlist\?|@|channel\/|c\/|user\/)/i.test(raw)) return { kind: 'web', url: raw, list: true };
    if (yt) {
      const t = raw.match(/[?&#](?:t|start)=(\d+)/);
      return { kind: 'yt', id: yt[1], url: 'https://www.youtube.com/watch?v=' + yt[1], start: t ? +t[1] : 0 };
    }
    return { kind: 'web', url: raw };
  },

  // ---------- Gemini ----------
  async gem({ parts, schema, tools, maxTokens = 16000, thinking = 0, media = false, model, signal, onWait, system }) {
    if (!S.key) throw new Error('Falta tu clave gratuita de Gemini. Ábrela en Ajustes (es gratis en aistudio.google.com).');
    // la cuota gratuita es por modelo y por día: si uno se agota se pasa al siguiente de la cadena
    const chain = [...new Set([model || S.model, ...MODEL_CHAIN])].filter(m => !Quota.out(m));
    if (!chain.length) throw new Error('Se agotó la cuota gratuita diaria de todos los modelos de Gemini. Se renueva cada día (o activa facturación en AI Studio para no tener límites).');
    model = chain.shift();
    const body = { contents: parts[0]?.role ? parts : [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (thinking != null && !/pro/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: thinking };
    if (media) body.generationConfig.mediaResolution = S.res === 'std' ? 'MEDIA_RESOLUTION_MEDIUM' : 'MEDIA_RESOLUTION_LOW';
    if (schema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseSchema = schema; }
    if (tools) body.tools = tools;
    let last, busy = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      let r;
      try {
        r = await fetch(`${API}/v1beta/models/${model}:generateContent`, {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.key }, body: JSON.stringify(body),
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        last = new Error('Sin conexión con Gemini.'); await sleep(2000 * (attempt + 1)); continue;
      }
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        addUsage(j.usageMetadata);
        const c = j.candidates?.[0];
        if (!c) throw new Error(j.promptFeedback?.blockReason ? 'Gemini bloqueó el contenido (' + j.promptFeedback.blockReason + ').' : 'Respuesta vacía de Gemini.');
        const text = (c.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        return { text, finish: c.finishReason, usage: j.usageMetadata, meta: c.urlContextMetadata };
      }
      const msg = j.error?.message || r.statusText;
      if (r.status === 400 && /API key/i.test(msg)) throw new Error('La clave de Gemini no es válida. Revísala en Ajustes.');
      if (r.status === 403) throw new Error('Gemini rechazó la clave (403): ' + msg.slice(0, 160));
      const next = why => {
        if (!chain.length) throw new Error('Se agotó la cuota gratuita diaria de todos los modelos de Gemini. Se renueva cada día (o activa facturación en AI Studio para no tener límites).');
        model = chain.shift(); onWait?.(why + '; continúo con ' + model);
        if (/lite|3\.[5-9]-flash-lite/.test(model)) delete body.generationConfig.thinkingConfig;
      };
      if ((r.status === 404 || (r.status === 400 && /invalid argument/i.test(msg))) && chain.length) {
        if (body.generationConfig.thinkingConfig && r.status === 400) { delete body.generationConfig.thinkingConfig; continue; }
        Quota.mark(model); next('Modelo no disponible'); continue;
      }
      if ([429, 500, 502, 503, 504].includes(r.status)) {
        const rd = (j.error?.details || []).find(d => d.retryDelay)?.retryDelay;
        const daily = /per ?day|PerDay/i.test(JSON.stringify(j.error || {})) || (rd && parseFloat(rd) > 120);
        if (daily) { Quota.mark(model); next('Cuota diaria de ' + model + ' agotada'); continue; }
        busy = r.status === 429 ? 0 : busy + 1;
        if (busy >= 2 && chain.length) { busy = 0; next(model + ' está saturado'); continue; }
        const wait = rd ? parseFloat(rd) * 1000 + 500 : Math.min(30000, 3000 * 2 ** attempt);
        onWait?.(r.status === 429 ? `Límite por minuto de Gemini; reintento en ${Math.round(wait / 1000)} s` : `Gemini ocupado; reintento en ${Math.round(wait / 1000)} s`);
        last = new Error(msg);
        await sleep(wait); continue;
      }
      throw new Error('Gemini: ' + msg.slice(0, 240));
    }
    throw last || new Error('Gemini no respondió.');
  },

  json(text) {
    try { return JSON.parse(text); } catch {}
    const m = String(text).match(/```(?:json)?\s*([\s\S]*?)```/) || String(text).match(/(\{[\s\S]*\})/);
    if (m) try { return JSON.parse(m[1]); } catch {}
    return null;
  },

  async testKey(key) {
    const r = await fetch(`${API}/v1beta/models?pageSize=1`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error?.message || 'Clave inválida');
    return true;
  },

  // ---------- subida de archivos (Files API) ----------
  async upload(blob, name, onProg, signal) {
    if (!S.key) throw new Error('Falta tu clave de Gemini (Ajustes).');
    const mime = blob.type || 'video/mp4';
    const start = await fetch(`${API}/upload/v1beta/files`, {
      method: 'POST', signal,
      headers: {
        'x-goog-api-key': S.key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': blob.size, 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: name.slice(0, 100) } }),
    });
    const url = start.headers.get('x-goog-upload-url');
    if (!start.ok || !url) throw new Error('No se pudo iniciar la subida a Gemini.');
    const file = await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
      x.setRequestHeader('X-Goog-Upload-Offset', '0');
      x.upload.onprogress = e => e.lengthComputable && onProg?.(e.loaded / e.total);
      x.onload = () => { try { const j = JSON.parse(x.responseText); j.file ? res(j.file) : rej(new Error(j.error?.message || 'Subida fallida')); } catch { rej(new Error('Subida fallida')); } };
      x.onerror = () => rej(new Error('Se cortó la subida.'));
      signal?.addEventListener('abort', () => { x.abort(); rej(new DOMException('Cancelado', 'AbortError')); });
      x.send(blob);
    });
    let f = file;
    for (let i = 0; i < 120 && f.state === 'PROCESSING'; i++) {
      await sleep(2500);
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      f = await (await fetch(`${API}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': S.key } })).json();
    }
    if (f.state !== 'ACTIVE') throw new Error('Gemini no pudo procesar el archivo (' + (f.error?.message || f.state) + ').');
    return { uri: f.uri, mime: f.mimeType || mime, expires: Date.parse(f.expirationTime) || Date.now() + 47 * 3600e3 };
  },

  // ---------- metadatos ----------
  async oembed(url) {
    try {
      const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url));
      if (r.ok) return await r.json();
    } catch {}
    return null;
  },

  // Lee la página del video (descripción completa y enlaces) con la herramienta url_context de Gemini
  async pageInfo(url, { yt = false, signal, onWait } = {}) {
    const ask = yt
      ? `Usa la herramienta para leer ${url}. Devuelve SOLO un objeto JSON (sin texto adicional) con: "title", "channel", "published" (fecha AAAA-MM-DD si aparece), "duration_seconds" (número), "views" (texto), "description" (la descripción COMPLETA del video, literal, con saltos de línea), "chapters" (lista de {"t": segundos, "title"} si la descripción tiene marcas de tiempo), "links" (TODOS los enlaces de la descripción: lista de {"url", "label"}), "tags" (lista).`
      : `Usa la herramienta para leer ${url}. Es una página web que puede contener uno o más videos. Devuelve SOLO un objeto JSON (sin texto adicional) con: "title", "site", "published", "description" (resumen fiel de la página en 2-4 oraciones), "requires_login" (true si la página pide iniciar sesión, suscripción o es privada y no se ve el contenido), "videos" (lista de {"url", "kind": "youtube"|"vimeo"|"file"|"stream"|"other", "title", "section" (encabezado o sección de la página donde aparece), "duration_seconds", "thumbnail"} con TODAS las URL de video que encuentres: iframes de YouTube/Vimeo, etiquetas <video>/<source>, archivos .mp4/.webm/.m3u8, og:video; si la página es una lista de reproducción, canal o galería, incluye todos los videos listados, hasta 150), "links" (enlaces relevantes del contenido principal: lista de {"url", "label"}), "transcript" (si la página incluye una transcripción del video, cópiala literal; si no, cadena vacía).`;
    // primero el modelo liviano (ahorra cuota); si no entrega JSON válido, el modelo principal
    let r = await this.gem({ parts: [{ text: ask }], tools: [{ url_context: {} }], maxTokens: 12000, model: 'gemini-flash-lite-latest', signal, onWait }).catch(e => { if (e.name === 'AbortError') throw e; return null; });
    let j = r && this.json(r.text);
    if (!j) { r = await this.gem({ parts: [{ text: ask }], tools: [{ url_context: {} }], maxTokens: 12000, signal, onWait }); j = this.json(r.text); }
    const ok = (r.meta?.urlMetadata || []).some(m => /SUCCESS/.test(m.urlRetrievalStatus));
    return j ? { ...j, _ok: ok } : null;
  },

  // ---------- transcripción ----------
  chunkSchema: {
    type: 'OBJECT',
    properties: {
      lang: { type: 'STRING', description: 'código ISO del idioma hablado' },
      segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, s: { type: 'STRING' }, x: { type: 'STRING' } }, required: ['t', 'x'] } },
      screen: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, text: { type: 'STRING' }, url: { type: 'STRING' }, kind: { type: 'STRING', enum: ['link', 'qr', 'slide', 'product', 'person', 'code', 'data', 'other'] } }, required: ['t', 'text', 'kind'] } },
    },
    required: ['segments'],
  },

  async chunk(media, a, b, { speakers = [], signal, onWait }) {
    const prompt = `Eres un transcriptor profesional. Transcribe de forma COMPLETA y LITERAL todo lo que se habla en este fragmento del video (de ${fmtT(a)} a ${fmtT(b)}), en el idioma original, sin resumir, sin traducir y sin omitir nada. Corrige solo la puntuación.
- Divide en segmentos de 1 a 2 oraciones (máximo ~15 s cada uno).
- "t" = segundo de inicio del segmento en la línea de tiempo del video ORIGINAL (entre ${Math.floor(a)} y ${Math.ceil(b)}).
- "s" = hablante: usa su nombre si se presenta o aparece en pantalla; si no, "Hablante 1", "Hablante 2"…${speakers.length ? ' Hablantes ya identificados en partes anteriores: ' + speakers.join(', ') + '. Reutiliza esos mismos nombres.' : ''}
- Si hay tramos sin voz, usa un segmento corto como "[Música]" o "[Silencio]".
- "screen": registra TODO texto relevante que se VEA en pantalla: URLs, dominios, @usuarios, códigos de descuento, códigos QR (describe a dónde llevan), títulos de diapositivas, nombres y cargos en rótulos, productos, cifras y datos clave, fragmentos de código. Con su segundo "t". Si contiene un enlace, ponlo completo en "url".`;
    const r = await this.gem({ parts: [{ file_data: { file_uri: media.uri, ...(media.mime ? { mime_type: media.mime } : {}) }, video_metadata: { start_offset: Math.floor(a) + 's', end_offset: Math.ceil(b) + 's' } }, { text: prompt }], schema: this.chunkSchema, media: true, maxTokens: 32000, signal, onWait });
    const j = this.json(r.text);
    if (!j?.segments) {
      if (b - a > 90) return null; // el llamador lo divide en dos
      return { segments: [], screen: [] };
    }
    // si el modelo usó tiempos relativos al fragmento, los desplazamos
    const ts = j.segments.map(s => +s.t || 0);
    if (a > 30 && ts.length && Math.max(...ts) < a - 5 && Math.max(...ts) <= b - a + 5) {
      j.segments.forEach(s => s.t = +s.t + a); (j.screen || []).forEach(s => s.t = +s.t + a);
    }
    j.segments = j.segments.filter(s => s.x?.trim()).map(s => {
      const spk = (s.s || '').trim(), noise = /^\[?(m[uú]sica|silencio|ruido|aplausos|risas)\]?$/i.test(spk);
      return { t: Math.min(b, Math.max(a, +s.t || a)), s: noise ? '' : spk, x: noise && !/^\[/.test(s.x.trim()) ? `[${spk}] ${s.x.trim()}` : s.x.trim() };
    });
    j.screen = (j.screen || []).map(s => ({ ...s, t: Math.min(b, Math.max(a, +s.t || a)) }));
    return j;
  },

  // ---------- análisis (solo texto: barato y rápido) ----------
  anSchema: {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      tldr: { type: 'ARRAY', items: { type: 'STRING' } },
      summary: { type: 'STRING' },
      detailed: { type: 'STRING', description: 'resumen extenso en Markdown con subtítulos ## y viñetas, citando [m:ss]' },
      chapters: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, title: { type: 'STRING' }, summary: { type: 'STRING' } }, required: ['t', 'title'] } },
      keyPoints: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, text: { type: 'STRING' } }, required: ['text'] } },
      quotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, text: { type: 'STRING' }, s: { type: 'STRING' } }, required: ['text'] } },
      resources: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, kind: { type: 'STRING', enum: ['libro', 'herramienta', 'sitio', 'producto', 'app', 'estudio', 'curso', 'persona', 'organización', 'video', 'otro'] }, url: { type: 'STRING' }, t: { type: 'NUMBER' }, note: { type: 'STRING' } }, required: ['name', 'kind'] } },
      people: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, role: { type: 'STRING' } }, required: ['name'] } },
      actions: { type: 'ARRAY', items: { type: 'STRING' } },
      faq: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'STRING' }, a: { type: 'STRING' } }, required: ['q', 'a'] } },
      glossary: { type: 'ARRAY', items: { type: 'OBJECT', properties: { term: { type: 'STRING' }, def: { type: 'STRING' } }, required: ['term', 'def'] } },
      cards: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'STRING' }, a: { type: 'STRING' } }, required: ['q', 'a'] } },
      claims: { type: 'ARRAY', description: 'afirmaciones verificables con evaluación', items: { type: 'OBJECT', properties: { t: { type: 'NUMBER' }, claim: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['respaldado', 'dudoso', 'falso', 'opinión'] }, note: { type: 'STRING' } }, required: ['claim', 'verdict'] } },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      category: { type: 'STRING' }, tone: { type: 'STRING' }, audience: { type: 'STRING' },
    },
    required: ['tldr', 'summary', 'chapters', 'keyPoints'],
  },

  transcriptText(v, { maxChars = 900000 } = {}) {
    let t = v.segments.map(s => `[${fmtT(s.t)}]${s.s ? ' ' + s.s + ':' : ''} ${s.x}`).join('\n');
    if (t.length > maxChars) t = t.slice(0, maxChars) + '\n[…transcripción recortada…]';
    return t;
  },
  context(v) {
    const scr = (v.screen || []).map(s => `[${fmtT(s.t)}] (${s.kind}) ${s.text}${s.url ? ' → ' + s.url : ''}`).join('\n');
    return `TÍTULO: ${v.title}\nCANAL/SITIO: ${v.channel || ''}\nDURACIÓN: ${fmtT(v.duration)}\nURL: ${v.url || ''}\n` +
      (v.description ? `\nDESCRIPCIÓN:\n${v.description.slice(0, 8000)}\n` : '') +
      (scr ? `\nTEXTO VISTO EN PANTALLA:\n${scr.slice(0, 30000)}\n` : '') +
      `\nTRANSCRIPCIÓN:\n${this.transcriptText(v)}`;
  },

  async analyze(v, { signal, onWait } = {}) {
    const L = langName(S.lang);
    const r = await this.gem({
      system: `Eres un analista experto. Respondes SIEMPRE en ${L}, con precisión y sin inventar: todo lo que afirmes debe estar en el material. Los tiempos "t" son segundos del video.`,
      parts: [{ text: this.context(v) + `\n\nAnaliza el video completo y devuelve el JSON pedido:
- tldr: 3 a 6 viñetas esenciales. summary: un párrafo. detailed: resumen extenso en Markdown, organizado por temas, con marcas [m:ss].
- chapters: capítulos lógicos (entre 4 y 25 según la duración) con t de inicio, título breve y resumen de 1-2 oraciones. Si la descripción trae capítulos, respétalos.
- keyPoints: 6-15 ideas clave con su t. quotes: 4-10 citas textuales memorables con t y hablante.
- resources: TODO lo mencionado o mostrado (libros, herramientas, sitios, productos, apps, estudios, cursos, personas, organizaciones, videos) con url si se conoce con certeza por la descripción o la pantalla (no inventes URLs), t y nota breve.
- people: personas que hablan o se mencionan, con su rol. actions: pasos prácticos o recomendaciones accionables. faq: 4-8 preguntas y respuestas.
- glossary: términos técnicos con definición. cards: 10-16 tarjetas de estudio pregunta/respuesta.
- claims: hasta 8 afirmaciones factuales importantes con veredicto según conocimiento general (respaldado/dudoso/falso/opinión) y nota.
- tags: 5-10 etiquetas. category, tone, audience: una frase cada uno.` }],
      schema: this.anSchema, maxTokens: 24000, signal, onWait,
    });
    const j = this.json(r.text);
    if (!j) throw new Error('No se pudo leer el análisis de Gemini.');
    return j;
  },

  async chat(v, history, q, { signal } = {}) {
    const turns = history.slice(-12).map(m => ({ role: m.r === 'u' ? 'user' : 'model', parts: [{ text: m.x }] }));
    turns.push({ role: 'user', parts: [{ text: q }] });
    const r = await this.gem({
      system: `Eres un asistente que responde preguntas sobre un video usando su transcripción y contenido. Responde en ${langName(S.lang)} en Markdown conciso. Cita los momentos relevantes como [m:ss]. Si la respuesta no está en el video, dilo y luego aporta conocimiento general marcándolo como tal.\n\n` + this.context(v),
      parts: turns, maxTokens: 8000, thinking: 512, signal,
    });
    return r.text;
  },

  async translate(v, lang, onProg, signal) {
    const out = new Array(v.segments.length);
    const size = 120, jobs = [];
    for (let i = 0; i < v.segments.length; i += size) jobs.push(i);
    let done = 0;
    await pool(jobs, 3, async i => {
      const part = v.segments.slice(i, i + size).map(s => s.x);
      const r = await this.gem({
        parts: [{ text: `Traduce al ${langName(lang)} cada elemento de este arreglo JSON, manteniendo el orden y la cantidad exacta de elementos (${part.length}). Devuelve solo el arreglo.\n${JSON.stringify(part)}` }],
        schema: { type: 'ARRAY', items: { type: 'STRING' } }, maxTokens: 30000, signal,
      });
      const arr = this.json(r.text) || [];
      part.forEach((x, k) => out[i + k] = arr[k] || x);
      onProg?.(++done / jobs.length);
    });
    return out;
  },

  async quiz(v, signal) {
    const r = await this.gem({
      parts: [{ text: this.context(v) + `\n\nCrea un cuestionario de 10 preguntas de selección múltiple en ${langName(S.lang)} sobre el contenido del video (comprensión, no detalles triviales). Cada una con 4 opciones, el índice correcto (0-3), una explicación breve y el segundo t donde se trata.` }],
      schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'STRING' }, options: { type: 'ARRAY', items: { type: 'STRING' } }, correct: { type: 'INTEGER' }, why: { type: 'STRING' }, t: { type: 'NUMBER' } }, required: ['q', 'options', 'correct'] } },
      maxTokens: 12000, signal,
    });
    return this.json(r.text) || [];
  },

  async rewrite(v, kind, signal) {
    const asks = {
      article: 'Reescribe el contenido del video como un artículo bien redactado, con título, introducción, secciones con subtítulos y conclusión.',
      notes: 'Convierte el video en apuntes de estudio estructurados (Cornell): conceptos, detalles, ejemplos y resumen final.',
      thread: 'Resume el video como un hilo de 8-12 publicaciones breves para redes sociales.',
      email: 'Redacta un correo breve y profesional que resuma el video para compartirlo con un colega, con los puntos clave y el enlace.',
      mindmap: 'Crea un mapa mental jerárquico del video como lista anidada en Markdown (tema central, ramas y subramas).',
      clean: 'Entrega la transcripción completa limpia y legible: elimina muletillas y repeticiones, agrupa en párrafos por tema con subtítulos, conserva TODO el contenido y el idioma original.',
    };
    const r = await this.gem({ parts: [{ text: this.context(v) + '\n\n' + asks[kind] + ` Responde en ${kind === 'clean' ? 'el idioma original del video' : langName(S.lang)}, en Markdown.` }], maxTokens: 32000, signal });
    return r.text;
  },
};

// modelos de respaldo (cada uno tiene su propia cuota gratuita diaria)
const MODEL_CHAIN = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
const Quota = {
  day: () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), // la cuota se renueva a medianoche del Pacífico
  get() { try { const q = JSON.parse(localStorage.getItem('glosa_quota') || '{}'); return q.day === this.day() ? q : { day: this.day(), out: [] }; } catch { return { day: this.day(), out: [] }; } },
  out(m) { return this.get().out.includes(m); },
  mark(m) { const q = this.get(); if (!q.out.includes(m)) q.out.push(m); try { localStorage.setItem('glosa_quota', JSON.stringify(q)); } catch {} },
};

const LANGS = { es: 'español', en: 'inglés', pt: 'portugués', fr: 'francés', de: 'alemán', it: 'italiano', ja: 'japonés', zh: 'chino', ko: 'coreano', ru: 'ruso', ar: 'árabe' };
const langName = c => LANGS[c] || c;

async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// Une enlaces de todas las fuentes, sin duplicados
function collectLinks(v) {
  const map = new Map();
  const add = (url, label, src, t) => {
    const u = normUrl(url);
    if (!u || /youtube\.com\/hashtag|accounts\.google|googleusercontent|ytimg\.com/.test(u)) return;
    const k = u.replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
    const cur = map.get(k);
    if (cur) { if (!cur.srcs.includes(src)) cur.srcs.push(src); if (cur.t == null && t != null) cur.t = t; if (!cur.label && label) cur.label = label; return; }
    map.set(k, { url: u, label: (label || '').trim(), srcs: [src], t });
  };
  for (const l of v.descLinks || []) add(l.url, l.label, 'desc');
  for (const m of String(v.description || '').matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(m[0], '', 'desc');
  for (const s of v.screen || []) {
    if (s.url) add(s.url, s.text, 'pantalla', s.t);
    for (const m of String(s.text).matchAll(/\b(?:https?:\/\/)?(?:[\w-]+\.)+(?:com|org|net|io|ai|app|dev|co|cl|es|edu|gov|me|tv|ly|gg|info|xyz|link|site|store|shop)(?:\/[^\s]*)?/gi)) add(m[0], s.text, 'pantalla', s.t);
  }
  for (const s of v.segments || []) for (const m of s.x.matchAll(/\b(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|org|net|io|ai|app|dev|cl)(?:\/[^\s,]*)?/gi)) add(m[0], '', 'voz', s.t);
  for (const r of v.an?.resources || []) if (r.url) add(r.url, r.name, 'mencionado', r.t);
  for (const l of v.pageLinks || []) add(l.url, l.label, 'página');
  return [...map.values()];
}

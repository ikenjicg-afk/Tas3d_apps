// TAS3D 2026 — presentations on the projector screen (screen/ only; needs config.js, mqtt.js, deck.js).
// The host chooses the folder "TAS3D 2026 Presentations" on this computer once (Connect folder): one subfolder per speaker.
// PDF pages, pictures and videos are shown full screen, in the order of the file names; PowerPoint / Keynote files are
// listed with a note to save them as PDF. Nothing is uploaded: the files stay here. The speakers' page and the host panel
// get small encrypted previews (current and next slide) and send encrypted commands (next, previous, show on the screen ...).
// Chrome and Edge remember the folder (the browser asks again once after a restart: Reconnect folder); other browsers choose it each time.
(function () {
  const C = window.TAS3D_CHECKIN, B = C.base;
  const PDFJS = new URL("../assets/pdfjs-6.2.108/", document.baseURI).href;
  const PDF = /\.pdf$/i, IMG = /\.(jpe?g|png|webp|gif|avif|bmp|svg)$/i, VID = /\.(mp4|m4v|webm|mov|ogv|mkv|3gp|3g2|avi|wmv|flv|mpe?g|ts|mts|m2ts)$/i;
  // not listed at all: hidden and system files, notes, unfinished downloads
  const SKIP = /^\.|^~\$|^(desktop\.ini|thumbs\.db|icon\r?)$|\.(txt|md|rtf|url|webloc|lnk|ini|db|tmp|part|crdownload|download)$/i;
  // a folder whose name starts with _ ("_SS", "_old", "_src"…) is left out with everything in it, at any depth and in any folder:
  // the organizer keeps there what the host must not see (sources, spare files). Files are not affected by this rule.
  const SKIPDIR = /^_/;
  // a video with the word "loop" in its name plays in a circle until the next slide — however it is written: "Loop", "loop",
  // "_loop", "loop_", "-loop-", "1. loop 1 min", "bg loop2" (not inside another word: "looping"). In every folder, "Screen" too.
  // Every other video plays once: over its last 2 seconds the picture and the sound fade away, and the screen stays black.
  const LOOP = /(^|[^a-z])loop(?![a-z])/i, FADE = 2;
  const loops = (f) => f.k === 'vid' && LOOP.test(f.name.split('/').pop().replace(/\.[a-z0-9]+$/i, ''));
  const nat = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  function once(target, ok, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { clean(); rej(new Error('timeout')); }, ms || 8000);
      const y = () => { clean(); res(); }, n = () => { clean(); rej(new Error('error')); };
      function clean() { clearTimeout(t); target.removeEventListener(ok, y); target.removeEventListener('error', n); }
      target.addEventListener(ok, y); target.addEventListener('error', n);
    });
  }
  // the browser of this computer in a few words ("Chrome 142 · Mac")
  function browserName() {
    const u = navigator.userAgent || '';
    const os = /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Linux/.test(u) ? 'Linux' : '';
    let m, b = 'another browser';
    if ((m = /Edg\/(\d+)/.exec(u))) b = 'Edge ' + m[1];
    else if ((m = /OPR\/(\d+)/.exec(u))) b = 'Opera ' + m[1];
    else if ((m = /YaBrowser\/(\d+)/.exec(u))) b = 'Yandex ' + m[1];
    else if ((m = /Firefox\/(\d+)/.exec(u))) b = 'Firefox ' + m[1];
    else if ((m = /Chrome\/(\d+)/.exec(u))) b = 'Chrome ' + m[1];
    else if ((m = /Version\/(\d+).*Safari/.exec(u))) b = 'Safari ' + m[1];
    return b + (os ? ' · ' + os : '');
  }
  window.TasBrowser = browserName;
  function warnFor(n) {
    if (/\.(pptx?|ppsx?|pptm|potx?|odp)$/i.test(n)) return 'PowerPoint file: the browser cannot show it. Save it as PDF (File → Export → PDF) into this folder; put videos here as separate MP4 files.';
    if (/\.key$/i.test(n)) return 'Keynote file: export it as PDF (File → Export To → PDF) into this folder; put videos here as separate MP4 files.';
    if (/\.(heic|heif)$/i.test(n)) return 'HEIC photo: save it as JPG or PNG.';
    return 'This file type is not shown.';
  }
  async function shortId(name) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name.normalize('NFC'))));
    return Array.from(h.subarray(0, 6), (b) => ('0' + b.toString(16)).slice(-2)).join('');
  }

  window.TasSlidesScreen = function (opt) {
    const hub = opt.hub, view = opt.view, NOFS = new URLSearchParams(location.search).has('nofs');
    const box = TasBox(TasSlidesKey.get());
    const sn = rid();                       // this screen session: commands for an earlier one (or replayed) are ignored
    const UA = browserName();               // "Chrome 142 · Mac": the host panel shows where the screen runs
    const T0 = Date.now();                  // when this screen page was opened: of two open screens the remotes follow the later one
    let seq = 0;
    let root = null;                        // {kind: 'handle', h} | {kind: 'files', top}
    let saved = null, rootName = '', need = 'connect', scanning = false, err = '', scanN = [0, 0], scanMore = false;
    // reading: what the pages are told ("Reading the folder…"). Not every scan is that: the look for new files every 15 s
    // is quiet, unless it finds files to look into — otherwise every panel would flash "reading" four times a minute.
    let reading = false;
    let decks = [], byId = {}, sigAll = '';
    let cfg = { scene: '', deck: '', live: '' };
    let soundBlocked = false;
    const POSK = 'tas3d-slidepos-' + C.room, ack = {};
    let pos = {}; try { pos = JSON.parse(localStorage.getItem(POSK) || '{}') || {}; } catch (e) {}
    // ver[folder]: how many times the position of a folder was changed on purpose (a command, a key). Two screens open at
    // once (a second tab, a monitor backstage) follow the one with the higher number, so they always show the same slide.
    const VERK = 'tas3d-slidever-' + C.room;
    let ver = {}; try { ver = JSON.parse(localStorage.getItem(VERK) || '{}') || {}; } catch (e) {}
    const savePos = () => { try { localStorage.setItem(POSK, JSON.stringify(pos)); localStorage.setItem(VERK, JSON.stringify(ver)); } catch (e) {} };
    const changed = () => { try { opt.onChange && opt.onChange(); } catch (e) {} };

    // ---------- the brokers
    let was = 0;
    const links = TasLinks([B + '/sk', B + '/pv/+'], onMsg, () => {
      const u = links ? links.up() : 0;
      if (u > was) setTimeout(() => { pubSa(); if (decks.length) { pubDk(); decks.forEach(pubPv); } }, 400);   // a broker that restarted gets everything again
      if (u !== was) setTimeout(changed, 0);           // the host panel in this browser shows how many servers this screen has
      was = u;
    });
    const seal = (t, o) => box.seal(t, o);
    async function pub(t, o, retain) { try { await links.pub(t, await seal(t, o), { qos: 1, retain: !!retain }); } catch (e) {} }
    // the latest state of a topic (small): sent again until a broker has it, unless a newer one came meanwhile
    const keepN = {};
    function keep(t, o) {
      const n = keepN[t] = (keepN[t] || 0) + 1;
      (async function go(k) {
        if (keepN[t] !== n) return;
        try { await links.pub(t, await seal(t, o), { qos: 1, retain: true }); }
        catch (e) { if (k < 12) setTimeout(() => go(k + 1), 700 + k * 300); }
      })(0);
    }
    // "the screen is on", and everything the host panel shows under Screen settings (the screen itself shows none of it to
    // the hall): the folder and what is in it, the sound, the window (full screen, active), the servers, the version
    function saInfo() {
      let ins = null;
      try {
        const spN = (decks.find((d) => d.sp) || { files: [] }).files.filter((f) => f.c).length, hoD = decks.find((d) => d.ho), hoN = hoD ? hoD.files.filter((f) => f.c).length : -1;
        // inside the folder: speakers, files in "Host" (-1 = no folder), tracks, music, files in "Screen", quiz pictures
        ins = [decks.length - (spN ? 1 : 0) - (hoN >= 0 ? 1 : 0), hoN, slots.length, bgList.length, spN, quiz.filter((q) => q.a).length];
      } catch (e) {}                                  // called before the lists below exist
      return { sn, st: T0, seq: ++seq, t: Date.now(), ua: UA, v: window.TAS3D_BUILD || '', fl: window.TAS3D_FILE ? 1 : 0, fc: document.hasFocus() ? 1 : 0, f: !!root && !need && !reading ? 1 : 0, need: reading ? 'reading' : need, folder: rootName, n: decks.length, snd: soundBlocked ? 0 : 1, au: sroot ? 1 : 0, gp: window.TasGameGfx ? String(window.TasGameGfx() || '').slice(0, 60) : '',
        fs: document.fullscreenElement || document.webkitFullscreenElement ? 1 : 0, up: links ? links.up() : 0, kind: root ? root.kind : '', err: String(err || '').slice(0, 200),
        rd: reading && scanN[1] ? scanN : null,       // reading the folder: [files looked into, files to look into]
        in: ins };
    }
    function pubSa() { pub(B + '/sa', saInfo()); }
    setInterval(pubSa, 8000); setTimeout(pubSa, 1500);
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => setTimeout(pubSa, 300)));
    // the keys of a clicker go to the window that is active on this computer: the host panel is told when this one is not
    let fcT = 0;
    ['focus', 'blur'].forEach((ev) => window.addEventListener(ev, () => { clearTimeout(fcT); fcT = setTimeout(pubSa, 400); }));
    // closing or reloading this page: "bye" (sealed in advance, so it goes out at once) — the remotes forget this screen
    let byeText = '';
    box.seal(B + '/sa', { sn, bye: 1, t: Date.now() }).then((x) => { byeText = x; });
    window.addEventListener('pagehide', () => { if (byeText) try { links.pub(B + '/sa', byeText, {}).catch(() => {}); } catch (e) {} });
    let helloAt = 0;
    function pubDk() {
      pub(B + '/dk', { sn, st: T0, seq: ++seq, t: Date.now(), folder: rootName, quiz: quiz.length ? quiz.map((q) => ({ n: q.n, a: q.a })) : undefined, decks: decks.map((d) => ({
        id: d.id, name: d.name, total: d.total, sp: d.sp ? 1 : undefined, ho: d.ho ? 1 : undefined,
        files: d.files.map((f) => ({ n: f.name, k: f.k, c: f.c, from: f.from, dur: f.dur ? Math.round(f.dur) : undefined, lp: loops(f) ? 1 : undefined, q: f.q ? 1 : undefined, w: f.w || undefined }))
      })) }, true);
    }
    setInterval(() => { if (decks.length) pubDk(); }, 60000);

    // ---------- commands from the remotes
    const seen = new Set(), seenQ = [], lastK = {};
    async function onMsg(t, x) {
      if (t.indexOf(B + '/pv/') === 0) return onPv(t.slice(B.length + 4), x);
      if (t !== B + '/sk' || !x) return;
      const d = await box.open(t, x);
      if (!d || typeof d.n !== 'string' || d.n.length > 40 || seen.has(d.n)) return;   // the same command comes through both brokers
      seen.add(d.n); seenQ.push(d.n); if (seenQ.length > 3000) seen.delete(seenQ.shift());
      if (d.op === 'hello') { if (Date.now() - helloAt > 1000) { helloAt = Date.now(); pubSa(); pubAu(); } return; }
      if (d.op === 'reload') { if (d.from === 'host' && opt.reload) opt.reload(); return; }   // the host's "Update the screen"
      if (d.op === 'upd') { if (opt.check) opt.check(); return; }                             // "a newer version is out: look now" 
      if (d.op === 'scrvol') {                         // the volume of the videos from "Screen": the host only
        if (d.from === 'host' && (Array.isArray(d.sn) ? d.sn.indexOf(sn) >= 0 : d.sn === sn) && typeof d.x === 'number' && d.x >= 0 && d.x <= 1) setScrVol(d.x);
        return;
      }
      if (d.op === 'snd') {                            // sound: the host only
        if (d.from === 'host' && (Array.isArray(d.sn) ? d.sn.indexOf(sn) >= 0 : d.sn === sn)) sound(d);
        return;
      }
      if (!(Array.isArray(d.sn) ? d.sn.indexOf(sn) >= 0 : d.sn === sn)) return;   // for this screen (and this session) only
      const dk = byId[d.d]; if (!dk) return;
      if ((dk.sp || dk.ho) && d.from !== 'host') return;   // the pause pictures and the host's own folder: the host only
      if (d.op === 'pix') { picsAgain(dk); return; }       // a remote has no picture of this folder: send them again
      const i = pos[dk.id] || 0, on = isOn(dk);
      // the host controls everything; a speaker controls the screen only after the host's Start (cfg.live),
      // and before that may only look through their own slides while they are not on the screen
      const boss = d.from === 'host' || cfg.live === dk.id;
      if (!boss && (on || /^(show|hide|play|pause|restart)$/.test(d.op))) return;
      if (d.from !== 'host' && /^(show|hide)$/.test(d.op) && opt.locked && opt.locked()) return;   // the opening game is on the screen
      // a tap that comes late, after a later tap of the same remote was already done (it took a slower way): not done
      if (typeof d.c === 'string' && d.c.length < 30 && Number.isInteger(d.k)) {
        if (d.k < (lastK[d.c] || 0) && /^(go|next|prev|file)$/.test(d.op)) return;
        lastK[d.c] = Math.max(lastK[d.c] || 0, d.k);
      }
      switch (d.op) {
        case 'next': setPos(dk, i + 1); break;
        case 'prev': setPos(dk, i - 1); break;
        case 'go': if (Number.isInteger(d.i)) setPos(dk, d.i); break;
        case 'file': if (Number.isInteger(d.f) && dk.files[d.f] && dk.files[d.f].c) setPos(dk, dk.files[d.f].from); break;
        case 'show':
          if (Number.isInteger(d.f) && dk.files[d.f] && dk.files[d.f].c) setPos(dk, dk.files[d.f].from);
          if (!on) hub.setCfg({ scene: 'slides', deck: dk.id });
          break;
        case 'hide': if (on) hub.setCfg({ scene: 'blank' }); break;   // taken off the screen: black
        case 'play': case 'pause': case 'restart': if (on) video(d.op); break;
        default: return;
      }
      ack[dk.id] = d.n; pubPv(dk);
    }
    function isOn(d) { return cfg.scene === 'slides' && cfg.deck === d.id; }
    function setPos(d, i) {
      if (!d.total) return;
      i = Math.max(0, Math.min(d.total - 1, i | 0));
      if ((pos[d.id] || 0) === i) return;
      pos[d.id] = i; ver[d.id] = (ver[d.id] || 0) + 1; savePos();
      if (isOn(d)) paint();
    }
    // ---------- another screen open at the same time: the position that was set last wins on both
    const held = {};                                   // positions that came before this screen has read the folder
    async function onPv(id, x) {
      if (!x) return;
      const p = await box.open(B + '/pv/' + id, x);
      if (!p || p.sn === sn || !Number.isInteger(p.i) || !Number.isInteger(p.pn) || !Number.isInteger(p.total)) return;   // mine, or a screen of an older version
      const d = byId[id];
      if (d) follow(d, p); else held[id] = p;
    }
    function follow(d, p) {
      if (p.total !== d.total || !d.total) return;       // that screen has other files in this folder: nothing to compare
      const mine = ver[d.id] || 0, i = Math.min(pos[d.id] || 0, d.total - 1), to = Math.max(0, Math.min(d.total - 1, p.i));
      if (p.pn > mine || (p.pn === mine && to !== i && String(p.sn) > sn)) {
        ver[d.id] = p.pn; pos[d.id] = to; savePos();
        if (to !== i) { if (isOn(d)) paint(); pics(d, 300); }
      } else if (p.pn < mine || (p.pn === mine && to !== i)) pubPv(d);   // mine is newer: it goes out again and that screen follows
    }

    // ---------- the folder
    function idb() {
      return new Promise((ok, no) => {
        const r = indexedDB.open('tas3d-slides', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
      });
    }
    async function kv(k, v) {
      const db = await idb();
      return new Promise((ok, no) => {
        const tx = db.transaction('kv', v === undefined ? 'readonly' : 'readwrite'), st = tx.objectStore('kv');
        const r = v === undefined ? st.get(k) : st.put(v, k);
        r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
      });
    }
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true;
    input.setAttribute('webkitdirectory', ''); input.setAttribute('directory', ''); input.id = 'slidesDir';
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      if (!input.files || !input.files.length) return;
      const top = treeFromFiles(Array.from(input.files));
      root = { kind: 'files', top }; rootName = top.name; need = ''; err = '';
      scan();
    });
    async function useHandle(h, save) {
      root = { kind: 'handle', h }; saved = h; rootName = h.name; need = ''; err = '';
      if (save) { try { await kv('dir', h); } catch (e) {} }
      await scan();
    }
    // a click on this computer: choose the folder (or allow the one chosen before)
    async function connect(fresh) {
      if (!fresh && saved && need === 'reconnect') {
        try { if ((await saved.requestPermission({ mode: 'read' })) === 'granted') return useHandle(saved, false); } catch (e) {}
      }
      if (window.showDirectoryPicker && !NOFS) {
        try { await useHandle(await window.showDirectoryPicker({ id: 'tas3d-slides', mode: 'read' }), true); }
        catch (e) { if (e && e.name !== 'AbortError') { err = 'This folder cannot be opened: ' + (e.message || e.name); changed(); } }
      } else { input.value = ''; input.click(); }
    }
    (async () => {                                    // the folder chosen last time
      if (NOFS || !window.indexedDB) return;
      let h = null; try { h = await kv('dir'); } catch (e) {}
      if (!h || h.kind !== 'directory') return;
      saved = h; rootName = h.name;
      let q = 'prompt'; try { q = await h.queryPermission({ mode: 'read' }); } catch (e) {}
      if (q === 'granted') useHandle(h, false); else { need = 'reconnect'; changed(); pubSa(); }
    })();

    // The host panel open in this same browser (the same computer) chose the folder, or allowed it again, in its own
    // window: the browser's permission is for the site, not for one tab, and the folder is in the store both pages share.
    // Nothing is asked here (asking needs a click on this page): if the browser says "not allowed", it stays "reconnect".
    // quiet: the look this page takes by itself every 3 s while it has no folder — nothing is said unless something changes.
    let adopting = false;
    async function adopt(quiet) {
      if (NOFS || !window.indexedDB || adopting) return false;
      adopting = true;
      try {
        let h = null; try { h = await kv('dir'); } catch (e) {}
        if (!h || h.kind !== 'directory') return false;
        let q = 'prompt'; try { q = await h.queryPermission({ mode: 'read' }); } catch (e) {}
        if (q !== 'granted') {
          if (need !== 'reconnect' || rootName !== h.name) { saved = h; rootName = h.name; need = 'reconnect'; err = ''; changed(); pubSa(); }
          return false;
        }
        // allowed. Is the folder there (not moved, the disk not taken out)? A quiet look does not start a scan that would fail.
        if (quiet) { try { for await (const e of h.values()) break; } catch (e) { return false; } }
        if (!need && root && root.kind === 'handle' && saved && (await saved.isSameEntry(h).catch(() => false))) { if (!quiet) scan(); return true; }   // the same folder, connected already
        await useHandle(h, false); pubSa();
        return true;
      } finally { adopting = false; }
    }
    // No folder (never chosen here, or the browser wants to be asked, or the folder was away): look every 3 s whether it
    // has come — chosen or allowed in the host panel (its message may get lost), or the disk is back. No click needed.
    setInterval(() => { if (need && !scanning && (!root || root.kind === 'handle')) adopt(true).catch(() => {}); }, 3000);

    async function drop(items) {
      const its = Array.from(items || []).filter((x) => x.kind === 'file');
      if (!its.length) return false;
      const it = its[0];
      // both are asked for right away: the dropped item is readable only during the drop event
      const hp = it.getAsFileSystemHandle && !NOFS ? it.getAsFileSystemHandle().catch(() => null) : null;
      const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (hp) {                                       // Chrome, Edge: a real folder, remembered and watched for new files
        const h = await hp;
        if (h && h.kind === 'directory') { await useHandle(h, true); return true; }
      }
      if (en && en.isDirectory) {                     // Safari, Firefox: read the files now
        scanning = true; reading = true; changed();
        const list = [];
        await readEntries(en, en.name + '/', list, 0);
        scanning = false; reading = false;
        const top = treeFromFiles(list);
        root = { kind: 'files', top }; rootName = top.name || en.name; need = ''; err = '';
        await scan();
        return true;
      }
      err = 'Drop the folder itself (TAS3D 2026 Presentations), not files from it.'; changed();
      return false;
    }
    function readEntries(dir, prefix, out, depth) {
      return new Promise((ok) => {
        const r = dir.createReader(), all = [];
        const more = () => r.readEntries(async (batch) => {
          if (batch.length) { all.push(...batch); return more(); }
          for (const e of all) {
            if (SKIP.test(e.name)) continue;
            if (e.isDirectory) { if (depth < 4) await readEntries(e, prefix + e.name + '/', out, depth + 1); }
            else { try { const f = await new Promise((y, n) => e.file(y, n)); out.push({ rel: prefix + e.name, file: f }); } catch (x) {} }
          }
          ok(out);
        }, () => ok(out));
        more();
      });
    }
    function treeFromFiles(list) {                    // "Root/Speaker/file.pdf" (from <input webkitdirectory> or a dropped folder)
      const top = { name: '', dirs: [], files: [] }, dirs = new Map();
      for (const x of list) {
        const f = x.file || x;
        const parts = (x.rel || f.webkitRelativePath || f.name).split('/');
        if (!top.name) top.name = parts.length > 1 ? parts[0] : 'Files';
        const rest = parts.length > 1 ? parts.slice(1) : parts;
        if (rest.length > 1 && !SKIP.test(rest[0]) && !SKIPDIR.test(rest[0]) && !dirs.has(rest[0])) { const d = { name: rest[0], files: [] }; dirs.set(rest[0], d); top.dirs.push(d); }   // a speaker's folder with only a note in it is still listed
        if (rest.some((p) => SKIP.test(p)) || rest.slice(0, -1).some((p) => SKIPDIR.test(p)) || rest.length > 4) continue;
        const ent = { path: rest.slice(rest.length > 1 ? 1 : 0).join('/'), sig: rest.join('/') + '|' + f.size + '|' + f.lastModified, get: () => Promise.resolve(f) };
        if (rest.length === 1) top.files.push(ent);
        else { let d = dirs.get(rest[0]); if (!d) { d = { name: rest[0], files: [] }; dirs.set(rest[0], d); top.dirs.push(d); } d.files.push(ent); }
      }
      return top;
    }
    async function walk(dir, prefix, deckName, depth, out) {
      for await (const e of dir.values()) {
        if (SKIP.test(e.name)) continue;
        if (e.kind === 'directory') { if (depth < 3 && !SKIPDIR.test(e.name)) await walk(e, prefix + e.name + '/', deckName, depth + 1, out); continue; }
        let f; try { f = await e.getFile(); } catch (x) { continue; }
        out.push({ path: prefix + e.name, sig: deckName + '/' + prefix + e.name + '|' + f.size + '|' + f.lastModified, get: () => e.getFile() });
      }
      return out;
    }
    async function readTree() {
      if (root.kind === 'files') return root.top;
      const top = { name: root.h.name, dirs: [], files: [] };
      for await (const e of root.h.values()) {
        if (SKIP.test(e.name)) continue;
        if (e.kind === 'directory') { if (!SKIPDIR.test(e.name)) top.dirs.push({ name: e.name, files: await walk(e, '', e.name, 1, []) }); }
        else { let f; try { f = await e.getFile(); } catch (x) { continue; } top.files.push({ path: e.name, sig: '/' + e.name + '|' + f.size + '|' + f.lastModified, get: () => e.getFile() }); }
      }
      return top;
    }

    // what is in each file (kept by file signature, so a new scan does not open everything again) — also over a reload of
    // the page and a restart of the browser (localStorage): the folder is "connected" in a moment, not after every PDF and
    // video has been opened once more. A file that changed has another signature (size, date) and is looked into again.
    const meta = new Map(), METAK = 'tas3d-meta-' + C.room;
    try { const o = JSON.parse(localStorage.getItem(METAK) || '{}'); Object.keys(o).forEach((k) => { const m = o[k]; if (m && /^(pdf|img|vid)$/.test(m.k)) meta.set(k, m); }); } catch (e) {}
    let metaT = 0, metaDirty = false;
    function metaFlush() {
      clearTimeout(metaT); metaT = 0;
      if (!metaDirty) return;
      metaDirty = false;
      const o = {}; let n = 0;
      [...meta.entries()].reverse().forEach(([k, m]) => { if (n < 600 && /^(pdf|img|vid)$/.test(m.k)) { o[k] = m; n++; } });   // not the "does not open" ones: they get another try
      try { localStorage.setItem(METAK, JSON.stringify(o)); } catch (e) {}
    }
    function metaSave() { metaDirty = true; if (!metaT) metaT = setTimeout(metaFlush, 500); }
    window.addEventListener('pagehide', metaFlush);
    let lookedN = 0; const lookedLast = [];            // files this page has opened to see what is in them (tests)
    async function inspect(f) {
      if (meta.has(f.sig)) return meta.get(f.sig);
      lookedN++; lookedLast.push(f.sig); if (lookedLast.length > 6) lookedLast.shift();
      const n = f.path.split('/').pop();
      let m = { k: 'bad', c: 0, dur: 0, w: '' };
      if (PDF.test(n)) {
        // the PDF reader itself (pdf.js) comes from the site: without it no PDF opens, and the file is not to blame
        let ok = true; try { await lib(); } catch (e) { ok = false; }
        if (!ok) return { k: 'bad', c: 0, dur: 0, w: 'The PDF reader did not load (no internet on the screen computer?). Check the connection and reload the screen page.' };
        try { m = { k: 'pdf', c: (await pdfDoc(f)).numPages, dur: 0, w: '' }; } catch (e) { m.w = 'This PDF does not open. Export it again from PowerPoint or Keynote.'; }
      }
      else if (IMG.test(n)) m = { k: 'img', c: 1, dur: 0, w: '' };
      else if (VID.test(n)) { try { const vl = await videoLength(f); m = { k: 'vid', c: 1, dur: vl.dur, q: vl.q, w: '' }; } catch (e) { m.w = 'This video does not play in this browser. Save it as MP4 (H.264 video, AAC sound).'; } }
      else m.w = warnFor(n);
      meta.set(f.sig, m); metaSave();
      return m;
    }
    // every file not looked into yet, four at a time (a folder of big PDFs and videos is read several times faster);
    // the host panel sees how far it is
    async function inspectAll(files) {
      const todo = files.filter((f) => !meta.has(f.sig) && !SKIP.test(f.path));
      scanN = [0, todo.length];
      if (!todo.length) return;
      if (!reading) { reading = true; changed(); pubSa(); }   // the quiet look found new files: now it is a reading
      let i = 0, saidAt = 0;
      await Promise.all([0, 1, 2, 3].map(async () => {
        while (i < todo.length) {
          const f = todo[i++];
          try { await inspect(f); } catch (e) {}
          scanN = [scanN[0] + 1, todo.length];
          if (Date.now() - saidAt > 700) { saidAt = Date.now(); changed(); pubSa(); }
        }
      }));
      metaFlush();                                     // kept at once: a reload a moment later finds it
    }
    async function videoLength(f) {
      const v = document.createElement('video'), url = URL.createObjectURL(await f.get());
      try {
        v.muted = true; v.preload = 'metadata'; v.src = url;
        await once(v, 'loadedmetadata', 10000);
        if (!v.videoWidth) throw new Error('no picture');
        // q: the file has no sound the browser can play (no sound track, or a kind it does not know: AC-3, DTS)
        let q = 0; try { if (v.captureStream) q = v.captureStream().getAudioTracks().length ? 0 : 1; } catch (e) {}
        return { dur: isFinite(v.duration) ? v.duration : 0, q };
      } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
    }
    async function buildDeck(folder, files) {
      files.sort((a, b) => nat(a.path, b.path));
      const nm = (folder || '').normalize('NFC');      // one form of letters (Mac gives decomposed ones, e.g. й)
      const d = { id: await shortId(folder || rootName), name: nm ? (nm.replace(/^\d+[\s._\-–—]*/, '') || nm) : rootName.normalize('NFC'), files: [], items: [], total: 0 };
      for (const f of files) {
        const m = await inspect(f);
        const e = { name: f.path.normalize('NFC'), k: m.k, c: m.c, dur: m.dur, q: m.q, w: m.w, sig: f.sig, get: f.get, from: d.items.length };
        for (let p = 0; p < e.c; p++) d.items.push([d.files.length, p]);
        d.files.push(e);
      }
      d.total = d.items.length;
      return d;
    }
    // the inner folders by name (a number in front is fine: "00 Screen"); Cyrillic names too
    const bare = (n) => String(n || '').normalize('NFC').replace(/^\d+[\s._\-–—]*/, '');
    const SNDNAME = /^(sounds?|audio|звуки?)(?![a-zа-яё0-9])/i, MUSNAME = /^(music|музыка)(?![a-zа-яё0-9])/i, SCRNAME = /^(screens?|splash|заставк[аи]|скрин)(?![a-zа-яё0-9])/i, HOSTNAME = /^(host|хост|ведущий)(?![a-zа-яё0-9])/i, QUIZNAME = /^(quiz|квиз|викторина)(?![a-zа-яё0-9])/i;
    // the quiz "Render or photo?": the pictures of the folder "Quiz" in name order; the answer is in the file name
    let quiz = [], quizSig = '';
    // "Game": the picture of the opening game (and the prank's sounds), right on this computer — no download needed
    const GAMENAME = /^(game|игра)(?![a-zа-яё0-9])/i;
    let gamePic = null, gamePicSig = '', gameFx = {};
    const quizUrls = new Map();
    function quizAnswer(name) {
      const n = name.replace(/\.[a-z0-9]+$/i, '').toLowerCase(), r = /render|рендер|(^|[^a-z])cg/.test(n), p = /photo|foto|фото|real/.test(n);
      return r && !p ? 'r' : p && !r ? 'p' : '';
    }
    async function scan(quiet) {
      if (!root) return;
      if (scanning) { if (!quiet) scanMore = true; return; }   // asked for while reading: once more right after (another folder may have come)
      scanning = true; scanN = [0, 0];
      const errWas = err, needWas = need; let chg = false;
      if (!quiet) { reading = true; changed(); pubSa(); }
      try {
        const top = await readTree();
        top.dirs.sort((a, b) => nat(a.name, b.name));
        // inside the one folder: "Sound" = the 6 tracks (speakers coming out, transitions), "Music" = background music,
        // "Screen" = the pictures / videos for a pause. None of them is a speaker.
        const sdir = top.dirs.find((x) => SNDNAME.test(bare(x.name))), mdir = top.dirs.find((x) => MUSNAME.test(bare(x.name)));
        let qchg = false;
        const qdir = top.dirs.find((x) => QUIZNAME.test(bare(x.name))), gdir = top.dirs.find((x) => GAMENAME.test(bare(x.name)));
        top.dirs = top.dirs.filter((x) => x !== sdir && x !== mdir && x !== qdir && x !== gdir);
        {                                               // "Game": its picture (a name with "final" first, else the first one) and sounds
          const gf = gdir ? gdir.files.filter((f) => f.path.indexOf('/') < 0 && !SKIP.test(f.path)).sort((a, b) => nat(a.path, b.path)) : [];
          const pics = gf.filter((f) => IMG.test(f.path) && !/\.svg$/i.test(f.path)), pic = pics.find((f) => /final|финал/i.test(f.path)) || pics[0] || null;
          const fx = {};
          gf.filter((f) => AUD.test(f.path)).forEach((f) => { for (const k in FXKIND) if (!fx[k] && FXKIND[k].test(f.path)) fx[k] = { name: f.path, sig: f.sig, get: f.get }; });
          gameFx = fx;
          const ps = pic ? pic.path + '|' + pic.sig : '';
          if (ps !== gamePicSig) {
            gamePicSig = ps;
            if (gamePic && gamePic.url) { try { URL.revokeObjectURL(gamePic.url); } catch (e) {} }
            gamePic = pic ? { name: pic.path, url: '' } : null;
            if (pic) { try { const blob = await pic.get(); if (gamePic && gamePic.name === pic.path) gamePic.url = URL.createObjectURL(blob); } catch (e) { gamePic = null; } }
            try { opt.onGamePic && opt.onGamePic(gamePic && gamePic.url ? gamePic.url : ''); } catch (e) {}
          }
        }
        {                                               // "Quiz": pictures for "Render or photo?" — not a speaker either
          const qf = qdir ? qdir.files.filter((f) => f.path.indexOf('/') < 0 && IMG.test(f.path) && !SKIP.test(f.path)).sort((a, b) => nat(a.path, b.path)) : [];
          const qs = JSON.stringify(qf.map((f) => f.sig));
          if (qs !== quizSig) {
            quizSig = qs;
            quizUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} }); quizUrls.clear();
            quiz = qf.map((f) => ({ n: f.path, a: quizAnswer(f.path), sig: f.sig, get: f.get }));
            qchg = true;                                 // the list for the host panel goes out again
          }
        }
        if (sdir || mdir) {
          const files = [];
          if (sdir) sdir.files.forEach((f) => files.push({ path: f.path, sig: f.sig, get: f.get }));
          if (mdir) mdir.files.forEach((f) => files.push({ path: 'Music/' + f.path, sig: f.sig, get: f.get }));
          const was = sroot ? sroot.sig : '', sig = JSON.stringify(files.map((f) => [f.path, f.sig]));
          sroot = { files, sig }; sname = [sdir && sdir.name, mdir && mdir.name].filter(Boolean).join(' + ');
          if (sig !== was) soundScan();
        } else if (sroot) { sroot = null; sname = ''; slots = []; bgList = []; fxFiles = {}; sSig = ''; stopSlot(0); pubAu(); }
        const sig = JSON.stringify([top.name, top.dirs.map((x) => [x.name, x.files.map((f) => f.sig)]), top.files.map((f) => f.sig)]);
        if (sig !== sigAll) {
          chg = true;
          await inspectAll(top.dirs.reduce((a, x) => a.concat(x.files), []).concat(top.files));
          const list = [];
          for (const x of top.dirs) {
            const d = await buildDeck(x.name, x.files);
            if (SCRNAME.test(bare(x.name))) d.sp = 1;             // pictures for a pause: the host's Screen tab
            else if (HOSTNAME.test(bare(x.name))) d.ho = 1;       // the host's own slides: only the host sees and shows them
            list.push(d);
          }
          if (top.files.some((f) => !SKIP.test(f.path))) list.push(await buildDeck('', top.files));   // files right in the chosen folder
          const old = byId;
          decks = list; byId = {}; list.forEach((d) => { byId[d.id] = d; });
          sigAll = sig;
          pubDk();
          for (const d of list) {
            if (pos[d.id] >= d.total) pos[d.id] = Math.max(0, d.total - 1);
            if (held[d.id]) { const h = held[d.id]; delete held[d.id]; follow(d, h); }
            const o = old[d.id];
            if (!o || JSON.stringify(o.files.map((f) => f.sig)) !== JSON.stringify(d.files.map((f) => f.sig))) pubPv(d);
          }
          savePos();
          if (cfg.scene === 'slides') paint();
        } else if (qchg) pubDk();
        // somebody chose one of the inner folders instead of the main one
        err = SNDNAME.test(bare(top.name)) || MUSNAME.test(bare(top.name)) || SCRNAME.test(bare(top.name))
          ? 'This is the folder “' + top.name + '” itself. Choose the main folder (TAS3D 2026 Presentations): Sound, Music and Screen go inside it.' : '';
      } catch (e) {
        // the folder was moved or renamed, or the browser took the permission back
        err = 'The folder cannot be read now: ' + (e.message || e.name);
        if (root.kind === 'handle' && e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) need = 'reconnect';
        if (e && e.name === 'NotFoundError') { need = 'connect'; root = null; }
      }
      const said = reading;
      scanning = false; reading = false;
      if (said || chg || err !== errWas || need !== needWas) { changed(); pubSa(); }
      if (scanMore) { scanMore = false; if (root) scan(); }
    }
    // new files appear by themselves (a folder chosen with Connect folder in Chrome or Edge)
    setInterval(() => { if (root && root.kind === 'handle' && !need) scan(true); }, 15000);   // new files: a quiet look

    // ---------- sound: the folders "Sound" and "Music" inside the one folder. The first 6 tracks of "Sound" (by name) are
    // the slots the host plays (fanfare for a speaker, transitions); "Music" is the music the host chooses (coffee break …):
    // the host picks a track, it plays and goes on to the next. Volumes from the panel; while a slot plays the music waits.
    const AUD = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i, BGNAME = /^(music|музыка|background|bg|фон)/i;
    // "Sound/Game": own sounds for the game's prank instead of the ones the page makes — a name with error / crash / start in it
    const FXNAME = /^(game|prank|игра|розыгрыш)/i, FXKIND = { error: /error|ошибк|critical|stop|exclam/i, crash: /crash|bsod|blue|синий|сбой/i, start: /start|boot|logon|запуск|включ/i };
    let fxFiles = {}, hushed = false, fxEl = null;
    let sroot = null, sname = '', sscan = false, serr = '', sSig = '';
    let slots = [], bgList = [], cur = null, bgEl = null, bgIdx = 0, bgOn = false;
    const VOLK = 'tas3d-vol-' + C.room;
    let vj = 1, vb = 0.5, vx = 1;                       // tracks, music, and the videos from "Screen" (the host's Screen tab)
    try { const v = JSON.parse(localStorage.getItem(VOLK) || 'null'); if (v) { vj = +v.j; vb = +v.b; vx = v.x === undefined ? 1 : +v.x; } } catch (e) {}
    if (!(vj >= 0 && vj <= 1)) vj = 1; if (!(vb >= 0 && vb <= 1)) vb = 0.5; if (!(vx >= 0 && vx <= 1)) vx = 1;
    const volSave = () => { try { localStorage.setItem(VOLK, JSON.stringify({ j: vj, b: vb, x: vx })); } catch (e) {} };
    // the videos from the folder "Screen" play at the volume of the Screen tab; a speaker's video always plays at its full volume
    function setScrVol(x) {
      vx = x;
      if (shown && shown.k === 'vid' && shown.sp && shown.el) fadeV(shown);
      volSave(); pubAu();
    }
    const gain = (v) => v * v;                          // a slider feels even this way (ears hear the low end better)
    function soundRead() {                            // → {slots: [...], bg: [...]}: Sound/…, Music/… (or Sound/Music/…)
      const top = [], bg = [], fx = {};
      for (const f of sroot.files) {
        const parts = f.path.split('/'), nm = parts[parts.length - 1];
        if (!AUD.test(nm) || parts.some((q) => SKIP.test(q))) continue;
        const it = { name: nm, sig: f.sig, get: f.get };
        if (parts.length === 1) top.push(it); else if (parts.length === 2 && BGNAME.test(parts[0])) bg.push(it);
        else if (parts.length === 2 && FXNAME.test(parts[0])) { for (const k in FXKIND) if (!fx[k] && FXKIND[k].test(nm)) fx[k] = it; }
      }
      top.sort((a, b) => nat(a.name, b.name)); bg.sort((a, b) => nat(a.name, b.name));
      return { slots: top.slice(0, 6), bg, fx };
    }
    function soundScan() {
      if (!sroot) return;
      try {
        const r = soundRead(), sig = JSON.stringify([r.slots.map((x) => x.sig), r.bg.map((x) => x.sig), Object.keys(r.fx).map((k) => k + r.fx[k].sig)]);
        fxFiles = r.fx;
        if (sig !== sSig) {
          sSig = sig;
          r.slots.forEach((x, i) => { const o = slots[i]; x.dur = o && o.sig === x.sig ? o.dur : 0; });
          slots = r.slots; bgList = r.bg;
          if (bgIdx >= bgList.length) bgIdx = 0;
          for (const x of slots) if (!x.dur) audioLength(x).then((d) => { x.dur = d; pubAu(); }, () => {});
        }
        serr = '';
      } catch (e) { serr = 'The sound cannot be read now: ' + (e.message || e.name); }
      changed(); pubSa(); pubAu();
    }
    async function audioLength(x) {
      const a = new Audio(), url = URL.createObjectURL(await x.get());
      try { a.preload = 'metadata'; a.src = url; await once(a, 'loadedmetadata', 8000); return isFinite(a.duration) ? Math.round(a.duration) : 0; }
      finally { a.removeAttribute('src'); URL.revokeObjectURL(url); }
    }
    // No fades and no mixing: a sound starts and stops at once, and two never play together.
    //  - a new track stops the track before it;
    //  - while a track plays (or is being opened) the music waits, and goes on from the same place when the track is over;
    //  - while a video with sound plays on the screen the music waits too (a video without a sound track — a countdown —
    //    does not stop it);
    //  - another piece of music stops the one before it.
    // (Fades were also what went wrong when the window was behind another program: the browser stops drawing there,
    // the fade never finished, and the old sound kept playing under the new one.)
    function playAudio(a, fail) {
      const p = a.play();
      if (p && p.catch) p.catch((e) => {
        if (e && e.name === 'NotAllowedError') { soundBlocked = true; changed(); pubSa(); pubAu(); }
        if (fail) fail(e);
      });
    }
    let slotN = 0, slotOpening = false, bgN = 0;
    const bgLevel = () => gain(vb);
    // a video that sounds right now: on the screen, playing, not muted, and with a sound track in the file
    const hasAudio = (v) => !!(v.mozHasAudio || v.webkitAudioDecodedByteCount > 0 || (v.audioTracks && v.audioTracks.length));
    function vidSound() {
      const L = shown;
      if (!L || L.k !== 'vid' || !L.el || cfg.scene !== 'slides') return false;
      const v = L.el;
      return !v.paused && !v.ended && !v.muted && v.volume > 0 && hasAudio(v);   // turned down to zero: the music may play
    }
    const bgMay = () => bgOn && !cur && !slotOpening && !vidSound() && !hushed;   // hushed: the game's prank "restarts the computer"
    let bgWait = false;
    function bgApply() {                               // the music plays when it is on and nothing else sounds
      const a = bgEl, w = bgOn && !bgMay();
      if (w !== bgWait) { bgWait = w; pubAu(); }
      if (!a) return;
      a.volume = bgLevel();
      if (bgMay()) { if (a.paused && !a.ended) playAudio(a); }
      else if (!a.paused) a.pause();
    }
    function dropSlot() { const me = cur; cur = null; if (me) { try { me.a.pause(); } catch (e) {} URL.revokeObjectURL(me.url); } }
    function slotEl(me, from) {                        // the <audio> of a track (made again when the sound output is lost)
      const a = new Audio(me.url), x = slots[me.i];
      a.volume = gain(vj);
      a.addEventListener('ended', () => { if (cur === me && me.a === a) { dropSlot(); bgApply(); pubAu(); } });
      a.addEventListener('loadedmetadata', () => { if (x && isFinite(a.duration)) { x.dur = Math.round(a.duration); pubAu(); } if (from) { try { a.currentTime = from; } catch (e) {} } });
      me.a = a;
      playAudio(a, () => { if (cur === me && me.a === a && soundBlocked) { dropSlot(); bgApply(); pubAu(); } });   // no sound allowed yet: the music is not kept waiting
    }
    async function playSlot(i) {
      const x = slots[i]; if (!x) return;
      const n = ++slotN;
      dropSlot(); slotOpening = true; bgApply(); pubAu();
      let f = null; try { f = await x.get(); } catch (e) {}
      if (n !== slotN) return;                         // another track, or Stop, was pressed meanwhile: that one counts
      slotOpening = false;
      if (!f) { bgApply(); pubAu(); return; }
      const me = { a: null, i, url: URL.createObjectURL(f), at: Date.now() };
      cur = me; slotEl(me, 0);
      bgApply(); pubAu();
    }
    function stopSlot() { slotN++; slotOpening = false; dropSlot(); bgApply(); pubAu(); }
    function bgEl2(url, from) {                         // the <audio> of the music
      const a = new Audio(url);
      a.volume = bgLevel();
      a.addEventListener('ended', () => { if (bgEl === a) bgLoad(bgIdx + 1); });
      if (from) a.addEventListener('loadedmetadata', () => { try { a.currentTime = from; } catch (e) {} });
      bgEl = a; bgApply();
    }
    async function bgLoad(i) {
      if (!bgList.length) return;
      const n = ++bgN;
      if (bgEl) { const old = bgEl; bgEl = null; try { old.pause(); } catch (e) {} URL.revokeObjectURL(old.src); }
      bgIdx = ((i % bgList.length) + bgList.length) % bgList.length;
      pubAu();
      let f; try { f = await bgList[bgIdx].get(); } catch (e) { return; }
      if (n !== bgN) return;                           // another piece was chosen meanwhile
      bgEl2(URL.createObjectURL(f), 0);
      pubAu();
    }
    function bg(v, i) {
      if (v === 'play') { bgOn = true; if (!bgEl) bgLoad(bgIdx); else bgApply(); }
      else if (v === 'pause') { bgOn = false; bgApply(); }
      else if (v === 'next' || v === 'prev') bgLoad(bgIdx + (v === 'next' ? 1 : -1));
      else if (v === 'track' && Number.isInteger(i) && bgList[i]) { bgOn = true; bgLoad(i); }
      pubAu();
    }
    // A sound that should be playing but is not. Something outside the page can pause it (a play / pause key, headphones
    // taken off, the system), and when the sound output is switched (headphones ↔ speakers) the browser can lose the
    // sound altogether: the time of the track then stands still. Once a second: play again; if the time does not move,
    // open the sound again from the same place — that puts it on the output that is current now.
    function reopen(which) {
      if (which === 'bg' && bgEl) { const old = bgEl, at = old.currentTime || 0, url = old.src; bgEl = null; try { old.pause(); } catch (e) {} bgEl2(url, at); }
      if (which === 'slot' && cur) { const old = cur.a, at = old.currentTime || 0; try { old.pause(); } catch (e) {} slotEl(cur, at); }
    }
    function soundWatch() {
      if (soundBlocked) return;
      bgApply();                                       // a video's sound track shows only once it plays
      const want = [['slot', cur && cur.a, !!cur], ['bg', bgEl, bgMay()]];
      for (const [which, a, on] of want) {
        if (!a || !on || a.ended) continue;
        if (a.paused) { a.still = 0; playAudio(a); continue; }
        if (a.readyState < 2) continue;                // still opening
        a.still = a.lastT === a.currentTime ? (a.still || 0) + 1 : 0; a.lastT = a.currentTime;
        if (a.still >= 3) reopen(which);
      }
    }
    setInterval(soundWatch, 1000);
    try { navigator.mediaDevices.addEventListener('devicechange', () => { setTimeout(() => { if (cur) reopen('slot'); if (bgEl && bgMay()) reopen('bg'); }, 300); }); } catch (e) {}
    // the play / pause keys of the keyboard and of headphones do nothing to the screen: the host panel is in charge
    try { ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'].forEach((k) => { try { navigator.mediaSession.setActionHandler(k, () => {}); } catch (e) {} }); } catch (e) {}
    function sound(d) {
      if (d.a === 'play' && Number.isInteger(d.i)) playSlot(d.i);
      else if (d.a === 'stop') stopSlot();
      else if (d.a === 'bg') bg(String(d.v || ''), d.i);
      else if (d.a === 'vol') {
        if (typeof d.j === 'number' && d.j >= 0 && d.j <= 1) { vj = d.j; if (cur) cur.a.volume = gain(vj); }
        if (typeof d.b === 'number' && d.b >= 0 && d.b <= 1) { vb = d.b; if (bgEl) bgEl.volume = bgLevel(); }
        volSave();
        pubAu();
      }
    }
    // what the panel shows: tracks, what plays, volumes
    let auT = null;
    function pubAu() {
      clearTimeout(auT);
      auT = setTimeout(() => pub(B + '/au', {
        sn, seq: ++seq, t: Date.now(), f: sroot ? 1 : 0, folder: sname,
        slots: slots.map((x) => ({ n: x.name, d: x.dur || 0 })),
        bg: { n: bgList.length, list: bgList.slice(0, 200).map((x) => x.name), i: bgIdx, cur: bgList[bgIdx] ? bgList[bgIdx].name : '', on: bgOn ? 1 : 0, w: bgOn && !bgMay() ? 1 : 0 },
        pl: cur ? cur.i : -1, pe: cur ? Date.now() - cur.at : 0, vj, vb, vx, blk: soundBlocked ? 1 : 0
      }, true), 80);
    }
    setInterval(() => { if (cur || bgOn) pubAu(); }, 5000);
    setInterval(pubAu, 15000); setTimeout(pubAu, 2000);

    // ---------- PDF (pdf.js, loaded only when there is a PDF)
    let libP = null;
    function lib() {
      if (!libP) libP = import(PDFJS + 'pdf.min.js').then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; return m; });
      libP.catch(() => { libP = null; });
      return libP;
    }
    const docs = new Map();                            // file signature → {p: Promise<document>, used}
    function pdfDoc(f) {
      let x = docs.get(f.sig);
      if (!x) {
        x = { p: openPdf(f), used: 0 };
        docs.set(f.sig, x);
        x.p.catch(() => docs.delete(f.sig));
        trimDocs();
      }
      x.used = Date.now();
      clearTimeout(trimT); trimT = setTimeout(trimDocs, 30000);   // the ones opened only to count their pages are closed a little later
      return x.p;
    }
    async function openPdf(f) {
      const L = await lib(), file = await f.get();
      // read the file in pieces when pdf.js asks for them: big PDFs are not loaded into memory whole
      const tr = new L.PDFDataRangeTransport(file.size, null);
      tr.requestDataRange = (b, e) => { file.slice(b, e).arrayBuffer().then((buf) => tr.onDataRange(b, new Uint8Array(buf)), () => {}); };
      return L.getDocument({ range: tr, length: file.size, rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true,
        standardFontDataUrl: PDFJS + 'standard_fonts/', cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, wasmUrl: PDFJS + 'wasm/', iccUrl: PDFJS + 'iccs/' }).promise;
    }
    // close a PDF that is no longer needed (its memory and its worker's). pdf.js 6 has no document.destroy(): the loading
    // task closes it. (Until 27.11.2026 destroy() was called here — an error for every PDF past the eighth, and none closed.)
    function closeDoc(doc) {
      try {
        if (doc && doc.loadingTask && doc.loadingTask.destroy) return Promise.resolve(doc.loadingTask.destroy()).catch(() => {});
        if (doc && doc.destroy) return Promise.resolve(doc.destroy()).catch(() => {});
        if (doc && doc.cleanup) doc.cleanup();
      } catch (e) {}
    }
    // At most 8 PDFs stay open. Never closed: the files of the folder that is on the screen, a PDF a page is being drawn
    // from right now, and one used in the last 20 s (the screen is drawing previews of it for the remotes).
    let trimT = 0;
    function trimDocs() {
      if (docs.size <= 8) return;
      const keep = new Set(), d = byId[cfg.deck], now = Date.now();
      if (d) d.files.forEach((f) => keep.add(f.sig));
      const old = [...docs.entries()].filter(([k, x]) => !keep.has(k) && !x.busy && now - x.used > 20000).sort((a, b) => a[1].used - b[1].used);
      while (docs.size > 8 && old.length) { const [k, x] = old.shift(); docs.delete(k); x.p.then(closeDoc, () => {}); }
    }
    async function drawPdf(f, page, maxW, maxH, canvas) {
      const doc = await pdfDoc(f), x = docs.get(f.sig);
      if (x) x.busy = (x.busy || 0) + 1;               // not closed while a page of it is being drawn
      try { return await drawPage(doc, page, maxW, maxH, canvas); } finally { if (x) { x.busy--; x.used = Date.now(); } }
    }
    async function drawPage(doc, page, maxW, maxH, canvas) {
      const pg = await doc.getPage(page + 1);
      const v1 = pg.getViewport({ scale: 1 }), s = Math.min(maxW / v1.width, maxH / v1.height);
      const vp = pg.getViewport({ scale: s });
      canvas.width = Math.max(1, Math.round(vp.width)); canvas.height = Math.max(1, Math.round(vp.height));
      await pg.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pg.cleanup();
    }

    // ---------- previews for the remotes (small JPEGs)
    const TW = 512, TH = 320, thumbs = new Map(), thumbP = new Map();   // the host panel shows the current one as the screen preview
    // a video on the screen: one still taken from the playing video itself, once, shortly after it starts
    // ("it started, this is what the hall sees"); the remotes get no more pictures while it plays
    const snaps = new Map();
    let tq = Promise.resolve();
    function thumb(d, i) {
      if (!d || i < 0 || i >= d.total) return Promise.resolve('');
      const [fi, p] = d.items[i], f = d.files[fi], key = f.sig + '|' + p;
      if (snaps.has(key)) return Promise.resolve(snaps.get(key));   // a video caught on the screen as it started
      if (thumbs.has(key)) return Promise.resolve(thumbs.get(key));
      if (thumbP.has(key)) return thumbP.get(key);
      const job = tq.then(() => makeThumb(f, p)).then((u) => { thumbs.set(key, u); trim(thumbs, 400); return u; }, () => '');
      tq = job; thumbP.set(key, job); job.then(() => thumbP.delete(key));
      return job;
    }
    function trim(m, n) { while (m.size > n) m.delete(m.keys().next().value); }
    function fit(w, h, W, H) { const s = Math.min(W / w, H / h, 1); return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]; }
    async function makeThumb(f, p) {
      const c = document.createElement('canvas'), g = c.getContext('2d');
      if (f.k === 'pdf') { await drawPdf(f, p, TW, TH, c); }
      else if (f.k === 'img') {
        const url = URL.createObjectURL(await f.get());
        try { const im = new Image(); im.src = url; await im.decode(); [c.width, c.height] = fit(im.naturalWidth || TW, im.naturalHeight || TH, TW, TH); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height); }
        finally { URL.revokeObjectURL(url); }
      } else if (f.k === 'vid') {
        const v = document.createElement('video'), url = URL.createObjectURL(await f.get());
        try {
          v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
          await once(v, 'loadeddata', 10000);
          const t = Math.min(1, (v.duration || 2) / 10);
          if (t > 0.05) { v.currentTime = t; await once(v, 'seeked', 6000).catch(() => {}); }
          [c.width, c.height] = fit(v.videoWidth || TW, v.videoHeight || TH, TW, TH);
          g.drawImage(v, 0, 0, c.width, c.height);
        } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
      } else return '';
      return c.toDataURL('image/jpeg', 0.62);
    }
    function info(d, i) {
      if (!d || i < 0 || i >= d.total) return null;
      const [fi, p] = d.items[i], f = d.files[fi];
      return { f: fi, n: f.name, k: f.k, p, c: f.c, dur: f.dur ? Math.round(f.dur) : undefined, lp: loops(f) ? 1 : undefined };
    }
    // ---------- what the remotes get
    // pv/<folder>: where the folder is (slide number, file, video state, the confirmation of the last command) — small, sent at once.
    // px/<folder>/c and /n: the pictures of the current and the next slide — big, so they go apart: over their own
    // connections, one at a time, and only when the position has stayed for a moment. A slow upload of a picture never
    // holds back a position, and a picture that failed is sent again.
    const pvT = {};
    const at = (d) => Math.min(pos[d.id] || 0, Math.max(0, d.total - 1));
    function pubPv(d0) {
      const id = d0.id;
      clearTimeout(pvT[id]);
      pvT[id] = setTimeout(() => {
        const d = byId[id]; if (!d) return;          // the folder list may have been read again meanwhile
        const i = at(d);
        keep(B + '/pv/' + id, { sn, st: T0, seq: ++seq, t: Date.now(), pn: ver[id] || 0, i, total: d.total, it: info(d, i), nx: info(d, i + 1), v: videoState(d, i), ack: ack[id] || '' });
        pics(d, 300);
      }, 40);
    }
    let picWas = 0;
    const picLinks = TasLinks([], () => {}, () => {
      const u = picLinks ? picLinks.up() : 0;
      // a broker that restarted: the pictures of the folder on the screen go again (the others when a remote asks, see 'pix')
      if (u > picWas) setTimeout(() => { for (const k in picSent) delete picSent[k]; const d = byId[cfg.deck]; if (d && cfg.scene === 'slides') pics(d, 0); }, 600);
      picWas = u;
    });
    const picT = {}, picSent = {}, picWant = {}, picQ = [];
    let picBusy = false;
    function pics(d0, wait) {
      const id = d0.id;
      clearTimeout(picT[id]);
      picT[id] = setTimeout(async () => {
        const d = byId[id]; if (!d || !d.total) return;
        const i = at(d);
        const cur = await thumb(d, i), nxt = await thumb(d, i + 1);
        if (byId[id] !== d || at(d) !== i) return;     // moved again meanwhile: that move asks for its own pictures
        wantPic(id + '/c', { total: d.total, i, img: cur }, isOn(d));
        wantPic(id + '/n', { total: d.total, i: i + 1, img: i + 1 < d.total ? nxt : '' }, isOn(d));
        thumb(d, i + 2); if (i > 0) thumb(d, i - 1);
      }, wait);
    }
    const againAt = {};
    function picsAgain(d) {
      if (Date.now() - (againAt[d.id] || 0) < 2000) return;   // several remotes ask at once: one answer
      againAt[d.id] = Date.now();
      delete picSent[d.id + '/c']; delete picSent[d.id + '/n']; pics(d, 0);
    }
    function wantPic(k, o, first) {
      const s = picSent[k];
      if (s && s.total === o.total && s.i === o.i && s.img === o.img) { delete picWant[k]; return; }   // the brokers have exactly this
      picWant[k] = o;
      const q = picQ.indexOf(k); if (q >= 0) picQ.splice(q, 1);
      if (first) picQ.unshift(k); else picQ.push(k);   // the folder on the screen first
      picRun();
    }
    async function picRun() {
      if (picBusy) return;
      picBusy = true;
      while (picQ.length) {
        const k = picQ.shift(), o = picWant[k], t = B + '/px/' + k;
        if (!o) continue;
        try {
          await picLinks.pub(t, await seal(t, { sn, t: Date.now(), total: o.total, i: o.i, img: o.img }), { qos: 1, retain: true });
          picSent[k] = o; if (picWant[k] === o) delete picWant[k];
        } catch (e) {                                  // no connection, or too slow this time: again in a moment
          if (picWant[k] === o && picQ.indexOf(k) < 0) picQ.push(k);
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      picBusy = false;
    }

    // ---------- the slide on the screen
    let W = 0, H = 0;
    function measure() {
      const r = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.min(3840, Math.round(window.innerWidth * r)), h = Math.min(2160, Math.round(window.innerHeight * r));
      const ch = w !== W || h !== H; W = w; H = h; return ch;
    }
    measure();
    const layers = new Map();                          // ready slides: current, previous, next
    let shown = null, tok = 0;
    const errBox = document.createElement('div'); errBox.className = 'sl err'; view.appendChild(errBox);
    // only a PDF page is drawn for the window size; a picture or a video just stretches with the window, so full screen (F)
    // keeps the same video playing instead of loading it again from the start
    function keyOf(d, i) { const [fi, p] = d.items[i], f = d.files[fi]; return f.sig + '|' + p + (f.k === 'pdf' ? '|' + W + 'x' + H : ''); }
    function prepare(d, i) {
      const key = keyOf(d, i);
      let L = layers.get(key); if (L) return L;
      const [fi, p] = d.items[i], f = d.files[fi];
      L = { key, k: f.k, el: null, url: '' };
      L.p = (async () => {
        if (f.k === 'pdf') { const c = document.createElement('canvas'); await drawPdf(f, p, W, H, c); L.el = c; }
        else if (f.k === 'img') { L.url = URL.createObjectURL(await f.get()); const im = new Image(); im.src = L.url; await im.decode(); L.el = im; }
        else {
          L.url = URL.createObjectURL(await f.get());
          const v = document.createElement('video'); v.src = L.url; v.preload = 'auto'; v.playsInline = true;
          await once(v, 'loadeddata', 10000);
          ['play', 'pause', 'ended', 'volumechange'].forEach((ev) => v.addEventListener(ev, () => {
            if (ev === 'volumechange' && L.fading) return;      // the fade at the end changes the volume 25 times a second: nothing to tell
            const dd = byId[cfg.deck]; if (dd && shown === L) pubPv(dd); bgApply();
          }));
          v.addEventListener('playing', () => { setTimeout(bgApply, 250); setTimeout(() => { const dd = byId[cfg.deck]; if (dd && shown === L) pubPv(dd); }, 2200); });   // the music waits under a video with sound; "no sound track" is known after a moment
          // paused by something other than the host (the browser pauses a silent video when its window goes behind
          // another program; a play / pause key): it plays on
          v.addEventListener('pause', () => { if (L.want && shown === L && !v.ended) setTimeout(() => { if (L.want && shown === L && v.paused && !v.ended) playV(v, L.quiet); }, 120); });
          v.addEventListener('ended', () => { L.want = false; });
          L.lp = loops(f);
          v.addEventListener('playing', () => {
            if (shown !== L || L.snapped || L.snapT) return;
            L.snapT = setTimeout(() => { L.snapT = 0; snapV(L, f.sig + '|' + p); }, 400);
          });
          L.el = v;
        }
        L.el.className = 'sl';
        if (L.dead) { dropL(L); throw new Error('not needed any more'); }
        view.appendChild(L.el);
        return L;
      })();
      L.p.catch(() => dropL(L));
      layers.set(key, L);
      return L;
    }
    function dropL(L) {
      L.dead = true;
      if (layers.get(L.key) === L) layers.delete(L.key);
      L.want = false;
      if (L.el) { if (L.k === 'vid') { L.el.pause(); L.el.removeAttribute('src'); L.el.load(); } L.el.remove(); }
      if (L.url) URL.revokeObjectURL(L.url);
    }
    async function paint() {
      const d = byId[cfg.deck];
      if (cfg.scene !== 'slides' || !d || !d.total) return;
      const i = Math.min(pos[d.id] || 0, d.total - 1), t = ++tok;
      const L = prepare(d, i);
      let ok = true; try { await L.p; } catch (e) { ok = false; }
      if (t !== tok) return;
      if (shown && shown !== L && shown.el) { shown.el.classList.remove('on'); if (shown.k === 'vid') { shown.want = false; shown.el.pause(); } }
      errBox.classList.toggle('on', !ok);
      errBox.textContent = ok ? '' : 'This slide cannot be shown: ' + d.files[d.items[i][0]].name;
      const fresh = shown !== L || !!L.left;            // new on the screen, or back on it after something else was shown
      L.left = false;
      if (ok) {
        L.el.classList.add('on'); shown = L;
        if (L.k === 'vid') { L.quiet = false; L.el.loop = !!L.lp; }   // "loop" in the name: in a loop; every other video once (with its sound)
        if (L.k === 'vid') L.sp = !!d.sp;                 // "Screen": the volume of the Screen tab
        if (fresh && L.k === 'vid') { L.want = true; L.el.currentTime = 0; playV(L.el, L.quiet); }
        if (L.k === 'vid') { L.fk = -1; fadeV(L); }
      }
      else shown = null;
      const keep = new Set([keyOf(d, i)]);
      for (const j of [i - 1, i + 1, i + 2]) if (j >= 0 && j < d.total) keep.add(keyOf(d, j));
      [...layers.values()].forEach((x) => { if (!keep.has(x.key) && x !== shown) dropL(x); });
      if (i + 1 < d.total) prepare(d, i + 1);         // the next slides are ready before they are asked for
      setTimeout(() => { if (t !== tok) return; if (i + 2 < d.total) prepare(d, i + 2); if (i > 0) prepare(d, i - 1); }, 250);
    }
    // the end of a video that is not a loop: over the last FADE seconds the picture goes to black and the sound to silence,
    // following the video's own time (a pause holds it, "From the start" brings it back). Ended: black.
    function fadeV(L) {
      const v = L.el; if (!v || L.k !== 'vid') return;
      let k = 1;
      if (!L.lp) {
        const dur = v.duration, okd = isFinite(dur) && dur > 0, w = okd ? Math.min(FADE, dur / 2) : FADE;
        k = v.ended ? 0 : okd ? Math.max(0, Math.min(1, (dur - v.currentTime) / w)) : 1;
      }
      const base = L.sp ? gain(vx) : 1;                 // "Screen": the volume of the Screen tab; a speaker's video: full
      if (L.fk === k && L.fb === base) return;
      L.fk = k; L.fb = base;
      v.style.opacity = k === 1 ? '' : String(Math.round(k * 1000) / 1000);
      L.fading = k < 1;
      const vol = base * k; if (Math.abs(v.volume - vol) > 0.0005) v.volume = vol;
    }
    setInterval(() => { if (shown && shown.k === 'vid' && shown.el) fadeV(shown); }, 40);
    function playV(v, quiet) {
      v.muted = !!quiet || soundBlocked;               // sound is not allowed yet (see soundOn): silent at once
      const loud = !v.muted, p = v.play();
      if (p && p.catch) p.catch((e) => {
        if (e && e.name === 'NotAllowedError' && loud) { v.muted = true; soundBlocked = true; v.play().catch(() => {}); changed(); pubSa(); pubAu(); }
      });
    }
    // Sound needs one click or one key on this computer after the page is opened (a browser rule): until then a video
    // plays silent and the screen says so in big letters. The first click or key (F for full screen, the clicker) turns
    // the sound on, also for the video that is playing now. Chrome and Edge then keep the sound for every next video;
    // Safari asks for a click for each video, so there the same click is taken every time it comes.
    const CHROMIUM = /^(Chrome|Edge|Opera|Yandex) /.test(browserName());
    // May this page sound at all? Asked right when it opens, not when the first video or the game's first sound comes:
    // an AudioContext that the browser lets run means yes. So "Sound is off — click here once" is on the screen, and
    // "no sound" in the host panel, before the show and not in the middle of it. (A page opened by a click in the host
    // panel, or loaded again after a click, may sound although nobody has clicked on it: soundFree.)
    let soundFree = false;
    (function probe() {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return;
      let c = null; try { c = new A(); } catch (e) { return; }
      setTimeout(() => {
        const run = c.state === 'running', ua = navigator.userActivation;
        try { c.close(); } catch (e) {}
        if (run) { soundFree = true; return; }
        if (ua && ua.hasBeenActive) return;            // clicked meanwhile
        if (!soundBlocked) { soundBlocked = true; changed(); pubSa(); pubAu(); }
      }, 500);
    })();
    function soundOn() {
      const ua = navigator.userActivation;
      if (ua && !ua.hasBeenActive) return;             // a key that does not count for the browser (Esc, Shift …)
      const was = soundBlocked, L = shown;
      soundBlocked = false;
      if (L && L.k === 'vid' && !L.quiet && L.el && cfg.scene === 'slides') {
        if (L.el.muted) L.el.muted = false;
        if (L.want && L.el.paused && !L.el.ended) playV(L.el, false);
      }
      if (!was) return;
      bgApply();                                       // the background music that was asked for before the click
      changed(); pubSa(); pubAu(); const d = byId[cfg.deck]; if (d) pubPv(d);
    }
    ['pointerdown', 'mousedown', 'touchend', 'click'].forEach((ev) => document.addEventListener(ev, soundOn, true));
    document.addEventListener('keydown', () => setTimeout(soundOn, 0), true);
    // a click the page did not see itself (the browser's own "allow the folder" window): Chrome and Edge only, where one click counts for the whole page
    setInterval(() => { try { if (CHROMIUM && soundBlocked && navigator.userActivation && navigator.userActivation.hasBeenActive) soundOn(); } catch (e) {} }, 1000);
    // the still of a video that has just started on the screen (see snaps)
    function snapV(L, tk) {
      const v = L.el;
      if (L.dead || shown !== L || !v || v.readyState < 2 || !v.videoWidth) return;
      try {
        const c = document.createElement('canvas');
        [c.width, c.height] = fit(v.videoWidth, v.videoHeight, TW, TH);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        snaps.set(tk, c.toDataURL('image/jpeg', 0.62)); trim(snaps, 100);
        L.snapped = true;
        const d = byId[cfg.deck]; if (d) pics(d, 0);
      } catch (e) {}
    }
    function video(op) {
      if (!shown || shown.k !== 'vid') return;
      const v = shown.el;
      if (op === 'pause') { shown.want = false; v.pause(); }
      else { shown.want = true; if (op === 'restart' || v.ended) v.currentTime = 0; playV(v, shown.quiet); }
    }
    // The window of the screen behind another program: the browser pauses a video without sound there (a pause video, a
    // countdown) until the window is in front again. A video that is being read by the page is left playing, so one
    // dot of the playing video is read once a second; and a video that got paused anyway is started again.
    const kc = document.createElement('canvas'); kc.width = kc.height = 2;
    const kctx = kc.getContext('2d');
    setInterval(() => {
      const L = shown;
      if (!L || L.k !== 'vid' || !L.want || !L.el || cfg.scene !== 'slides') return;
      const v = L.el;
      if (v.ended) return;
      if (v.paused) playV(v, L.quiet);
      else if (v.readyState >= 2) { try { kctx.drawImage(v, 0, 0, 2, 2); } catch (e) {} }
    }, 1000);
    function videoState(d, i) {
      if (!isOn(d) || !shown || shown.k !== 'vid' || !d.total || shown.key !== keyOf(d, Math.min(i, d.total - 1))) return null;
      const v = shown.el;
      return { play: !v.paused && !v.ended ? 1 : 0, end: v.ended ? 1 : 0, mute: v.muted ? 1 : 0, na: !v.muted && v.currentTime > 1.5 && !hasAudio(v) ? 1 : 0 };
    }
    let rsT = null;
    window.addEventListener('resize', () => {
      clearTimeout(rsT);
      // a new window size (full screen on / off): only PDF pages are drawn again; the video on the screen goes on playing
      rsT = setTimeout(() => { if (measure()) { [...layers.values()].forEach((x) => { if (x !== shown && x.k === 'pdf') dropL(x); }); paint(); } }, 250);
    });

    return {
      connect: () => connect(false),
      choose: () => connect(true),
      drop,                                          // a folder dragged onto the screen
      adopt: () => adopt(false),                     // the folder chosen in the host panel of this same browser
      saInfo,                                        // the state for the host panel of this same browser (no server in between)
      unmute: () => soundOn(),
      // the game's prank: while the computer "restarts" and the blue screen is up, the music and the tracks wait
      hush(v) {
        v = !!v; if (v === hushed) return;
        hushed = v;
        if (v && (cur || slotOpening)) stopSlot();
        bgApply();
      },
      // the prank's sound from the folder "Sound/Game", if there is one for it: true = it plays (the page makes none then)
      gameSound(kind) {
        const x = gameFx[kind] || fxFiles[kind]; if (!x || soundBlocked) return false;   // "Game" folder first, then "Sound/Game"
        if (fxEl) { try { fxEl.pause(); } catch (e) {} URL.revokeObjectURL(fxEl.src); fxEl = null; }
        x.get().then((f) => { const a = new Audio(URL.createObjectURL(f)); a.volume = gain(vj); fxEl = a; playAudio(a); }, () => {});
        return true;
      },
      // the prank wants sound and nobody has clicked on this page yet: say so here and in the host panel
      wantSound() {
        const ua = navigator.userActivation;
        if (soundBlocked || soundFree || !ua || ua.hasBeenActive) return;
        soundBlocked = true; changed(); pubSa(); pubAu();
      },
      useHandle: (h) => useHandle(h, false),         // tests (headless Chrome here cannot keep a folder in IndexedDB)
      // what the screen shows (from the host's settings); called on every change
      setCfg(c) {
        const before = cfg.scene === 'slides' ? cfg.deck : '';
        cfg = { scene: c.scene, deck: c.deck || '', live: c.live || '' };
        const now = cfg.scene === 'slides' ? cfg.deck : '';
        view.hidden = !now || !byId[now] || !byId[now].total;
        if (now !== before) {
          // the slides left the screen (or another folder came): a video stops, and starts from the beginning when it is shown again
          if (shown) { shown.left = true; if (shown.k === 'vid') { shown.want = false; shown.el.pause(); } }
          if (now) { const d = byId[now]; if (d) { paint(); setTimeout(() => pubPv(d), 200); } }
          if (before && byId[before]) pubPv(byId[before]);
        }
      },
      has: (id) => !!(byId[id] && byId[id].total),
      // keys and the clicker on this computer
      step(n) { const d = byId[cfg.deck]; if (cfg.scene !== 'slides' || !d) return false; setPos(d, (pos[d.id] || 0) + n); pubPv(d); return true; },
      showing: () => cfg.scene === 'slides' && !!byId[cfg.deck],   // slides are on this screen now: the keys change them
      status: () => ({ need, folder: rootName, n: decks.length, scanning: reading, looked: lookedN, lookedLast, pdfs: docs.size, err, sound: !soundBlocked, kind: root ? root.kind : '',
        vid: !!(shown && shown.k === 'vid' && cfg.scene === 'slides' && shown.el && !shown.el.paused && !shown.el.ended),   // a video is playing on this screen
        sp: (decks.find((d) => d.sp) || { files: [] }).files.filter((f) => f.c).length,   // files for a pause (folder "Screen")
        qz: quiz.filter((q) => q.a).length,          // pictures of the quiz (folder "Quiz") with an answer in the name
        ho: decks.some((d) => d.ho) ? (decks.find((d) => d.ho).files.filter((f) => f.c).length) : -1,   // the host's own folder "Host": files in it, -1 = no folder
        snd: { on: !!sroot, folder: sname, slots: slots.length, bg: bgList.length, err: serr,
          playing: cur ? cur.i : -1, bgOn, bgCur: bgList[bgIdx] ? bgList[bgIdx].name : '', vj, vb, bgVol: bgEl ? bgEl.volume : 0,
          bgPlay: !!(bgEl && !bgEl.paused), hushed, vx, vidVol: shown && shown.k === 'vid' && shown.el ? shown.el.volume : -1, vidOp: shown && shown.k === 'vid' && shown.el ? +(shown.el.style.opacity || 1) : -1, vidLoop: !!(shown && shown.k === 'vid' && shown.el && shown.el.loop), fx: Object.keys(Object.assign({}, fxFiles, gameFx)) },
        gamePic: gamePic ? gamePic.name : '' }),
      gamePicUrl: () => (gamePic && gamePic.url) || '',
      // the quiz picture i as a URL the page can show (made once per file); its answer: 'r' render, 'p' photo
      quizUrl: async (i) => {
        const q = quiz[i]; if (!q) return '';
        if (!quizUrls.has(q.sig)) quizUrls.set(q.sig, URL.createObjectURL(await q.get()));
        return quizUrls.get(q.sig);
      },
      quizAns: (i) => (quiz[i] ? quiz[i].a : ''),
      // the folders, for the list in this computer's Settings (showing one works without the internet)
      list: () => decks.map((d) => ({ id: d.id, name: d.name, total: d.total, sp: !!d.sp, ho: !!d.ho })),
      _decks: () => decks
    };
  };
})();

// TAS3D 2026 — presentations on the projector screen (screen/ only; needs config.js, mqtt.js, deck.js).
// The host chooses the folder "TAS3D 2026 Presentations" on this computer once (Connect folder): one subfolder per speaker.
// PDF pages, pictures and videos are shown full screen, in the order of the file names; PowerPoint / Keynote files are
// listed with a note to save them as PDF. Nothing is uploaded: the files stay here. The speakers' page and the host panel
// get small encrypted previews (current and next slide) and send encrypted commands (next, previous, show on the screen ...).
// Chrome and Edge remember the folder (the browser asks again once after a restart: Reconnect folder); other browsers choose it each time.
(function () {
  const C = window.TAS3D_CHECKIN, B = C.base;
  const PDFJS = new URL("../assets/pdfjs-6.2.108/", document.baseURI).href;
  const PDF = /\.pdf$/i, IMG = /\.(jpe?g|png|webp|gif|avif|bmp|svg)$/i, VID = /\.(mp4|m4v|webm|mov|ogv)$/i;
  // not listed at all: hidden and system files, notes, unfinished downloads
  const SKIP = /^\.|^~\$|^(desktop\.ini|thumbs\.db|icon\r?)$|\.(txt|md|rtf|url|webloc|lnk|ini|db|tmp|part|crdownload|download)$/i;
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
  function warnFor(n) {
    if (/\.(pptx?|ppsx?|pptm|potx?|odp)$/i.test(n)) return 'PowerPoint file: the browser cannot show it. Save it as PDF (File → Export → PDF) into this folder; put videos here as separate MP4 files.';
    if (/\.key$/i.test(n)) return 'Keynote file: export it as PDF (File → Export To → PDF) into this folder; put videos here as separate MP4 files.';
    if (/\.(heic|heif)$/i.test(n)) return 'HEIC photo: save it as JPG or PNG.';
    if (/\.(avi|wmv|mkv|flv|mpe?g|3gp)$/i.test(n)) return 'This video format does not play in the browser. Save it as MP4 (H.264).';
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
    let seq = 0;
    let root = null;                        // {kind: 'handle', h} | {kind: 'files', top}
    let saved = null, rootName = '', need = 'connect', scanning = false, err = '';
    let decks = [], byId = {}, sigAll = '';
    let cfg = { scene: '', deck: '', live: '' };
    let soundBlocked = false;
    const POSK = 'tas3d-slidepos-' + C.room, ack = {};
    let pos = {}; try { pos = JSON.parse(localStorage.getItem(POSK) || '{}') || {}; } catch (e) {}
    const savePos = () => { try { localStorage.setItem(POSK, JSON.stringify(pos)); } catch (e) {} };
    const changed = () => { try { opt.onChange && opt.onChange(); } catch (e) {} };

    // ---------- the brokers
    let was = 0;
    const links = TasLinks([B + '/sk'], onMsg, () => {
      const u = links ? links.up() : 0;
      if (u > was) setTimeout(() => { pubSa(); if (decks.length) { pubDk(); decks.forEach(pubPv); } }, 400);   // a broker that restarted gets everything again
      was = u;
    });
    const seal = (t, o) => box.seal(t, o);
    async function pub(t, o, retain) { try { await links.pub(t, await seal(t, o), { qos: 1, retain: !!retain }); } catch (e) {} }
    function pubSa() {
      pub(B + '/sa', { sn, seq: ++seq, t: Date.now(), f: !!root && !need && !scanning ? 1 : 0, need: scanning ? 'reading' : need, folder: rootName, n: decks.length, snd: soundBlocked ? 0 : 1, au: sroot ? 1 : 0 });
    }
    setInterval(pubSa, 8000); setTimeout(pubSa, 1500);
    // closing or reloading this page: "bye" (sealed in advance, so it goes out at once) — the remotes forget this screen
    let byeText = '';
    box.seal(B + '/sa', { sn, bye: 1, t: Date.now() }).then((x) => { byeText = x; });
    window.addEventListener('pagehide', () => { if (byeText) try { links.pub(B + '/sa', byeText, {}).catch(() => {}); } catch (e) {} });
    let helloAt = 0;
    function pubDk() {
      pub(B + '/dk', { sn, seq: ++seq, t: Date.now(), folder: rootName, quiz: quiz.length ? quiz.map((q) => ({ n: q.n, a: q.a })) : undefined, decks: decks.map((d) => ({
        id: d.id, name: d.name, total: d.total, sp: d.sp ? 1 : undefined, ho: d.ho ? 1 : undefined,
        files: d.files.map((f) => ({ n: f.name, k: f.k, c: f.c, from: f.from, dur: f.dur ? Math.round(f.dur) : undefined, w: f.w || undefined }))
      })) }, true);
    }
    setInterval(() => { if (decks.length) pubDk(); }, 60000);

    // ---------- commands from the remotes
    const seen = new Set(), seenQ = [];
    async function onMsg(t, x) {
      if (t !== B + '/sk' || !x) return;
      const d = await box.open(t, x);
      if (!d || typeof d.n !== 'string' || d.n.length > 40 || seen.has(d.n)) return;   // the same command comes through both brokers
      seen.add(d.n); seenQ.push(d.n); if (seenQ.length > 3000) seen.delete(seenQ.shift());
      if (d.op === 'hello') { if (Date.now() - helloAt > 1000) { helloAt = Date.now(); pubSa(); pubAu(); } return; }
      if (d.op === 'snd') {                            // sound: the host only
        if (d.from === 'host' && (Array.isArray(d.sn) ? d.sn.indexOf(sn) >= 0 : d.sn === sn)) sound(d);
        return;
      }
      if (!(Array.isArray(d.sn) ? d.sn.indexOf(sn) >= 0 : d.sn === sn)) return;   // for this screen (and this session) only
      const dk = byId[d.d]; if (!dk) return;
      if ((dk.sp || dk.ho) && d.from !== 'host') return;   // the pause pictures and the host's own folder: the host only
      const i = pos[dk.id] || 0, on = isOn(dk);
      // the host controls everything; a speaker controls the screen only after the host's Start (cfg.live),
      // and before that may only look through their own slides while they are not on the screen
      const boss = d.from === 'host' || cfg.live === dk.id;
      if (!boss && (on || /^(show|hide|play|pause|restart)$/.test(d.op))) return;
      if (d.from !== 'host' && /^(show|hide)$/.test(d.op) && opt.locked && opt.locked()) return;   // the opening game is on the screen
      switch (d.op) {
        case 'next': setPos(dk, i + 1); break;
        case 'prev': setPos(dk, i - 1); break;
        case 'go': if (Number.isInteger(d.i)) setPos(dk, d.i); break;
        case 'file': if (Number.isInteger(d.f) && dk.files[d.f] && dk.files[d.f].c) setPos(dk, dk.files[d.f].from); break;
        case 'show':
          if (Number.isInteger(d.f) && dk.files[d.f] && dk.files[d.f].c) setPos(dk, dk.files[d.f].from);
          if (!on) hub.setCfg({ scene: 'slides', deck: dk.id });
          break;
        case 'hide': if (on) hub.setCfg({ scene: 'logo' }); break;
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
      pos[d.id] = i; savePos();
      if (isOn(d)) paint();
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
        scanning = true; changed();
        const list = [];
        await readEntries(en, en.name + '/', list, 0);
        scanning = false;
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
        if (rest.length > 1 && !SKIP.test(rest[0]) && !dirs.has(rest[0])) { const d = { name: rest[0], files: [] }; dirs.set(rest[0], d); top.dirs.push(d); }   // a speaker's folder with only a note in it is still listed
        if (rest.some((p) => SKIP.test(p)) || rest.length > 4) continue;
        const ent = { path: rest.slice(rest.length > 1 ? 1 : 0).join('/'), sig: rest.join('/') + '|' + f.size + '|' + f.lastModified, get: () => Promise.resolve(f) };
        if (rest.length === 1) top.files.push(ent);
        else { let d = dirs.get(rest[0]); if (!d) { d = { name: rest[0], files: [] }; dirs.set(rest[0], d); top.dirs.push(d); } d.files.push(ent); }
      }
      return top;
    }
    async function walk(dir, prefix, deckName, depth, out) {
      for await (const e of dir.values()) {
        if (SKIP.test(e.name)) continue;
        if (e.kind === 'directory') { if (depth < 3) await walk(e, prefix + e.name + '/', deckName, depth + 1, out); continue; }
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
        if (e.kind === 'directory') top.dirs.push({ name: e.name, files: await walk(e, '', e.name, 1, []) });
        else { let f; try { f = await e.getFile(); } catch (x) { continue; } top.files.push({ path: e.name, sig: '/' + e.name + '|' + f.size + '|' + f.lastModified, get: () => e.getFile() }); }
      }
      return top;
    }

    // what is in each file (kept by file signature, so a new scan does not open everything again)
    const meta = new Map();
    async function inspect(f) {
      if (meta.has(f.sig)) return meta.get(f.sig);
      const n = f.path.split('/').pop();
      let m = { k: 'bad', c: 0, dur: 0, w: '' };
      if (PDF.test(n)) { try { m = { k: 'pdf', c: (await pdfDoc(f)).numPages, dur: 0, w: '' }; } catch (e) { m.w = 'This PDF does not open. Export it again from PowerPoint or Keynote.'; } }
      else if (IMG.test(n)) m = { k: 'img', c: 1, dur: 0, w: '' };
      else if (VID.test(n)) { try { m = { k: 'vid', c: 1, dur: await videoLength(f), w: '' }; } catch (e) { m.w = 'This video does not play in the browser. Save it as MP4 (H.264).'; } }
      else m.w = warnFor(n);
      meta.set(f.sig, m);
      return m;
    }
    async function videoLength(f) {
      const v = document.createElement('video'), url = URL.createObjectURL(await f.get());
      try {
        v.muted = true; v.preload = 'metadata'; v.src = url;
        await once(v, 'loadedmetadata', 10000);
        if (!v.videoWidth) throw new Error('no picture');
        return isFinite(v.duration) ? v.duration : 0;
      } finally { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); }
    }
    async function buildDeck(folder, files) {
      files.sort((a, b) => nat(a.path, b.path));
      const nm = (folder || '').normalize('NFC');      // one form of letters (Mac gives decomposed ones, e.g. й)
      const d = { id: await shortId(folder || rootName), name: nm ? (nm.replace(/^\d+[\s._\-–—]*/, '') || nm) : rootName.normalize('NFC'), files: [], items: [], total: 0 };
      for (const f of files) {
        const m = await inspect(f);
        const e = { name: f.path.normalize('NFC'), k: m.k, c: m.c, dur: m.dur, w: m.w, sig: f.sig, get: f.get, from: d.items.length };
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
    const quizUrls = new Map();
    function quizAnswer(name) {
      const n = name.replace(/\.[a-z0-9]+$/i, '').toLowerCase(), r = /render|рендер|(^|[^a-z])cg/.test(n), p = /photo|foto|фото|real/.test(n);
      return r && !p ? 'r' : p && !r ? 'p' : '';
    }
    async function scan() {
      if (!root || scanning) return;
      scanning = true; changed(); pubSa();
      try {
        const top = await readTree();
        top.dirs.sort((a, b) => nat(a.name, b.name));
        // inside the one folder: "Sound" = the 6 tracks (speakers coming out, transitions), "Music" = background music,
        // "Screen" = the pictures / videos for a pause. None of them is a speaker.
        const sdir = top.dirs.find((x) => SNDNAME.test(bare(x.name))), mdir = top.dirs.find((x) => MUSNAME.test(bare(x.name)));
        let qchg = false;
        const qdir = top.dirs.find((x) => QUIZNAME.test(bare(x.name)));
        top.dirs = top.dirs.filter((x) => x !== sdir && x !== mdir && x !== qdir);
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
        } else if (sroot) { sroot = null; sname = ''; slots = []; bgList = []; sSig = ''; stopSlot(0); pubAu(); }
        const sig = JSON.stringify([top.name, top.dirs.map((x) => [x.name, x.files.map((f) => f.sig)]), top.files.map((f) => f.sig)]);
        if (sig !== sigAll) {
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
      scanning = false; changed(); pubSa();
    }
    // new files appear by themselves (a folder chosen with Connect folder in Chrome or Edge)
    setInterval(() => { if (root && root.kind === 'handle' && !need) scan(); }, 15000);

    // ---------- sound: the folders "Sound" and "Music" inside the one folder. The first 6 tracks of "Sound" (by name) are
    // the slots the host plays (fanfare for a speaker, transitions); "Music" is the music the host chooses (coffee break …):
    // the host picks a track, it plays and goes on to the next. Volumes from the panel; a slot playing turns the music down.
    const AUD = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i, BGNAME = /^(music|музыка|background|bg|фон)/i;
    let sroot = null, sname = '', sscan = false, serr = '', sSig = '';
    let slots = [], bgList = [], cur = null, bgEl = null, bgIdx = 0, bgOn = false, ducked = false, rampT = null;
    const VOLK = 'tas3d-vol-' + C.room;
    let vj = 1, vb = 0.5;
    try { const v = JSON.parse(localStorage.getItem(VOLK) || 'null'); if (v) { vj = +v.j; vb = +v.b; } } catch (e) {}
    if (!(vj >= 0 && vj <= 1)) vj = 1; if (!(vb >= 0 && vb <= 1)) vb = 0.5;
    const gain = (v) => v * v;                          // a slider feels even this way (ears hear the low end better)
    function soundRead() {                            // → {slots: [...], bg: [...]}: Sound/…, Music/… (or Sound/Music/…)
      const top = [], bg = [];
      for (const f of sroot.files) {
        const parts = f.path.split('/'), nm = parts[parts.length - 1];
        if (!AUD.test(nm) || parts.some((q) => SKIP.test(q))) continue;
        const it = { name: nm, sig: f.sig, get: f.get };
        if (parts.length === 1) top.push(it); else if (parts.length === 2 && BGNAME.test(parts[0])) bg.push(it);
      }
      top.sort((a, b) => nat(a.name, b.name)); bg.sort((a, b) => nat(a.name, b.name));
      return { slots: top.slice(0, 6), bg };
    }
    function soundScan() {
      if (!sroot) return;
      try {
        const r = soundRead(), sig = JSON.stringify([r.slots.map((x) => x.sig), r.bg.map((x) => x.sig)]);
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
    function playAudio(a) {
      const p = a.play();
      if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotAllowedError') { soundBlocked = true; changed(); pubSa(); pubAu(); } });
    }
    function ramp(el, to, ms, done) {                  // smooth volume changes (no clicks)
      if (!el) return done && done();
      const from = el.volume, t0 = performance.now();
      const step = () => { const k = Math.min(1, (performance.now() - t0) / ms); el.volume = Math.max(0, Math.min(1, from + (to - from) * k)); if (k < 1) requestAnimationFrame(step); else if (done) done(); };
      requestAnimationFrame(step);
    }
    function bgLevel() { return gain(vb) * (ducked ? 0.25 : 1); }
    function duck(on) { ducked = on; if (bgEl) ramp(bgEl, bgLevel(), on ? 400 : 1200); }
    async function playSlot(i) {
      const x = slots[i]; if (!x) return;
      stopSlot(120);
      let f; try { f = await x.get(); } catch (e) { return; }
      const url = URL.createObjectURL(f), a = new Audio(url);
      a.volume = gain(vj);
      const me = { a, i, url, at: Date.now() };
      cur = me;
      a.addEventListener('ended', () => { if (cur === me) { cur = null; duck(false); pubAu(); } URL.revokeObjectURL(url); });
      a.addEventListener('loadedmetadata', () => { if (isFinite(a.duration)) { x.dur = Math.round(a.duration); pubAu(); } });
      playAudio(a); duck(true); pubAu();
    }
    function stopSlot(ms) {
      const me = cur; if (!me) return;
      cur = null;
      ramp(me.a, 0, ms || 500, () => { me.a.pause(); URL.revokeObjectURL(me.url); });
      duck(false); pubAu();
    }
    async function bgLoad(i, play) {
      if (!bgList.length) return;
      if (bgEl) { const old = bgEl; bgEl = null; ramp(old, 0, 400, () => { old.pause(); URL.revokeObjectURL(old.src); }); }
      bgIdx = ((i % bgList.length) + bgList.length) % bgList.length;
      let f; try { f = await bgList[bgIdx].get(); } catch (e) { return; }
      const a = new Audio(URL.createObjectURL(f));
      a.volume = 0; bgEl = a;
      a.addEventListener('ended', () => { if (bgEl === a) bgLoad(bgIdx + 1, bgOn); });
      if (play) { playAudio(a); ramp(a, bgLevel(), 800); }
      pubAu();
    }
    function bg(v, i) {
      if (v === 'play') { bgOn = true; if (!bgEl) bgLoad(bgIdx, true); else { playAudio(bgEl); ramp(bgEl, bgLevel(), 800); } }
      else if (v === 'pause') { bgOn = false; const el = bgEl; if (el) ramp(el, 0, 700, () => { if (!bgOn) el.pause(); }); }
      else if (v === 'next' || v === 'prev') bgLoad(bgIdx + (v === 'next' ? 1 : -1), bgOn);
      else if (v === 'track' && Number.isInteger(i) && bgList[i]) { bgOn = true; bgLoad(i, true); }
      pubAu();
    }
    function sound(d) {
      if (d.a === 'play' && Number.isInteger(d.i)) playSlot(d.i);
      else if (d.a === 'stop') stopSlot(500);
      else if (d.a === 'bg') bg(String(d.v || ''), d.i);
      else if (d.a === 'vol') {
        if (typeof d.j === 'number' && d.j >= 0 && d.j <= 1) { vj = d.j; if (cur) cur.a.volume = gain(vj); }
        if (typeof d.b === 'number' && d.b >= 0 && d.b <= 1) { vb = d.b; if (bgEl && bgOn) bgEl.volume = bgLevel(); }
        try { localStorage.setItem(VOLK, JSON.stringify({ j: vj, b: vb })); } catch (e) {}
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
        bg: { n: bgList.length, list: bgList.slice(0, 200).map((x) => x.name), i: bgIdx, cur: bgList[bgIdx] ? bgList[bgIdx].name : '', on: bgOn ? 1 : 0 },
        pl: cur ? cur.i : -1, pe: cur ? Date.now() - cur.at : 0, vj, vb, blk: soundBlocked ? 1 : 0
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
    function trimDocs() {
      if (docs.size <= 8) return;
      const keep = new Set(), d = byId[cfg.deck];
      if (d) d.files.forEach((f) => keep.add(f.sig));
      const old = [...docs.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].used - b[1].used);
      while (docs.size > 8 && old.length) { const [k, x] = old.shift(); docs.delete(k); x.p.then((doc) => doc.destroy(), () => {}); }
    }
    async function drawPdf(f, page, maxW, maxH, canvas) {
      const doc = await pdfDoc(f), pg = await doc.getPage(page + 1);
      const v1 = pg.getViewport({ scale: 1 }), s = Math.min(maxW / v1.width, maxH / v1.height);
      const vp = pg.getViewport({ scale: s });
      canvas.width = Math.max(1, Math.round(vp.width)); canvas.height = Math.max(1, Math.round(vp.height));
      await pg.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pg.cleanup();
    }

    // ---------- previews for the remotes (small JPEGs)
    const TW = 512, TH = 320, thumbs = new Map(), thumbP = new Map();   // the host panel shows the current one as the screen preview
    let tq = Promise.resolve();
    function thumb(d, i) {
      if (!d || i < 0 || i >= d.total) return Promise.resolve('');
      const [fi, p] = d.items[i], f = d.files[fi], key = f.sig + '|' + p;
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
      return { f: fi, n: f.name, k: f.k, p, c: f.c, dur: f.dur ? Math.round(f.dur) : undefined };
    }
    const pvT = {};
    function pubPv(d0) {
      const id = d0.id;
      clearTimeout(pvT[id]);
      pvT[id] = setTimeout(async () => {
        const d = byId[id]; if (!d) return;          // the folder list may have been read again meanwhile
        const i = Math.min(pos[id] || 0, Math.max(0, d.total - 1));
        const cur = await thumb(d, i), nxt = await thumb(d, i + 1);
        if (byId[id] !== d || (d.total && (pos[id] || 0) !== i)) return;   // moved again meanwhile: that move publishes
        pub(B + '/pv/' + id, { sn, seq: ++seq, t: Date.now(), i, total: d.total, it: info(d, i), nx: info(d, i + 1), cur, nxt, v: videoState(d, i), ack: ack[id] || '' }, true);
        thumb(d, i + 2); if (i > 0) thumb(d, i - 1);
      }, 40);
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
    function keyOf(d, i) { const [fi, p] = d.items[i]; return d.files[fi].sig + '|' + p + '|' + W + 'x' + H; }
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
          ['play', 'pause', 'ended', 'volumechange'].forEach((ev) => v.addEventListener(ev, () => { const dd = byId[cfg.deck]; if (dd && shown === L) pubPv(dd); }));
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
      if (shown && shown !== L && shown.el) { shown.el.classList.remove('on'); if (shown.k === 'vid') shown.el.pause(); }
      errBox.classList.toggle('on', !ok);
      errBox.textContent = ok ? '' : 'This slide cannot be shown: ' + d.files[d.items[i][0]].name;
      const fresh = shown !== L;
      if (ok) {
        L.el.classList.add('on'); shown = L;
        if (L.k === 'vid') { L.quiet = !!d.sp; L.el.loop = !!d.sp; }   // a pause video: in a loop and silent (the music is the host's Music)
        if (fresh && L.k === 'vid') { L.el.currentTime = 0; playV(L.el, L.quiet); }
      }
      else shown = null;
      const keep = new Set([keyOf(d, i)]);
      for (const j of [i - 1, i + 1, i + 2]) if (j >= 0 && j < d.total) keep.add(keyOf(d, j));
      [...layers.values()].forEach((x) => { if (!keep.has(x.key) && x !== shown) dropL(x); });
      if (i + 1 < d.total) prepare(d, i + 1);         // the next slides are ready before they are asked for
      setTimeout(() => { if (t !== tok) return; if (i + 2 < d.total) prepare(d, i + 2); if (i > 0) prepare(d, i - 1); }, 250);
    }
    function playV(v, quiet) {
      v.muted = !!quiet;
      const p = v.play();
      if (p && p.catch) p.catch((e) => {
        if (e && e.name === 'NotAllowedError' && !quiet) { v.muted = true; soundBlocked = true; v.play().catch(() => {}); changed(); pubSa(); }
      });
    }
    // sound needs one click on this computer (browser rule): the first click turns it on
    document.addEventListener('pointerdown', () => {
      if (!soundBlocked) return;
      soundBlocked = false;
      if (shown && shown.k === 'vid' && !shown.quiet) { shown.el.muted = false; }
      if (bgOn && bgEl) playAudio(bgEl);               // the background music that was asked for before the click
      changed(); pubSa(); pubAu();
    });
    function video(op) {
      if (!shown || shown.k !== 'vid') return;
      const v = shown.el;
      if (op === 'pause') v.pause();
      else { if (op === 'restart' || v.ended) v.currentTime = 0; playV(v, shown.quiet); }
    }
    function videoState(d, i) {
      if (!isOn(d) || !shown || shown.k !== 'vid' || !d.total || shown.key !== keyOf(d, Math.min(i, d.total - 1))) return null;
      const v = shown.el;
      return { play: !v.paused && !v.ended ? 1 : 0, end: v.ended ? 1 : 0, mute: v.muted ? 1 : 0 };
    }
    let rsT = null;
    window.addEventListener('resize', () => {
      clearTimeout(rsT);
      rsT = setTimeout(() => { if (measure()) { [...layers.values()].forEach((x) => { if (x !== shown) dropL(x); }); paint(); } }, 250);
    });

    return {
      connect: () => connect(false),
      choose: () => connect(true),
      drop,                                          // a folder dragged onto the screen
      unmute() { if (soundBlocked) { soundBlocked = false; if (shown && shown.k === 'vid' && !shown.quiet) shown.el.muted = false; if (bgOn && bgEl) playAudio(bgEl); changed(); pubSa(); pubAu(); } },
      useHandle: (h) => useHandle(h, false),         // tests (headless Chrome here cannot keep a folder in IndexedDB)
      // what the screen shows (from the host's settings); called on every change
      setCfg(c) {
        const before = cfg.scene === 'slides' ? cfg.deck : '';
        cfg = { scene: c.scene, deck: c.deck || '', live: c.live || '' };
        const now = cfg.scene === 'slides' ? cfg.deck : '';
        view.hidden = !now || !byId[now] || !byId[now].total;
        if (!now) { if (shown && shown.k === 'vid') shown.el.pause(); }
        if (now !== before) {
          if (now) { const d = byId[now]; if (d) { paint(); setTimeout(() => pubPv(d), 200); } }
          if (before && byId[before]) { if (shown && shown.k === 'vid') shown.el.pause(); pubPv(byId[before]); }
        }
      },
      has: (id) => !!(byId[id] && byId[id].total),
      // keys and the clicker on this computer
      step(n) { const d = byId[cfg.deck]; if (cfg.scene !== 'slides' || !d) return false; setPos(d, (pos[d.id] || 0) + n); pubPv(d); return true; },
      status: () => ({ need, folder: rootName, n: decks.length, scanning, err, sound: !soundBlocked, kind: root ? root.kind : '',
        sp: (decks.find((d) => d.sp) || { files: [] }).files.filter((f) => f.c).length,   // files for a pause (folder "Screen")
        qz: quiz.filter((q) => q.a).length,          // pictures of the quiz (folder "Quiz") with an answer in the name
        ho: decks.some((d) => d.ho) ? (decks.find((d) => d.ho).files.filter((f) => f.c).length) : -1,   // the host's own folder "Host": files in it, -1 = no folder
        snd: { on: !!sroot, folder: sname, slots: slots.length, bg: bgList.length, err: serr,
          playing: cur ? cur.i : -1, bgOn, bgCur: bgList[bgIdx] ? bgList[bgIdx].name : '', vj, vb, bgVol: bgEl ? bgEl.volume : 0 } }),
      // the quiz picture i as a URL the page can show (made once per file); its answer: 'r' render, 'p' photo
      quizUrl: async (i) => {
        const q = quiz[i]; if (!q) return '';
        if (!quizUrls.has(q.sig)) quizUrls.set(q.sig, URL.createObjectURL(await q.get()));
        return quizUrls.get(q.sig);
      },
      quizAns: (i) => (quiz[i] ? quiz[i].a : ''),
      _decks: () => decks
    };
  };
})();

// TAS3D 2026 — presentations: the slides key, encrypted messages, and the remote for the slides
// (speakers/ — one speaker's folder; host/ — every folder). The screen side is slides.js.
// The files stay on the computer at the projector; only small previews and commands go through the public brokers,
// and those are encrypted (AES-GCM) with the slides key, so nobody without a password can see or control the slides.
// Needs config.js and mqtt.js. Written for old phone browsers too (no arrow functions, no async).
(function () {
  var C = window.TAS3D_CHECKIN, B = C.base, Z = C.slides;
  var enc = new TextEncoder(), dec = new TextDecoder();
  function hex(u) { u = new Uint8Array(u); var s = ''; for (var i = 0; i < u.length; i++) s += ('0' + u[i].toString(16)).slice(-2); return s; }
  function unhex(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function b64(u) { var s = ''; for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function json(x) { try { return JSON.parse(x); } catch (e) { return null; } }
  function derive(pass, salt) {
    return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: Z.iterations }, k, 256);
    }).then(function (b) { return new Uint8Array(b); });
  }
  function aes(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  function unseal(raw, h) {
    var all = unhex(h);
    return aes(raw).then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, k, all.subarray(12)); })
      .then(function (b) { return new Uint8Array(b); });
  }

  // ---------- the slides key on this device
  var SK = 'tas3d-spk-' + C.room, HK = 'tas3d-host-' + C.room, DAYS90 = 90 * 864e5, KEYRE = /^[0-9a-f]{64}$/;
  function read(k) { try { return json(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  window.TasSlidesKey = {
    // from the speakers' login, or from the host's login on this device (the host password opens the slides too)
    get: function () {
      var h = read(HK), s = read(SK), now = Date.now();
      if (h && h.h === C.host.hash && h.until > now && KEYRE.test(h.k || '')) return h.k;
      if (s && s.until > now && KEYRE.test(s.k || '')) return s.k;
      return null;
    },
    speakerLogin: function () { var s = read(SK); return !!(s && s.until > Date.now() && KEYRE.test(s.k || '')); },
    // the speakers' password → true/false; a right one is kept on this device for 90 days
    speakers: function (pass) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This browser cannot check the password here.'));
      return derive(pass, Z.ssalt).then(function (K) {
        return unseal(K, Z.check).then(function (t) {
          if (dec.decode(t) !== 'tas3d-slides') return false;
          try { localStorage.setItem(SK, JSON.stringify({ k: hex(K), until: Date.now() + DAYS90 })); } catch (e) {}
          return true;
        }, function () { return false; });
      });
    },
    keepSpeakers: function () { var s = read(SK); if (s && KEYRE.test(s.k || '')) { s.until = Date.now() + DAYS90; try { localStorage.setItem(SK, JSON.stringify(s)); } catch (e) {} } },
    logoutSpeakers: function () { try { localStorage.removeItem(SK); } catch (e) {} },
    // the host password → the slides key (hex); called by TasAuth in hub.js
    fromHost: function (pass) { return derive(pass, Z.hsalt).then(function (H) { return unseal(H, Z.wrap); }).then(hex); }
  };

  // ---------- encrypted messages: "e1." + base64(iv + AES-GCM(json)); the topic is bound in, so a message cannot be moved to another topic
  window.TasBox = function (keyHex) {
    var kp = aes(unhex(keyHex));
    return {
      seal: function (topic, obj) {
        var iv = crypto.getRandomValues(new Uint8Array(12));
        return kp.then(function (k) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(topic) }, k, enc.encode(JSON.stringify(obj))); })
          .then(function (ct) { var c = new Uint8Array(ct), all = new Uint8Array(12 + c.length); all.set(iv); all.set(c, 12); return 'e1.' + b64(all); });
      },
      open: function (topic, text) {
        if (!text || String(text).slice(0, 3) !== 'e1.') return Promise.resolve(null);
        var all; try { all = unb64(String(text).slice(3)); } catch (e) { return Promise.resolve(null); }
        if (all.length < 29) return Promise.resolve(null);
        return kp.then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12), additionalData: enc.encode(topic) }, k, all.subarray(12)); })
          .then(function (b) { return json(dec.decode(b)); }, function () { return null; });
      }
    };
  };

  // ---------- connections to every broker (each reconnects by itself)
  window.TasLinks = function (subs, onMsg, onState) {
    var links = [], filters = subs.slice();
    C.brokers.forEach(function (url) {
      var L = { c: null, wait: 2000 };
      function open() {
        var c = new TasMQ(url, {
          onConnect: function () { L.wait = 2000; filters.forEach(function (f) { c.subscribe(f, 1); }); if (onState) onState(); },
          onMessage: function (t, x, r) { onMsg(t, x, r); },
          onClose: function () { if (onState) onState(); setTimeout(open, L.wait); L.wait = Math.min(L.wait * 2, 30000); }
        });
        L.c = c; c.connect();
      }
      open(); links.push(L);
    });
    return {
      up: function () { return links.filter(function (L) { return L.c && L.c.ok; }).length; },
      // to every connected broker; resolves when one of them has it (QoS 1)
      pub: function (t, x, o) {
        var live = links.filter(function (L) { return L.c && L.c.ok; });
        if (!live.length) return Promise.reject(new Error('no connection'));
        return new Promise(function (ok, no) {
          var left = live.length;
          live.forEach(function (L) { L.c.publish(t, x, o || {}).then(ok, function (e) { if (--left === 0) no(e); }); });
        });
      },
      sub: function (f) { if (filters.indexOf(f) >= 0) return; filters.push(f); links.forEach(function (L) { if (L.c && L.c.ok) L.c.subscribe(f, 1); }); },
      unsub: function (f) { var i = filters.indexOf(f); if (i < 0) return; filters.splice(i, 1); links.forEach(function (L) { if (L.c && L.c.ok) L.c.unsubscribe(f); }); }
    };
  };

  // ---------- what the remotes know about the presentations
  // state: list (folders and files, from the screen), pv[folder id] (current/next slide), sa (the screen is on), cfg (what the screen shows)
  window.TasDeckClient = function (onChange, opt) {
    opt = opt || {};
    var box = TasBox(TasSlidesKey.get());
    var S = { list: null, pv: {}, sa: null, saAt: 0, cfg: { scene: 'checkin', deck: '', sp: true, at: -1 }, scrAt: 0, scrBuild: '' };
    var chT = 0;
    function changed() { if (!chT) chT = setTimeout(function () { chT = 0; onChange(S); }, 30); }
    var subs = [B + '/dk', B + '/sa', B + '/cfg', B + '/scr'];
    if (opt.all) subs.push(B + '/pv/+');
    var was = 0, links = null, watching = '';
    links = TasLinks(subs, onMsg, function () {
      var u = links ? links.up() : 0;
      if (u > was) setTimeout(hello, 300);            // "screen, are you there?" — it answers at once instead of in 8 s
      was = u; changed();
    });
    function newer(a, b) { return !b || +a.t > +b.t || (+a.t === +b.t && +a.seq > +b.seq); }
    function onMsg(t, x) {
      if (t === B + '/cfg') {
        var c = json(x); if (!c) return;
        var at = +c.at || 0; if (at < S.cfg.at) return;
        S.cfg = { scene: String(c.scene || 'checkin'), deck: typeof c.deck === 'string' ? c.deck : '', sp: c.sp !== false, at: at };
        return changed();
      }
      if (t === B + '/scr') { S.scrAt = Date.now(); S.scrBuild = String(x || ''); return changed(); }
      if (t.indexOf(B + '/pv/') === 0 && !x) { delete S.pv[t.slice(B.length + 4)]; return changed(); }
      box.open(t, x).then(function (d) {
        if (!d || typeof d !== 'object') return;
        if (t === B + '/dk') { if (Array.isArray(d.decks) && newer(d, S.list)) { S.list = d; changed(); } }
        else if (t === B + '/sa') { if (!S.sa || +d.t >= +S.sa.t) S.sa = d; S.saAt = Date.now(); changed(); }
        else if (t.indexOf(B + '/pv/') === 0) { var id = t.slice(B.length + 4); if (newer(d, S.pv[id])) { S.pv[id] = d; changed(); } }
      });
    }
    function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
    function cmd(op, deck, extra) {
      var n = rid(), sn = S.sa && Date.now() - S.saAt < 30000 ? S.sa.sn : S.list ? S.list.sn : '';
      var body = { sn: sn, n: n, op: op, d: deck || '', from: opt.from || 'spk' };
      for (var k in extra || {}) body[k] = extra[k];
      box.seal(B + '/sk', body).then(function (x) { return links.pub(B + '/sk', x, { qos: 1 }); }).catch(function () {});
      return n;
    }
    function hello() { if (links.up()) cmd('hello'); }
    setInterval(changed, 3000);                        // "the screen is off" etc. stays right
    return {
      state: S, cmd: cmd, up: function () { return links.up(); },
      // the speakers' page listens to the previews of one folder only
      watch: function (id) {
        if (opt.all || id === watching) return;
        if (watching) links.unsub(B + '/pv/' + watching);
        watching = id || '';
        if (watching) links.sub(B + '/pv/' + watching);
      },
      screenOn: function () { return (S.saAt && Date.now() - S.saAt < 20000) || (S.scrAt && Date.now() - S.scrAt < 20000); },
      live: function () { return !!(S.sa && S.sa.f && Date.now() - S.saAt < 20000); }
    };
  };

  // ---------- the remote (shared by the host panel and the speakers' page)
  var CSS = '' +
    '.dk-st{padding:12px 14px;border:1px solid #262625;background:#171716;font-size:15px;line-height:1.35}' +
    '.dk-st.warn{border-color:var(--orange);background:#1a120f}' +
    '.dk-st b{font-weight:700}' +
    '.dk-h{margin-top:22px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--mute)}' +
    '.dk-items{margin-top:8px;border-top:1px solid var(--rule)}' +
    '.dk-it{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:14px;width:100%;min-height:72px;padding:12px 0;background:none;border:0;border-bottom:1px solid var(--rule);color:var(--fg);text-align:left;cursor:pointer;font:inherit}' +
    '.dk-it .th{width:88px;aspect-ratio:16/9;background:#1d1d1c center/contain no-repeat}' +
    '.dk-it.nth{grid-template-columns:minmax(0,1fr) auto}.dk-it.nth .th{display:none}' +
    '.dk-it .nm{display:block;font-size:20px;line-height:1.2;overflow-wrap:anywhere}' +
    '.dk-it .sb{display:block;margin-top:3px;color:var(--mute);font-size:14px}' +
    '.dk-it .go{color:var(--mute);font-size:22px}' +
    '.dk-it .on{display:inline-block;margin-top:6px;padding:2px 7px;background:var(--orange);color:#fff;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.dk-empty{margin-top:18px;color:var(--mute)}' +
    '.dk-back{margin-top:18px;padding:8px 0;background:none;border:0;color:var(--mute);font:inherit;font-size:15px;cursor:pointer}' +
    '.dk-name{margin-top:6px;font-size:clamp(30px,8vw,46px);line-height:1;letter-spacing:-.015em;font-weight:400;overflow-wrap:anywhere}' +
    '.dk-on{margin-top:10px;font-size:13px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--mute)}' +
    '.dk-on.hot{color:var(--orange)}.dk-on.hot:before{content:"";display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;background:var(--orange);vertical-align:1px}' +
    '.dk-pv{position:relative;margin-top:12px;aspect-ratio:16/9;background:#000;border:1px solid #262625;overflow:hidden}' +
    '.dk-pv img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .15s}' +
    '.dk-pv.wait img{opacity:.55}' +
    '.dk-pv .ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:var(--mute);font-size:15px}' +
    '.dk-pv .tag{position:absolute;left:8px;bottom:8px;padding:3px 8px;background:rgba(0,0,0,.75);color:#fff;font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.dk-pv .tag:empty{display:none}' +
    '.dk-pos{margin-top:10px;display:flex;justify-content:space-between;gap:12px;align-items:baseline}' +
    '.dk-pos b{font-size:26px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.dk-pos span{color:var(--mute);font-size:14px;text-align:right;overflow-wrap:anywhere}' +
    '.dk-ar{margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
    '.dk-ar button{min-height:76px;border:0;background:#242423;color:var(--fg);font:inherit;font-size:34px;cursor:pointer;touch-action:manipulation}' +
    '.dk-ar button.nx{background:var(--fg);color:#0e0e0e}' +
    '.dk-ar button:active{opacity:.75}.dk-ar button[disabled]{opacity:.3;cursor:default}' +
    '.dk-vc{margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
    '.dk-b{min-height:52px;padding:0 14px;border:0;background:#242423;color:var(--fg);font:inherit;font-size:14px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;cursor:pointer}' +
    '.dk-b.o{background:var(--orange);color:#fff}.dk-b[disabled]{opacity:.35;cursor:default}' +
    '.dk-show{display:block;width:100%;margin-top:14px}' +
    '.dk-note{margin-top:8px;color:var(--mute);font-size:14px}.dk-note:empty{display:none}' +
    '.dk-nx{margin-top:22px;display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px;align-items:center}' +
    '.dk-nx .th{aspect-ratio:16/9;background:#000 center/contain no-repeat;border:1px solid #262625}' +
    '.dk-nx p{font-size:14px;color:var(--mute)}.dk-nx p b{display:block;font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;margin-bottom:3px}' +
    '.dk-fh{margin-top:26px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--mute)}' +
    '.dk-files{margin:8px 0 0;padding:0;list-style:none;border-top:1px solid var(--rule)}' +
    '.dk-files li{border-bottom:1px solid var(--rule)}' +
    '.dk-files button{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:10px;align-items:baseline;width:100%;padding:14px 0;background:none;border:0;color:var(--fg);font:inherit;text-align:left;cursor:pointer}' +
    '.dk-files button[disabled]{cursor:default}' +
    '.dk-files .i{color:var(--mute);font-variant-numeric:tabular-nums}' +
    '.dk-files .n{font-size:17px;overflow-wrap:anywhere}' +
    '.dk-files .c{color:var(--mute);font-size:14px;white-space:nowrap}' +
    '.dk-files .w{grid-column:2/-1;color:var(--orange);font-size:14px;line-height:1.35}' +
    '.dk-files li.cur button{box-shadow:inset 3px 0 0 var(--orange);padding-left:10px}' +
    '.dk-files li.cur .n{color:var(--orange)}';

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function mmss(s) { s = Math.round(+s || 0); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function count(f) { return f.k === 'pdf' ? f.c + (f.c === 1 ? ' slide' : ' slides') : f.k === 'vid' ? 'video' + (f.dur ? ' ' + mmss(f.dur) : '') : f.k === 'img' ? 'picture' : ''; }
  function what(it) {                                   // "file.pdf · page 3 of 12"
    if (!it) return '';
    return it.n + (it.k === 'pdf' && it.c > 1 ? ' · page ' + (it.p + 1) + ' of ' + it.c : it.k === 'vid' ? ' · video' : '');
  }

  // TasDeckUI(root, {mode: 'host' | 'speaker'}): host — every folder, with previews; speaker — chooses one folder and controls it
  window.TasDeckUI = function (root, opt) {
    var host = opt.mode === 'host', MY = 'tas3d-spk-deck-' + C.room;
    if (!document.getElementById('dk-css')) { var st = el('style'); st.id = 'dk-css'; st.textContent = CSS; document.head.appendChild(st); }
    var cl = TasDeckClient(render, { all: host, from: host ? 'host' : 'spk' }), S = cl.state;
    var open = '';
    if (!host) { try { open = localStorage.getItem(MY) || ''; } catch (e) {} cl.watch(open); }
    var pend = null;                                    // the last command, until the screen confirms it: {n, d, i, cur, at}
    var sure = 0;                                       // "Show on the screen" needs a second tap while something else is shown

    root.innerHTML = '';
    var R = {};
    function add(parent, tag, cls, key, text) { var e = el(tag, cls, text); parent.appendChild(e); if (key) R[key] = e; return e; }
    var wrap = add(root, 'div', 'dk');
    add(wrap, 'p', 'dk-st', 'st');
    var list = add(wrap, 'div', '', 'list');
    add(list, 'p', 'dk-h', 'lh', host ? 'Speakers’ folders' : 'Choose your folder');
    add(list, 'div', 'dk-items', 'items');
    add(list, 'p', 'dk-empty', 'empty');
    var deck = add(wrap, 'div', '', 'deck');
    var back = add(deck, 'button', 'dk-back', 'back', host ? '← All folders' : '← Not your folder? Choose another');
    back.type = 'button';
    add(deck, 'h2', 'dk-name', 'name');
    add(deck, 'p', 'dk-on', 'on');
    var pv = add(deck, 'div', 'dk-pv', 'pv');
    var cur = add(pv, 'img', '', 'cur'); cur.alt = ''; cur.hidden = true;
    add(pv, 'span', 'ph', 'ph');
    add(pv, 'span', 'tag', 'tag');
    var pos = add(deck, 'p', 'dk-pos', 'pos'); add(pos, 'b', '', 'posN'); add(pos, 'span', '', 'posW');
    var ar = add(deck, 'div', 'dk-ar');
    var prev = add(ar, 'button', '', 'prev', '←'), next = add(ar, 'button', 'nx', 'next', '→');
    prev.type = next.type = 'button'; prev.setAttribute('aria-label', 'Previous slide'); next.setAttribute('aria-label', 'Next slide');
    var vc = add(deck, 'div', 'dk-vc', 'vc');
    var play = add(vc, 'button', 'dk-b', 'play', 'Play video'), restart = add(vc, 'button', 'dk-b', 'restart', 'From the start');
    play.type = restart.type = 'button';
    var show = add(deck, 'button', 'dk-b o dk-show', 'show', 'Show on the screen'); show.type = 'button';
    add(deck, 'p', 'dk-note', 'note');
    var nx = add(deck, 'div', 'dk-nx', 'nx'); add(nx, 'span', 'th', 'nxt'); var nxp = add(nx, 'p', '', 'nxp');
    add(deck, 'p', 'dk-fh', '', 'Files in this folder');
    add(deck, 'ol', 'dk-files', 'files');

    function decks() { return S.list ? S.list.decks : []; }
    function find(id) { var d = decks(); for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i]; return null; }
    function onScreen(id) { return S.cfg.scene === 'slides' && S.cfg.deck === id; }
    function choose(id) {
      open = id; pend = null; sure = 0;
      if (!host) { try { if (id) localStorage.setItem(MY, id); else localStorage.removeItem(MY); } catch (e) {} cl.watch(id); }
      render(); window.scrollTo(0, 0);
    }
    back.addEventListener('click', function () { choose(''); });

    function command(op, extra) {
      if (!open || !cl.live()) return;
      var d = find(open), p = S.pv[open], n = cl.cmd(op, open, extra);
      pend = { n: n, at: Date.now() };
      // show the next slide at once (its preview is already here); the screen confirms in a moment
      if (p && d) {
        if (op === 'next' && p.i + 1 < d.total) { pend.i = p.i + 1; pend.cur = p.nxt || ''; pend.it = p.nx; }
        if (op === 'prev' && p.i > 0) { pend.i = p.i - 1; }
        if (op === 'file' && d.files[extra.f]) { pend.i = d.files[extra.f].from; }
      }
      render();
    }
    prev.addEventListener('click', function () { command('prev'); });
    next.addEventListener('click', function () { command('next'); });
    play.addEventListener('click', function () { var p = S.pv[open]; command(p && p.v && p.v.play ? 'pause' : 'play'); });
    restart.addEventListener('click', function () { command('restart'); });
    show.addEventListener('click', function () {
      if (onScreen(open)) return command('hide');
      var busy = !host && S.cfg.scene !== 'blank' && S.cfg.scene !== 'logo';
      if (busy && Date.now() - sure > 4000) { sure = Date.now(); render(); setTimeout(render, 4100); return; }
      sure = 0; command('show');
    });
    document.addEventListener('keydown', function (e) {
      if (!open || deck.hidden || root.offsetParent === null || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); command('next'); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); command('prev'); }
    });

    var shownFiles = '';
    function render() {
      var live = cl.live(), on = cl.screenOn(), sa = S.sa, L = S.list;
      // ---- status
      var msg = '', warn = true;
      if (!cl.up()) msg = 'No connection to the server. Check the internet on this device.';
      else if (!on) msg = host ? 'The screen is off. Open it on the computer at the projector (Screen ↗).' : 'The screen is not open yet. The host opens it on the computer at the projector.';
      else if (!sa || Date.now() - S.saAt > 20000) msg = host ? 'The screen runs an old version: refresh it (Screen ↗).' : 'The screen is not ready for the presentations yet. Tell the host.';
      else if (!sa.f) msg = sa.need === 'reconnect'
        ? (host ? 'On the screen computer: move the mouse and press “Reconnect folder” (once after opening the screen).' : 'The presentations folder is not open on the screen computer yet. Tell the host.')
        : (host ? 'On the screen computer: move the mouse, press “Connect folder” and choose “TAS3D 2026 Presentations”.' : 'The presentations folder is not open on the screen computer yet. Tell the host.');
      else { warn = false; msg = host ? 'Folder on the screen computer: ' + (sa.folder || '') + ' · ' + decks().length + (decks().length === 1 ? ' folder' : ' folders') : ''; }
      R.st.textContent = msg; R.st.hidden = !msg; R.st.classList.toggle('warn', warn);

      var d = open ? find(open) : null;
      if (open && !d && L) { open = ''; if (!host) { try { localStorage.removeItem(MY); } catch (e) {} cl.watch(''); } }
      R.list.hidden = !!open; R.deck.hidden = !open;
      if (!open) return renderList();
      renderDeck(d, live);
    }
    function renderList() {
      var ds = decks(), box = R.items, sig = JSON.stringify([ds.map(function (d) { return [d.id, d.name, d.total, d.files.length]; }), S.cfg.scene === 'slides' ? S.cfg.deck : '']);
      R.empty.textContent = !S.list ? 'Waiting for the list of folders from the screen…' : ds.length ? '' : 'The folder on the screen computer has no speakers’ folders yet.';
      if (box.getAttribute('data-s') !== sig) {
        box.setAttribute('data-s', sig); box.innerHTML = '';
        ds.forEach(function (d) {
          var b = el('button', 'dk-it' + (host ? '' : ' nth')); b.type = 'button'; b.setAttribute('data-id', d.id);
          var th = el('span', 'th'); b.appendChild(th);
          var tx = el('span'); tx.appendChild(el('span', 'nm', d.name));
          var bad = d.files.filter(function (f) { return f.k === 'bad'; }).length;
          var shown = d.files.length - bad;
          tx.appendChild(el('span', 'sb', !d.files.length ? 'No files yet' : shown + (shown === 1 ? ' file' : ' files') + ' · ' + d.total + (d.total === 1 ? ' slide' : ' slides') + (bad ? ' · ' + bad + ' cannot be shown' : '')));
          if (onScreen(d.id)) tx.appendChild(el('span', 'on', 'On the screen'));
          b.appendChild(tx); b.appendChild(el('span', 'go', '›'));
          b.addEventListener('click', function () { choose(d.id); });
          box.appendChild(b);
        });
      }
      if (host) box.querySelectorAll('.dk-it').forEach(function (b) {   // small previews of where each speaker is
        var p = S.pv[b.getAttribute('data-id')], u = p && p.cur ? 'url("' + p.cur + '")' : '';
        var th = b.querySelector('.th'); if (th.getAttribute('data-u') !== String(p && p.seq)) { th.setAttribute('data-u', String(p && p.seq)); th.style.backgroundImage = u; }
      });
    }
    function renderDeck(d, live) {
      var p = S.pv[open] || null, isOn = onScreen(open);
      if (pend && (Date.now() - pend.at > 5000 || (p && p.ack === pend.n))) pend = null;
      R.name.textContent = d ? d.name : 'Loading…';
      R.on.textContent = isOn ? 'On the screen now' : S.cfg.scene === 'slides' ? 'Not on the screen · another presentation is shown' : 'Not on the screen';
      R.on.classList.toggle('hot', isOn);
      var total = d ? d.total : 0, i = pend && pend.i != null ? pend.i : p ? p.i : 0;
      var src = pend && pend.cur != null ? pend.cur : p ? p.cur : '';
      var it = pend && pend.it ? pend.it : pend && pend.i != null ? null : p ? p.it : null;
      if (src) { if (cur.getAttribute('src') !== src) cur.setAttribute('src', src); cur.hidden = false; } else cur.hidden = true;
      R.ph.textContent = src ? '' : !d ? '' : !total ? 'No slides in this folder yet.' : 'Preview is coming…';
      R.pv.classList.toggle('wait', !!pend);
      R.tag.textContent = it && it.k === 'vid' ? 'Video' + (it.dur ? ' · ' + mmss(it.dur) : '') + (p && p.v && !pend ? (p.v.play ? ' · playing' : p.v.end ? ' · ended' : ' · paused') : '') : '';
      R.posN.textContent = total ? (i + 1) + ' / ' + total : '';
      R.posW.textContent = what(it);
      var can = live && !!d && total > 0;
      prev.disabled = !can || i <= 0; next.disabled = !can || i >= total - 1;
      // video
      var vid = !!(it && it.k === 'vid');
      R.vc.hidden = !vid;
      play.textContent = p && p.v && p.v.play ? 'Pause video' : 'Play video';
      play.disabled = restart.disabled = !can || !isOn;
      // show / take off
      var locked = !host && S.cfg.sp === false;
      show.textContent = isOn ? 'Take off the screen' : sure && Date.now() - sure < 4000 ? 'Tap again to show it now' : 'Show on the screen';
      show.className = 'dk-b dk-show' + (isOn ? '' : ' o');
      show.disabled = !can || (locked && !isOn);
      var note = '';
      if (locked && !isOn) note = 'The host has turned this off for now. Ask the host to show your slides.';
      else if (!isOn && sure && Date.now() - sure < 4000) note = 'The screen shows something else now (' + S.cfg.scene + '). Tap again to replace it with your slides.';
      else if (vid && !isOn) note = 'The video plays when your slides are on the screen.';
      else if (p && p.v && p.v.mute && isOn) note = 'The video plays without sound: someone has to click once on the screen computer.';
      else if (!isOn && can) note = 'You can look through your slides here; the audience sees them after “Show on the screen”.';
      R.note.textContent = note;
      // next
      var nxi = pend ? null : p && p.nx;
      R.nx.hidden = !d || !total;
      R.nxt.style.backgroundImage = !pend && p && p.nxt ? 'url("' + p.nxt + '")' : '';
      nxp.innerHTML = '';
      nxp.appendChild(el('b', '', 'Next'));
      nxp.appendChild(document.createTextNode(pend ? '…' : nxi ? what(nxi) : p ? 'This is the last slide.' : ''));
      // files
      var fsig = JSON.stringify([d && d.files, it && it.f]);
      if (fsig !== shownFiles) {
        shownFiles = fsig; R.files.innerHTML = '';
        (d ? d.files : []).forEach(function (f, k) {
          var li = el('li', it && it.f === k ? 'cur' : ''), b = el('button'); b.type = 'button';
          b.appendChild(el('span', 'i', String(k + 1))); b.appendChild(el('span', 'n', f.n)); b.appendChild(el('span', 'c', count(f)));
          if (f.w) b.appendChild(el('span', 'w', f.w));
          if (f.k === 'bad' || !f.c) b.disabled = true;
          else { b.setAttribute('data-ok', '1'); b.addEventListener('click', function () { command('file', { f: k }); }); }
          li.appendChild(b); R.files.appendChild(li);
        });
        if (d && !d.files.length) { var li0 = el('li'); li0.appendChild(el('p', 'dk-empty', 'No files yet. PDF, pictures (JPG, PNG) and videos (MP4) go into this folder on the screen computer.')); R.files.appendChild(li0); }
      }
      R.files.querySelectorAll('button[data-ok]').forEach(function (b) { b.disabled = !can; });
    }
    render();
    return { client: cl, open: choose, render: render };
  };
})();

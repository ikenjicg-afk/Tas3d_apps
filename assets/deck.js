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
  var SK = 'tas3d-spk-' + C.room, HK = 'tas3d-host-' + C.room, XK = 'tas3d-scr-' + C.room, DAYS90 = 90 * 864e5, KEYRE = /^[0-9a-f]{64}$/;
  function read(k) { try { return json(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  window.TasSlidesKey = {
    // from the speakers' login, or from the host's login on this device (the host password opens the slides too)
    get: function () {
      var h = read(HK), s = read(SK), x = read(XK), now = Date.now();
      // a key kept from before a password change is not used (the passwords give a different key now)
      function good(r) { return r && r.until > now && KEYRE.test(r.k || '') && (r.s === Z.ssalt || r.h === C.host.hash); }
      if (h && h.h === C.host.hash && good(h)) return h.k;
      if (s && s.s === Z.ssalt && good(s)) return s.k;
      if (x && x.s === Z.ssalt && good(x)) return x.k;
      return null;
    },
    // the projector screen: the key comes with its link (#k=..., from the host panel or TAS3D Screen.html), kept for a year
    keepScreen: function (k) { if (KEYRE.test(k || '')) { try { localStorage.setItem(XK, JSON.stringify({ k: k, s: Z.ssalt, until: Date.now() + 4 * DAYS90 })); } catch (e) {} return true; } return false; },
    // the host's or the speakers' password → the key (hex) or null; used by the screen's settings
    fromAny: function (pass) {
      return TasSlidesKey.fromHost(pass).catch(function () { return null; }).then(function (k) {
        if (k) return k;
        return derive(pass, Z.ssalt).then(function (K) { return unseal(K, Z.check).then(function () { return hex(K); }, function () { return null; }); });
      });
    },
    speakerLogin: function () { var s = read(SK); return !!(s && s.s === Z.ssalt && s.until > Date.now() && KEYRE.test(s.k || '')); },
    // the speakers' password → true/false; a right one is kept on this device for 90 days
    speakers: function (pass) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This browser cannot check the password here.'));
      return derive(pass, Z.ssalt).then(function (K) {
        return unseal(K, Z.check).then(function (t) {
          if (dec.decode(t) !== 'tas3d-slides') return false;
          try { localStorage.setItem(SK, JSON.stringify({ k: hex(K), s: Z.ssalt, until: Date.now() + DAYS90 })); } catch (e) {}
          return true;
        }, function () { return false; });
      });
    },
    // the speakers' QR in the host panel carries the key (#k=...): the speaker scans it and is in, no password
    useKey: function (k) {
      if (!KEYRE.test(k || '')) return Promise.resolve(false);
      return unseal(unhex(k), Z.check).then(function (t) {
        if (dec.decode(t) !== 'tas3d-slides') return false;
        try { localStorage.setItem(SK, JSON.stringify({ k: k, s: Z.ssalt, until: Date.now() + DAYS90 })); } catch (e) {}
        return true;
      }, function () { return false; });
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
    // screens: every open screen by its session (sn) — a second screen open somewhere (an old tab, a laptop at home) does not confuse the remote
    var S = { list: null, pv: {}, sa: null, saAt: 0, screens: {}, cfg: { scene: 'checkin', deck: '', live: '', at: -1, w: '' }, scrAt: 0, scrBuild: '', picN: 0,
      tm: { d: '', st: 'off', t0: 0, el: 0, at: -1, w: '' } };   // the talk timer: folder, run | stop | off, started at, ms when stopped
    var chT = 0, fns = onChange ? [onChange] : [];
    function changed() { if (!chT) chT = setTimeout(function () { chT = 0; fns.forEach(function (f) { try { f(S); } catch (e) {} }); }, 30); }
    // the same message comes through both servers (and their bridge): decrypt it once
    var lastRaw = {};
    var subs = [B + '/dk', B + '/sa', B + '/cfg', B + '/scr', B + '/tm'];
    if (opt.sound) subs.push(B + '/au');
    if (opt.all) subs.push(B + '/pv/+');
    var was = 0, links = null, watching = '';
    links = TasLinks(subs, onMsg, function () {
      var u = links ? links.up() : 0;
      if (u > was) setTimeout(hello, 300);            // "screen, are you there?" — it answers at once instead of in 8 s
      was = u; changed();
    });
    function newer(a, b) { return !b || +a.t > +b.t || (+a.t === +b.t && +a.seq > +b.seq); }
    // a screen that is open now and has the folder (it says so every 8 s)
    function alive(sn) { var x = S.screens[sn]; return !!(x && x.d.f && Date.now() - x.at < 30000); }
    // two screens open at once: this remote follows one of them, not each in turn. The one that is open now wins over one
    // that is gone; of two open ones, the one whose position was set last (pn), then the one that was opened last (st).
    function newerPv(a, b) {
      if (!b) return true;
      if (a.sn === b.sn) return newer(a, b);
      var la = alive(a.sn), lb = alive(b.sn);
      if (la !== lb) return la;
      var pa = +a.pn || 0, pb = +b.pn || 0;
      if (pa !== pb) return pa > pb;
      var sa = +a.st || 0, sb = +b.st || 0;
      if (sa !== sb) return sa > sb;
      return newer(a, b);
    }
    // ---------- pictures of the slides: they come apart from the positions (px/<folder>/c = current, /n = next), over
    // connections of their own, so a picture on a slow phone network never holds back "which slide is on"
    var pics = {}, picQ = [];
    function keepPic(id, total, i, src) {
      if (!src || typeof src !== 'string' || src.slice(0, 11) !== 'data:image/') return;
      var k = id + '|' + total + '|' + i;
      if (pics[k] === src) return;
      if (!(k in pics)) { picQ.push(k); if (picQ.length > 160) delete pics[picQ.shift()]; }
      pics[k] = src; S.picN++;
    }
    var picRaw = {}, picSubs = [];
    var picLinks = TasLinks([], function (t, x) {
      if (!x || picRaw[t] === x) return;
      picRaw[t] = x;
      box.open(t, x).then(function (d) {
        if (!d || !Number.isInteger(d.i) || !Number.isInteger(d.total)) return;
        var id = t.slice(B.length + 4).split('/')[0];
        if (d.img) { keepPic(id, d.total, d.i, d.img); changed(); }
      });
    }, function () {});
    // which pictures this device needs now: every folder's current slide (the host's list), or all of one folder
    function wantPics(list) {
      list.forEach(function (f) { if (picSubs.indexOf(f) < 0) picLinks.sub(f); });
      picSubs.forEach(function (f) { if (list.indexOf(f) < 0) { picLinks.unsub(f); for (var k in picRaw) if (match(f, k)) delete picRaw[k]; } });
      picSubs = list.slice();
    }
    function match(f, t) { var a = f.split('/'), b = t.split('/'); if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== '+' && a[i] !== b[i]) return false; return true; }
    var nextOf = [];
    function picFilters() {
      var l = [];
      if (opt.all) { l.push(B + '/px/+/c'); nextOf.forEach(function (id) { if (id) l.push(B + '/px/' + id + '/n'); }); }
      else if (watching) l.push(B + '/px/' + watching + '/+');
      wantPics(l);
    }
    picFilters();
    function onMsg(t, x, r) {                           // r: the server kept it and sends it at subscribe (not a message of this moment)
      if (t === B + '/cfg') {
        var c = json(x); if (!c) return;
        var at = +c.at || 0, w = String(c.w || '');
        if (at < S.cfg.at || (at === S.cfg.at && w < S.cfg.w)) return;     // the same rule as the host panel and the screen (hub.js)
        S.cfg = { scene: String(c.scene || 'checkin'), deck: typeof c.deck === 'string' ? c.deck : '', live: typeof c.live === 'string' ? c.live : '', at: at, w: w };
        return changed();
      }
      if (t === B + '/scr') { S.scrAt = Date.now(); S.scrBuild = String(x || ''); return changed(); }
      if (t.indexOf(B + '/pv/') === 0 && !x) { delete S.pv[t.slice(B.length + 4)]; return changed(); }
      if (t !== B + '/sa' && lastRaw[t] === x) return;
      lastRaw[t] = x;
      box.open(t, x).then(function (d) {
        if (!d || typeof d !== 'object') return;
        if (t === B + '/dk') {
          // the list of folders: of two screens that are open with different folders, the one opened last
          // (they would otherwise replace each other's list every minute)
          if (!Array.isArray(d.decks)) return;
          var cur = S.list;
          if (cur && d.sn !== cur.sn && alive(cur.sn) && !((+d.st || 0) > (+cur.st || 0))) return;
          if (!cur || d.sn !== cur.sn || newer(d, cur)) { S.list = d; changed(); }
        }
        else if (t === B + '/sa' && typeof d.sn === 'string') {
          var now = Date.now();
          if (d.bye) delete S.screens[d.sn]; else S.screens[d.sn] = { at: now, d: d };
          if (d.bye && S.sa && S.sa.sn === d.sn) { S.sa = null; S.saAt = 0; }
          // the screen that matters: the most recent one with the folder open, else the most recent one
          var best = null, bestAt = 0;
          for (var k in S.screens) {
            var x = S.screens[k]; if (now - x.at > 60000) { delete S.screens[k]; continue; }
            var score = x.at + (x.d.f ? 30000 : 0);
            if (score > bestAt) { bestAt = score; best = x; }
          }
          if (best) { S.sa = best.d; S.saAt = best.at; }
          changed();
        }
        else if (t.indexOf(B + '/pv/') === 0) {
          var id = t.slice(B.length + 4);
          // a screen of an older version sends the pictures inside this message
          if (d.cur) keepPic(id, d.total, d.i, d.cur);
          if (d.nxt) keepPic(id, d.total, d.i + 1, d.nxt);
          if (newerPv(d, S.pv[id])) { S.pv[id] = d; changed(); }
        }
        else if (t === B + '/au') { if (newer(d, S.au)) { S.au = d; S.auAt = Date.now(); changed(); } }
        else if (t === B + '/tm') {
          var ta = +d.at || 0, tw = String(d.w || '');
          if (ta < S.tm.at || (ta === S.tm.at && tw <= S.tm.w)) return;
          var t0 = +d.t0 || 0;
          // "run" that comes at this moment (not kept by the server): count from this device's own clock, so a phone whose
          // clock is off shows the same time as the host. d.t − d.t0 = how long it had run when it was sent (0 at the start).
          // A page opened later gets the kept message and counts from the host's clock (t0).
          if (!r && d.st === 'run' && typeof d.t === 'number') t0 = Date.now() - Math.max(0, d.t - t0);
          S.tm = { d: typeof d.d === 'string' ? d.d : '', st: /^(run|stop)$/.test(d.st) ? d.st : 'off', t0: t0, el: Math.max(0, +d.el || 0), at: ta, w: tw };
          changed();
        }
      });
    }
    // ---- the talk timer: counts up from 00:00 from the moment the host presses "Start timer"; every device counts by itself
    // from that moment (t0, the host's clock), so nothing is sent while it runs. One timer at a time, for one folder.
    var TW = Math.random().toString(36).slice(2, 10);
    function timer(op, deck) {
      var now = Date.now(), tm = S.tm, n;
      if (op === 'start') n = { d: deck || '', st: 'run', t0: now, el: 0 };
      else if (op === 'stop') { if (tm.st !== 'run') return; n = { d: tm.d, st: 'stop', t0: tm.t0, el: Math.max(0, now - tm.t0) }; }
      else n = { d: '', st: 'off', t0: 0, el: 0 };
      n.at = Math.max(now, tm.at + 1); n.w = TW; n.t = now;
      S.tm = n; changed();
      box.seal(B + '/tm', n).then(function (x) { return links.pub(B + '/tm', x, { qos: 1, retain: true }); }).catch(function () {});
    }
    // the timer of a folder: {st: run | stop | off, ms}
    function timerOf(id) {
      var tm = S.tm; if (!id || tm.d !== id || tm.st === 'off') return { st: 'off', ms: 0 };
      return { st: tm.st, ms: tm.st === 'run' ? Math.max(0, Date.now() - tm.t0) : tm.el };
    }
    function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
    // a command goes to every screen that has the folder open (one is usual; a second one, e.g. a monitor backstage, follows too)
    var sent = {};
    function targets(op) {
      var now = Date.now(), sns = [], need = op === 'snd' ? 'au' : op === 'reload' || op === 'upd' ? '' : 'f';   // sound: the screen with the sound folder; "update yourself": every screen
      for (var k in S.screens) if (now - S.screens[k].at < 30000 && (!need || S.screens[k].d[need])) sns.push(k);
      if (!sns.length && S.sa) sns.push(S.sa.sn);
      return sns;
    }
    var cid = rid(), cmdK = 0;                         // this remote and the order of its taps (a late tap is not done after a later one)
    function cmd(op, deck, extra) {
      var n = rid();
      var body = { sn: targets(op), n: n, op: op, d: deck || '', from: opt.from || 'spk', c: cid, k: ++cmdK };
      for (var e in extra || {}) body[e] = extra[e];
      sent[n] = body; send(body);
      return n;
    }
    function send(body) { return box.seal(B + '/sk', body).then(function (x) { return links.pub(B + '/sk', x, { qos: 1 }); }).catch(function () {}); }
    // the same command again (the screen does it only once): when the screen has not confirmed it in time
    function resend(n) { var b = sent[n]; if (!b) return; b.sn = targets(b.op); send(b); }   // to the screens open now (one may have reloaded)
    function hello() { if (links.up()) cmd('hello'); }
    setInterval(changed, 3000);                        // "the screen is off" etc. stays right
    return {
      state: S, cmd: cmd, resend: resend, up: function () { return links.up(); },
      timer: timer, timerOf: timerOf,
      listen: function (f) { fns.push(f); changed(); },
      // the speakers' page listens to the previews of one folder only
      watch: function (id) {
        if (opt.all || id === watching) return;
        if (watching) links.unsub(B + '/pv/' + watching);
        watching = id || '';
        if (watching) links.sub(B + '/pv/' + watching);
        picFilters();
      },
      // the host panel: the folders whose next slide is needed too (the one that is open, the one on the screen)
      next: function (ids) { ids = ids.filter(Boolean); if (ids.join() === nextOf.join()) return; nextOf = ids; picFilters(); },
      // the picture of slide i of a folder ('' = not here yet)
      pic: function (id, total, i) { return pics[id + '|' + total + '|' + i] || ''; },
      // how many screen pages are open right now (they say "I am here" every 8 s; a closed one says goodbye)
      screens: function () { var n = 0, now = Date.now(); for (var k in S.screens) if (now - S.screens[k].at < 20000) n++; return n; },
      screenOn: function () { return (S.saAt && Date.now() - S.saAt < 20000) || (S.scrAt && Date.now() - S.scrAt < 20000); },
      live: function () { var now = Date.now(); for (var k in S.screens) if (S.screens[k].d.f && now - S.screens[k].at < 20000) return true; return false; }
    };
  };

  // ---------- the remote (shared by the host panel and the speakers' page)
  var CSS = '' +
    '.dk-st{padding:12px 14px;border:1px solid #262625;background:#171716;font-size:15px;line-height:1.35}' +
    '.dk-st.warn{border-color:var(--orange);background:#1a120f}' +
    '.dk-h{margin-top:22px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--mute)}' +
    '.dk-items{margin-top:8px;border-top:1px solid var(--rule)}' +
    '.dk-row{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--rule)}' +
    '.dk-row.lv{box-shadow:inset 3px 0 0 var(--orange);padding-left:10px}' +
    '.dk-it{flex:1;display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:14px;min-width:0;min-height:72px;padding:12px 0;background:none;border:0;color:var(--fg);text-align:left;cursor:pointer;font:inherit}' +
    '.dk-it .th{width:88px;aspect-ratio:16/9;background:#1d1d1c center/contain no-repeat}' +
    '.dk-it.nth{grid-template-columns:minmax(0,1fr)}.dk-it.nth .th{display:none}' +
    '.dk-it .nm{display:block;font-size:20px;line-height:1.2;overflow-wrap:anywhere}' +
    '.dk-it .sb{display:block;margin-top:3px;color:var(--mute);font-size:14px}' +
    '.dk-tg{display:inline-block;margin:6px 6px 0 0;padding:2px 7px;background:#2a2a29;color:var(--fg);font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.dk-tg.o{background:var(--orange);color:#fff}' +
    '.dk-go{color:var(--mute);font-size:22px;padding:0 4px}' +
    '.dk-empty{margin-top:18px;color:var(--mute)}' +
    '.dk-back{margin-top:18px;padding:8px 0;background:none;border:0;color:var(--mute);font:inherit;font-size:15px;cursor:pointer}' +
    '.dk-name{margin-top:6px;font-size:clamp(30px,8vw,46px);line-height:1;letter-spacing:-.015em;font-weight:400;overflow-wrap:anywhere}' +
    '.dk-on{margin-top:12px;padding:10px 12px;border:1px solid #2c2c2b;font-size:14px;line-height:1.35;color:var(--mute)}' +
    '.dk-on b{display:block;margin-bottom:2px;font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--fg)}' +
    '.dk-on.hot{border-color:var(--orange);background:#1a120f}.dk-on.hot b{color:var(--orange)}' +
    '.dk-on.hot b:before{content:"";display:inline-block;width:9px;height:9px;margin-right:8px;border-radius:50%;background:var(--orange);vertical-align:1px;animation:dkb 2s ease-in-out infinite}' +
    '@keyframes dkb{50%{opacity:.3}}' +
    '.dk-pv{position:relative;margin-top:12px;aspect-ratio:16/9;background:#000;border:1px solid #262625;overflow:hidden}' +
    '.dk-pv img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .15s}' +
    '.dk-pv.wait img{opacity:.6}' +
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
    '.dk-b{min-height:52px;padding:0 14px;border:0;background:#242423;color:var(--fg);font:inherit;font-size:14px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;cursor:pointer;touch-action:manipulation}' +
    '.dk-b.o{background:var(--orange);color:#fff}.dk-b.sm{min-height:40px;padding:0 12px;font-size:12px}.dk-b[disabled]{opacity:.35;cursor:default}' +
    '.dk-show,.dk-live{display:block;width:100%;margin-top:12px}' +
    // the talk timer: the same row for the host (under Start: a tap starts / stops / resets it) and for the speaker
    // (the same place, nothing to tap: it only counts up — no colours for "time is running out", no sound)
    '.dk-tm{display:flex;align-items:center;gap:10px;width:100%;margin-top:8px;min-height:52px;padding:0 14px;border:1px solid #2c2c2b;background:none;color:var(--mute);font:inherit;text-align:left;cursor:pointer;touch-action:manipulation}' +
    '.dk-tm svg{flex:none;width:20px;height:20px}' +
    '.dk-tm b{font-size:22px;font-weight:400;font-variant-numeric:tabular-nums}' +
    '.dk-tm span{margin-left:auto;color:var(--fg);font-size:14px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}' +
    '.dk-tm.run{border-color:#4a4a48}.dk-tm.run svg{color:var(--orange)}.dk-tm.run b,.dk-tm.stop b{color:var(--fg)}' +
    'button.dk-tm:active{opacity:.75}' +
    // the talk is longer than its slot (config.js: timer.glow): a slow, calm orange glow — seen from the corner of the eye
    '.dk-tm.late{border-color:var(--orange);animation:dktm 3.2s ease-in-out infinite}.dk-tm.late b{color:var(--orange)}' +
    '@keyframes dktm{0%,100%{background-color:rgba(240,85,42,0);box-shadow:0 0 0 0 rgba(240,85,42,0)}50%{background-color:rgba(240,85,42,.2);box-shadow:0 0 22px 0 rgba(240,85,42,.42)}}' +
    '.dk-tg.tm.late{color:var(--orange)}' +
    '@media (prefers-reduced-motion:reduce){.dk-tm.late{animation:none;background-color:rgba(240,85,42,.14)}}' +
    'div.dk-tm{cursor:default}div.dk-tm span{color:var(--mute);font-size:12px}' +
    '.dk-tg.tm{background:none;border:1px solid #3a3a38;color:var(--mute);font-weight:400;font-variant-numeric:tabular-nums;padding:1px 6px}' +
    '.dk-row .dk-b{flex:none}' +
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
  var GLOW = C.timer && C.timer.glow > 0 ? C.timer.glow * 60000 : 0;      // the talk timer glows after this long (0 = never)
  function late(ms) { return GLOW > 0 && ms >= GLOW; }
  function clock(ms) { var s = Math.floor((+ms || 0) / 1000); return ('0' + Math.floor(s / 60)).slice(-2 - (s >= 6000 ? 1 : 0)) + ':' + ('0' + s % 60).slice(-2); }   // 00:00 … 99:59, 100:00
  var WATCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="14" r="7.5"/><path d="M12 14V9.8M9.6 2.6h4.8M12 2.6v3.9M18.3 7.7l1.4-1.4"/></svg>';
  function count(f) { return f.k === 'pdf' ? f.c + (f.c === 1 ? ' slide' : ' slides') : f.k === 'vid' ? 'video' + (f.dur ? ' ' + mmss(f.dur) : '') + (f.lp ? ' · loop' : '') : f.k === 'img' ? 'picture' : ''; }
  function what(it) {                                   // "file.pdf · page 3 of 12"
    if (!it) return '';
    return it.n + (it.k === 'pdf' && it.c > 1 ? ' · page ' + (it.p + 1) + ' of ' + it.c : it.k === 'vid' ? ' · video' : '');
  }
  // slide i of a folder → its file and the page in it (the same as the screen's "it"), from the list of files
  function itemAt(d, i) {
    if (!d || i < 0 || i >= d.total) return null;
    for (var k = 0; k < d.files.length; k++) {
      var f = d.files[k];
      if (f.c && i >= f.from && i < f.from + f.c) return { f: k, n: f.n, k: f.k, p: i - f.from, c: f.c, dur: f.dur, lp: f.lp };
    }
    return null;
  }
  // TasDeckUI(root, {mode: 'host' | 'speaker', client, setLive(id)})
  //   host — every folder: Start (that speaker may now control the screen) / Stop, show, change slides;
  //   speaker — chooses their folder; looks through it any time; once the host has pressed Start, shows it and controls the screen.
  window.TasDeckUI = function (root, opt) {
    var host = opt.mode === 'host', MY = 'tas3d-spk-deck-' + C.room;
    if (!document.getElementById('dk-css')) { var st = el('style'); st.id = 'dk-css'; st.textContent = CSS; document.head.appendChild(st); }
    var cl = opt.client || TasDeckClient(null, { all: host, from: host ? 'host' : 'spk' }), S = cl.state;
    cl.listen(function () { render(); });
    var open = '';
    if (!host) { try { open = localStorage.getItem(MY) || ''; } catch (e) {} cl.watch(open); }
    var pend = null;                                    // the last command, until the screen confirms it: {n, at, i}
    var pixFor = '', pixAt = 0;                          // a slide whose picture is missing here, and since when

    root.innerHTML = '';
    var R = {};
    function add(parent, tag, cls, key, text) { var e = el(tag, cls, text); parent.appendChild(e); if (key) R[key] = e; return e; }
    var wrap = add(root, 'div', 'dk');
    add(wrap, 'p', 'dk-st', 'st');
    var list = add(wrap, 'div', '', 'list');
    add(list, 'p', 'dk-h', 'lh', host ? 'Folders' : 'Choose your folder');
    add(list, 'div', 'dk-items', 'items');
    add(list, 'p', 'dk-empty', 'empty');
    var deck = add(wrap, 'div', '', 'deck');
    var back = add(deck, 'button', 'dk-back', 'back', host ? '← All folders' : '← Not your folder? Choose another');
    back.type = 'button';
    add(deck, 'h2', 'dk-name', 'name');
    var on = add(deck, 'div', 'dk-on', 'on'); add(on, 'b', '', 'onB'); add(on, 'span', '', 'onT');
    var live = add(deck, 'button', 'dk-b dk-live', 'live'); live.type = 'button'; live.hidden = !host;
    // the timer, right under Start: the icon, the time, and for the host what a tap does (Start timer → Stop timer → Reset).
    // The speaker sees the same row in the same place; there it is not a button.
    var tmb = add(deck, host ? 'button' : 'div', 'dk-tm', 'tm'); if (host) tmb.type = 'button';
    tmb.innerHTML = WATCH + '<b>00:00</b><span></span>';
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

    // not the pause folder "Screen" (that is the host's Screen tab); the folder "Host" is the host's own slides:
    // first in the host's list, not in the speakers' list at all
    function decks() {
      if (!S.list) return [];
      var d = S.list.decks.filter(function (x) { return !x.sp && (host || !x.ho); });
      return d.filter(function (x) { return x.ho; }).concat(d.filter(function (x) { return !x.ho; }));
    }
    function find(id) { var d = decks(); for (var i = 0; i < d.length; i++) if (d[i].id === id) return d[i]; return null; }
    function onScreen(id) { return S.cfg.scene === 'slides' && S.cfg.deck === id; }
    function choose(id) {
      open = id; pend = null;
      if (!host) { try { if (id) localStorage.setItem(MY, id); else localStorage.removeItem(MY); } catch (e) {} cl.watch(id); }
      render(); window.scrollTo(0, 0);
    }
    back.addEventListener('click', function () { choose(''); });
    function setLive(id) { if (opt.setLive) opt.setLive(id); }
    function command(op, extra) {
      if (!open || !cl.live()) return;
      var d = find(open), p = S.pv[open], was = pend, to = null;
      // the slide to go to is counted here, from the slide this remote shows (a tap before the screen has confirmed the
      // last one moves on), and the screen is told the number: "slide 7", not "one further". So a tap that is sent
      // twice, or lost while the next one arrives, or reaches two screens, still ends on the same slide everywhere.
      if (p && d && p.total === d.total) {
        var base = was && was.i != null ? was.i : p.i;
        if (op === 'next' && base + 1 < d.total) to = base + 1;
        if (op === 'prev' && base > 0) to = base - 1;
        if (op === 'file' && d.files[extra.f]) to = d.files[extra.f].from;
        if ((op === 'next' || op === 'prev') && to == null) return;   // already at the first / the last slide
      }
      var n = to != null && op !== 'file' ? cl.cmd('go', open, { i: to }) : cl.cmd(op, open, extra);
      pend = { n: n, at: Date.now() };
      [1200, 2500, 4500, 7000].forEach(function (ms) { setTimeout(function () { if (pend && pend.n === n) cl.resend(n); }, ms); });
      // shown at once (the picture of the next slide is already here); the screen confirms in a moment
      if (to != null) pend.i = to;
      render();
    }
    // the host panel asks before anything that changes what the hall sees
    function ask(what, fn) { if (opt.guard) opt.guard(what, fn); else fn(); }
    // a speaker controls the screen only after the host's Start; before that they look through their slides here
    function mayControl(id) { return host || S.cfg.live === id; }
    function stepAllowed(id) { return host || S.cfg.live === id || !onScreen(id); }
    prev.addEventListener('click', function () { command('prev'); });
    next.addEventListener('click', function () { command('next'); });
    play.addEventListener('click', function () { var p = S.pv[open]; command(p && p.v && p.v.play ? 'pause' : 'play'); });
    restart.addEventListener('click', function () { command('restart'); });
    show.addEventListener('click', function () {
      var op = onScreen(open) ? 'hide' : 'show';
      ask(op === 'show' ? 'Show on the screen' : 'Take off the screen', function () { command(op); });
    });
    live.addEventListener('click', function () { setLive(S.cfg.live === open ? '' : open); });
    // the timer does not change what the hall sees: no question
    tmb.addEventListener('click', function () {
      if (!host || !open) return;
      var st = cl.timerOf(open).st;
      cl.timer(st === 'run' ? 'stop' : st === 'stop' ? 'reset' : 'start', open);
      tick();
    });
    // the time on this page (every second while it runs; nothing comes from the network for it)
    function tick() {
      var t = cl.timerOf(open);
      tmb.className = 'dk-tm' + (t.st === 'run' ? ' run' : t.st === 'stop' ? ' stop' : '') + (t.st === 'run' && late(t.ms) ? ' late' : '');
      tmb.querySelector('b').textContent = clock(t.ms);
      tmb.querySelector('span').textContent = host ? (t.st === 'run' ? 'Stop timer' : t.st === 'stop' ? 'Reset' : 'Start timer')
        : (t.st === 'run' ? 'Your talk' : t.st === 'stop' ? 'Stopped' : 'The host starts it');
      if (host) { var tg = R.items.querySelector('.dk-tg.tm'); if (tg) { var tl = cl.timerOf(S.tm.d); tg.lastChild.textContent = clock(tl.ms); tg.classList.toggle('late', tl.st === 'run' && late(tl.ms)); } }
    }
    setInterval(function () { if (S.tm.st === 'run') tick(); }, 250);
    var wasLive = '';
    document.addEventListener('keydown', function (e) {
      if (!open || deck.hidden || root.offsetParent === null || e.metaKey || e.ctrlKey || e.altKey) return;
      var a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
      if (!stepAllowed(open)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); command('next'); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); command('prev'); }
    });

    var shownFiles = '';
    function render() {
      var lv = cl.live(), up = cl.screenOn(), sa = S.sa, L = S.list;
      // the host's Stop (the talk is over): its timer stops too and keeps the time of the talk
      if (host && wasLive && S.cfg.live !== wasLive && S.tm.d === wasLive && S.tm.st === 'run') cl.timer('stop');
      wasLive = S.cfg.live;
      // ---- status
      var msg = '', warn = true;
      if (!cl.up()) msg = 'No connection to the server. Check the internet on this device.';
      else if (!up) msg = host ? 'The screen is off. Open it on the computer at the projector.' : 'The screen is not open yet. The host opens it on the computer at the projector.';
      else if (!sa || Date.now() - S.saAt > 20000) msg = host ? 'The screen cannot show presentations yet: open it with “Open the screen” from this panel (or TAS3D Screen.html), or refresh it.' : 'The screen is not ready for the presentations yet. Tell the host.';
      else if (!sa.f) msg = host
        ? (sa.need === 'reconnect' ? 'On the screen computer: move the mouse, open Settings (bottom right) and press “Allow access”.' : 'On the screen computer: move the mouse, open Settings (bottom right) and connect the folder “TAS3D 2026 Presentations”.')
        : 'The presentations folder is not open on the screen computer yet. Tell the host.';
      else if (host && sa.fc === 0) msg = 'Another window is in front on the screen computer. Click once on the screen there: until then the clicker and the keys do nothing.';
      else if (host && sa.ua && !/^(Chrome|Edge|Opera|Yandex) /.test(sa.ua)) msg = 'The screen is open in ' + sa.ua + '. Open it in Google Chrome there: in other browsers videos stop in the background and sound needs a click for every video.';
      else if (host && cl.screens() > 1) msg = cl.screens() + ' screen pages are open (two tabs, or a second computer). They follow each other, but close the ones you do not need.';
      else { warn = false; msg = host ? 'Folder on the screen computer: ' + (sa.folder || '') + ' · ' + decks().length + (decks().length === 1 ? ' folder' : ' folders') + (sa.ua ? ' · ' + sa.ua : '') : ''; }
      R.st.textContent = msg; R.st.hidden = !msg; R.st.classList.toggle('warn', warn);
      if (host) cl.next([open, S.cfg.scene === 'slides' ? S.cfg.deck : '']);   // their next slides' pictures are needed too

      var d = open ? find(open) : null;
      if (open && !d && L) { open = ''; if (!host) { try { localStorage.removeItem(MY); } catch (e) {} cl.watch(''); } }
      R.list.hidden = !!open; R.deck.hidden = !open;
      if (!open) return renderList(lv);
      renderDeck(d, lv);
    }
    function renderList(lv) {
      var ds = decks(), box = R.items;
      var sig = JSON.stringify([ds.map(function (d) { return [d.id, d.name, d.total, d.files.length, d.ho]; }), S.cfg.scene === 'slides' ? S.cfg.deck : '', S.cfg.live, host ? [S.tm.d, S.tm.st] : 0]);
      R.empty.textContent = !S.list ? 'Waiting for the list of folders from the screen…' : ds.length ? '' : 'The folder on the screen computer has no speakers’ folders yet.';
      if (box.getAttribute('data-s') !== sig) {
        box.setAttribute('data-s', sig); box.innerHTML = '';
        ds.forEach(function (d) {
          var row = el('div', 'dk-row' + (S.cfg.live === d.id ? ' lv' : '')); row.setAttribute('data-id', d.id);
          var b = el('button', 'dk-it' + (host ? '' : ' nth')); b.type = 'button';
          b.appendChild(el('span', 'th'));
          var tx = el('span'); tx.appendChild(el('span', 'nm', d.name));
          var bad = d.files.filter(function (f) { return f.k === 'bad'; }).length, ok = d.files.length - bad;
          tx.appendChild(el('span', 'sb', !d.files.length ? 'No files yet' : ok + (ok === 1 ? ' file' : ' files') + ' · ' + d.total + (d.total === 1 ? ' slide' : ' slides') + (bad ? ' · ' + bad + ' cannot be shown' : '')));
          if (d.ho) tx.appendChild(el('span', 'dk-tg', 'Only you'));
          if (S.cfg.live === d.id) tx.appendChild(el('span', 'dk-tg o', host ? 'Presenting' : 'Your talk is on'));
          if (onScreen(d.id)) tx.appendChild(el('span', 'dk-tg', 'On the screen'));
          if (host && S.tm.d === d.id && S.tm.st !== 'off') { var tg = el('span', 'dk-tg tm'); tg.innerHTML = '<svg style="width:11px;height:11px;vertical-align:-1px;margin-right:4px" ' + WATCH.slice(4); tg.appendChild(document.createTextNode(clock(cl.timerOf(d.id).ms))); tx.appendChild(tg); }
          b.appendChild(tx);
          b.addEventListener('click', function () { choose(d.id); });
          row.appendChild(b);
          if (host && !d.ho) {
            var isLive = S.cfg.live === d.id, sb = el('button', 'dk-b sm' + (isLive ? '' : ' o'), isLive ? 'Stop' : 'Start'); sb.type = 'button';
            sb.addEventListener('click', function () { setLive(isLive ? '' : d.id); });
            row.appendChild(sb);
          } else row.appendChild(el('span', 'dk-go', '›'));
          box.appendChild(row);
        });
      }
      if (host) box.querySelectorAll('.dk-row').forEach(function (r) {   // small previews of where each speaker is
        var id = r.getAttribute('data-id'), p = S.pv[id], th = r.querySelector('.th'), src = p ? cl.pic(id, p.total, p.i) : '';
        if (th.getAttribute('data-u') !== src) { th.setAttribute('data-u', src); th.style.backgroundImage = src ? 'url("' + src + '")' : ''; }
      });
    }
    function renderDeck(d, lv) {
      var p = S.pv[open] || null, isOn = onScreen(open), isLive = S.cfg.live === open, ctl = mayControl(open);
      if (pend && (Date.now() - pend.at > 10000 || (p && p.ack === pend.n))) pend = null;
      R.name.textContent = d ? d.name : 'Loading…';
      // ---- who controls what
      var onB, onT;
      if (host) {
        onB = isLive ? 'Presenting · the speaker controls the screen' : isOn ? 'On the screen now' : 'Not on the screen';
        onT = '';
      } else if (isLive) {
        onB = isOn ? 'Your slides are on the screen' : 'Your talk is on · you have the screen';
        onT = isOn ? 'Change the slides with ← →. When you finish: “Take off the screen” (the screen goes black).' : 'Press “Show on the screen” when you are ready.';
      } else {
        onB = isOn ? 'On the screen · the host controls it' : 'Waiting for the host';
        onT = isOn ? 'The host is showing your slides.' : 'You can look through your slides here. When the host starts your talk, you can put them on the screen.';
      }
      R.onB.textContent = onB; R.onT.textContent = onT;
      R.on.classList.toggle('hot', isLive || (host && isOn));
      // ---- host: Start / Stop
      live.hidden = !host || !!(d && d.ho);            // the host's own folder: no Start / Stop, just show it
      tmb.hidden = host ? live.hidden : false; tick();
      if (host) {
        var other = S.cfg.live && S.cfg.live !== open ? find(S.cfg.live) : null;
        live.textContent = isLive ? 'Stop · the screen goes black' : other ? 'Start · instead of ' + other.name : 'Start · give this speaker the screen';
        live.className = 'dk-b dk-live' + (isLive ? '' : ' o');
      }
      // ---- preview
      var total = d ? d.total : 0, i = pend && pend.i != null ? pend.i : p ? p.i : 0;
      var fits = !!(p && d && p.total === total);       // not a state left from before the folder changed
      if (i > total - 1) i = Math.max(0, total - 1);
      var src = cl.pic(open, total, i);
      // no picture of this slide here (a broker lost it, or this phone was away): ask the screen for it, at most every 4 s
      if (!src && total && lv && fits && !pend) {
        var pk = open + '|' + i;
        if (pixFor !== pk) { pixFor = pk; pixAt = Date.now(); }
        else if (Date.now() - pixAt > 2500) { pixAt = Date.now() + 1500; cl.cmd('pix', open); }
      } else if (src) pixFor = '';
      var it = itemAt(d, i) || (fits && !pend ? p.it : null);
      if (src) { if (cur.getAttribute('src') !== src) cur.setAttribute('src', src); cur.hidden = false; } else cur.hidden = true;
      R.ph.textContent = src ? '' : !d ? '' : !total ? 'No slides in this folder yet.' : 'Slide ' + (i + 1) + ' · its picture is coming…';
      R.pv.classList.toggle('wait', !!pend);
      R.tag.textContent = it && it.k === 'vid' ? 'Video' + (it.dur ? ' · ' + mmss(it.dur) : '') + (it.lp ? ' · loop' : '') + (p && p.v && !pend ? (p.v.play ? ' · playing' : p.v.end ? ' · ended' : ' · paused') : '') : '';
      R.posN.textContent = total ? (i + 1) + ' / ' + total : '';
      R.posW.textContent = what(it);
      var can = lv && !!d && total > 0, step = can && stepAllowed(open);
      prev.disabled = !step || i <= 0; next.disabled = !step || i >= total - 1;
      var vid = !!(it && it.k === 'vid');
      R.vc.hidden = !vid;
      play.textContent = p && p.v && p.v.play ? 'Pause video' : 'Play video';
      play.disabled = restart.disabled = !can || !isOn || !ctl;
      // ---- show / take off: the host any time, a speaker after Start
      show.hidden = !ctl;
      show.textContent = isOn ? 'Take off the screen' : 'Show on the screen';
      show.className = 'dk-b dk-show' + (isOn ? '' : ' o');
      show.disabled = !can;
      var note = '';
      if (vid && !isOn) note = 'The video plays when the slides are on the screen.';
      else if (p && p.v && p.v.mute && isOn) note = 'The video plays without sound: someone has to click once on the screen computer.';
      R.note.textContent = note;
      // ---- next
      var nxi = itemAt(d, i + 1);
      R.nx.hidden = !d || !total;
      var nsrc = cl.pic(open, total, i + 1);
      R.nxt.style.backgroundImage = nsrc && i + 1 < total ? 'url("' + nsrc + '")' : '';
      nxp.innerHTML = '';
      nxp.appendChild(el('b', '', 'Next'));
      nxp.appendChild(document.createTextNode(i + 1 >= total ? 'This is the last slide.' : nxi ? what(nxi) : ''));
      // ---- files
      var fsig = JSON.stringify([d && d.files, it && it.f]);
      if (fsig !== shownFiles) {
        shownFiles = fsig; R.files.innerHTML = '';
        (d ? d.files : []).forEach(function (f, k) {
          var li = el('li', it && it.f === k ? 'cur' : ''), b = el('button'); b.type = 'button';
          b.appendChild(el('span', 'i', String(k + 1))); b.appendChild(el('span', 'n', f.n)); b.appendChild(el('span', 'c', count(f)));
          if (f.w) b.appendChild(el('span', 'w', f.w));
          if (f.k === 'bad' || !f.c) b.disabled = true;
          else { b.setAttribute('data-ok', '1'); b.addEventListener('click', function () { if (onScreen(open)) ask('Go to “' + f.n + '”', function () { command('file', { f: k }); }); else command('file', { f: k }); }); }
          li.appendChild(b); R.files.appendChild(li);
        });
        if (d && !d.files.length) { var li0 = el('li'); li0.appendChild(el('p', 'dk-empty', 'No files yet. PDF, pictures (JPG, PNG) and videos (MP4) go into this folder on the screen computer.')); R.files.appendChild(li0); }
      }
      R.files.querySelectorAll('button[data-ok]').forEach(function (b) { b.disabled = !step; });
    }
    render();
    return { client: cl, open: choose, render: render };
  };
})();

// TAS3D 2026 — the host side, shared by host/ (the host panel) and screen/ (the projector).
// Keeps the live picture from the MQTT brokers: check-ins of the current round, questions, the poll and its votes,
// the question shown over the slides, reactions. The host panel also changes it (Reset, polls, questions).
// Needs config.js and mqtt.js. Usage: var hub = TasHub(onChange, {onReact}); hub.state ...; hub.reset() ...
(function () {
  var C = window.TAS3D_CHECKIN;

  // ---------- password (only its salted hash is in config.js) ----------
  var AUTH = 'tas3d-host-' + C.room;
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function unhex(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function readAuth() { try { return JSON.parse(localStorage.getItem(AUTH) || 'null'); } catch (e) { return null; } }
  window.TasAuth = {
    // logged in: the right password was typed on this device, and (since the presentations) the slides key came with it
    ok: function () {
      var a = readAuth();
      return !!(a && a.h === C.host.hash && a.until > Date.now() && (!C.slides || /^[0-9a-f]{64}$/.test(a.k || '')));
    },
    check: function (pass) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This browser cannot check the password here.'));
      return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (key) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(C.host.salt), iterations: C.host.iterations }, key, 256);
      }).then(function (bits) {
        if (hex(bits) !== C.host.hash) return false;
        // the same password opens the slides key (deck.js)
        return (C.slides && window.TasSlidesKey ? TasSlidesKey.fromHost(pass) : Promise.resolve('')).then(function (k) { TasAuth.keep(k); return true; });
      });
    },
    // the login is kept on this device for 90 days (and renewed every time a host page opens), so closing a tab does not log out
    keep: function (k) {
      var a = readAuth(), keep = k || (a && a.h === C.host.hash ? a.k : '');
      try { localStorage.setItem(AUTH, JSON.stringify({ h: C.host.hash, until: Date.now() + 90 * 24 * 3600 * 1000, k: keep || undefined })); } catch (e) {}
    },
    logout: function () { try { localStorage.removeItem(AUTH); } catch (e) {} },
    // shows the password form (#login) until the right password is typed, then calls go()
    gate: function (go) {
      var form = document.getElementById('login');
      if (TasAuth.ok()) { TasAuth.keep(); form.hidden = true; return go(); }
      form.hidden = false;
      var input = form.querySelector('input'), err = form.querySelector('.err'), btn = form.querySelector('button');
      var was = readAuth();                            // logged in before the presentations were added: one more time
      if (was && was.h === C.host.hash && was.until > Date.now()) err.textContent = 'Please enter the password once more: it now opens the presentations too.';
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!input.value) return;
        btn.disabled = true; err.textContent = '';
        TasAuth.check(input.value).then(function (good) {
          btn.disabled = false;
          if (good) { form.hidden = true; input.value = ''; go(); }
          else { err.textContent = 'Wrong password.'; input.select(); }
        }, function (x) { btn.disabled = false; err.textContent = x.message; });
      });
    }
  };

  // ---------- the hub ----------
  window.TasHub = function (onChange, opt) {
    opt = opt || {};
    var B = C.base, ROLE = {}, KEY = 'tas3d-live2-' + C.room;
    C.roles.forEach(function (r) { ROLE[r[0]] = 1; });
    var S = {
      db: { seen: {}, round: '0', at: 0 },   // check-ins of the current round: phone id -> {r, t}
      qs: {},                                // questions: id -> {q, t, g}
      done: {},                              // questions removed here
      show: '',                              // the question shown over the slides
      now: null,                             // the current poll {k, id, q, o, open, at}
      votes: {},                             // phone id -> {o, t} for the current poll (= ph[current].votes)
      ph: {},                                // every poll of this round: id -> {id, q, o, votes, n, total, at}; kept until Reset
      rx: {},                                // reactions since this page was opened
      cfg: { scene: 'checkin', qr: true, rx: true, deck: '', live: '', at: 0, w: '' },   // what the screen shows, set by the host
      total: 0, counts: {}, pollCounts: [], pollTotal: 0,
      game: { id: '', st: 'off', target: 0, per: 0, at: 0, w: '' },   // the opening game (host)
      gs: null,                              // its score: {id, total, target, roles, players, np, ms} (from the screen)
      screenSeen: 0,                         // when a screen page last said "I am on" (time of this device)
      screenBuild: ''                        // which version of the site that screen runs
    };
    C.reactions.forEach(function (r) { S.rx[r[0]] = 0; });
    try { var sv = JSON.parse(localStorage.getItem(KEY) || 'null'); if (sv && sv.seen && typeof sv.round === 'string') S.db = sv; } catch (e) {}
    try { var dn = JSON.parse(localStorage.getItem(KEY + '-done') || 'null'); if (dn) S.done = dn; } catch (e) {}
    // everything of this round is kept on this device too (until Reset): a server that loses something gets it back from here
    try { var kq = JSON.parse(localStorage.getItem(KEY + '-qs') || 'null'); if (kq && kq.g === S.db.round && kq.qs) S.qs = kq.qs; } catch (e) {}
    try { var kp = JSON.parse(localStorage.getItem(KEY + '-ph') || 'null'); if (kp && kp.g === S.db.round && kp.ph) S.ph = kp.ph; } catch (e) {}

    var changeT = null;
    function changed() { if (!changeT) changeT = setTimeout(function () { changeT = null; onChange(S); }, 30); }
    var storeT = null;
    function store() { if (!storeT) storeT = setTimeout(storeNow, 400); }
    function storeNow() {
      storeT = null;
      try {
        localStorage.setItem(KEY, JSON.stringify(S.db)); localStorage.setItem(KEY + '-done', JSON.stringify(S.done));
        localStorage.setItem(KEY + '-qs', JSON.stringify({ g: S.db.round, qs: S.qs }));
        localStorage.setItem(KEY + '-ph', JSON.stringify({ g: S.db.round, ph: S.ph }));
      } catch (e) {}
    }
    window.addEventListener('pagehide', function () { if (storeT) { clearTimeout(storeT); storeNow(); } });

    // ---- connections to every broker, each reconnects by itself
    var links = [];
    function subsFor(c) {
      c.subscribe(B + '/r', 1); c.subscribe(B + '/c/+', 1); c.subscribe(B + '/q/+', 1);
      c.subscribe(B + '/show', 1); c.subscribe(B + '/now', 1); c.subscribe(B + '/cfg', 1); c.subscribe(B + '/x'); c.subscribe(B + '/scr'); c.subscribe(B + '/ph', 1);
      c.subscribe(B + '/game', 1); c.subscribe(B + '/gs', 1);
      if (opt.screen && S.game.id && S.game.st !== 'off') c.subscribe(B + '/gt/' + S.game.id + '/+');
      if (S.now && S.now.k === 'poll') c.subscribe(B + '/v/' + S.now.id + '/+', 1);
    }
    C.brokers.forEach(function (url) {
      var L = { c: null, wait: 2000, r: -1 };
      function open() {
        var c = new TasMQ(url, {
          onConnect: function () {
            L.wait = 2000; L.r = -1; L.got = {}; subsFor(c); changed(); pushStats(); pushPR();
            setTimeout(function () { heal(L); }, 9000);    // after the round check below
            // a broker that missed the last Reset learns about it now — only a round this page knows to be newer,
            // and only after waiting long enough for the broker's own (slow network: never overwrite a newer one)
            setTimeout(function () { if (c.ok && S.db.at > 0 && L.r !== -1 && L.r < S.db.at) pushRound(L); }, 3000);
            setTimeout(function () { if (c.ok && S.db.at > 0 && L.r === -1) pushRound(L); }, 8000);
          },
          onMessage: function (t, x) { onMsg(t, x, L); },
          onClose: function () { changed(); setTimeout(open, L.wait); L.wait = Math.min(L.wait * 2, 30000); }
        });
        L.c = c; c.connect();
      }
      open(); links.push(L);
    });
    function up() { return links.filter(function (L) { return L.c && L.c.ok; }).length; }
    // ---- nothing gets lost until Reset: every 5 minutes (and after each connect) compare what a server keeps with what
    // this device knows, and put back what the server lost (check-ins, questions, votes of the current poll)
    function audit(L) {
      if (!L.c || !L.c.ok) return;
      L.got = {};
      L.c.subscribe(B + '/c/+', 1); L.c.subscribe(B + '/q/+', 1);       // subscribing again: the server sends everything it keeps
      ['/cfg', '/now', '/show', '/game', '/ph'].forEach(function (k) { L.c.subscribe(B + k, 1); });
      if (S.now && S.now.k === 'poll') L.c.subscribe(B + '/v/' + S.now.id + '/+', 1);
      setTimeout(function () { heal(L); }, 6000);
    }
    function heal(L) {
      var got = L.got; L.got = null;
      if (!got || !L.c || !L.c.ok || !S.db.at || L.r !== S.db.at) return;   // only on a server that is in this round
      var g = S.db.round, n = 0;
      function put(t, o) { if (got[t]) return; n++; L.c.publish(t, JSON.stringify(o), { qos: 1, retain: true }).catch(function () {}); }
      for (var id in S.db.seen) put(B + '/c/' + id, { r: S.db.seen[id].r, t: S.db.seen[id].t, g: g });
      for (var q in S.qs) if (!S.done[q] && S.qs[q].g === g) put(B + '/q/' + q, { q: S.qs[q].q, t: S.qs[q].t, g: g });
      if (S.now && S.now.k === 'poll') for (var dv in S.votes) put(B + '/v/' + S.now.id + '/' + dv, { o: S.votes[dv].o, t: S.votes[dv].t, g: g });
      // and what the screen shows, the poll, the game, the earlier polls
      if (S.cfg.at) put(B + '/cfg', cfgOut());
      if (S.now && S.now.at) put(B + '/now', S.now.k === 'poll' ? { k: 'poll', id: S.now.id, q: S.now.q, o: S.now.o, open: S.now.open, at: S.now.at } : { k: 'none', at: S.now.at });
      if (S.game.at) put(B + '/game', S.game);
      if (Object.keys(S.ph).length && !got[B + '/ph']) { n++; L.c.publish(B + '/ph', phText(), { qos: 1, retain: true }).catch(function () {}); }
      if (S.show && !got[B + '/show']) { n++; L.c.publish(B + '/show', S.show, { qos: 1, retain: true }).catch(function () {}); }
      S.healed = (S.healed || 0) + n;
    }
    setInterval(function () { links.forEach(function (L, i) { setTimeout(function () { audit(L); }, i * 20000); }); }, 300000 + Math.random() * 30000);
    function pub(topic, text, o) { links.forEach(function (L) { if (L.c && L.c.ok) L.c.publish(topic, text, o || {}).catch(function () {}); }); }
    function pushRound(L) { L.c.publish(B + '/r', JSON.stringify({ id: S.db.round, at: S.db.at }), { qos: 1, retain: true }).catch(function () {}); L.r = Math.max(L.r, S.db.at); }

    // ---- incoming
    function json(x) { try { return JSON.parse(x); } catch (e) { return null; } }
    function onMsg(t, x, L) {
      if (t === B + '/x') return onReact(x);
      if (L.got && x) L.got[t] = 1;                     // what this server keeps (see heal)
      if (t === B + '/ph') return onPH(x);
      if (t === B + '/game') return onGame(x);
      if (t === B + '/gs') { if (!opt.screen) { var gd = json(x); if (gd && gd.id === S.game.id) { S.gs = gd; changed(); } } return; }
      if (t.indexOf(B + '/gt/') === 0) { var gp = t.slice(B.length + 4).split('/'); return onTap(gp[0], gp[1], x); }
      if (t.indexOf(B + '/c/') === 0) return onAnswer(t.slice(B.length + 3), x);
      if (t.indexOf(B + '/q/') === 0) return onQuestion(t.slice(B.length + 3), x);
      if (t.indexOf(B + '/v/') === 0) { var p = t.slice(B.length + 3).split('/'); return onVote(p[0], p[1], x); }
      if (t === B + '/show') { if (x !== S.show) { S.show = x; changed(); } return; }
      if (t === B + '/now') return onNow(x);
      if (t === B + '/cfg') return onCfg(x);
      if (t === B + '/scr') { S.screenSeen = Date.now(); S.screenBuild = String(x || ''); return changed(); }
      if (t === B + '/r') {
        var d = json(x); if (!d) return;
        var at = +d.at || 0, id = d.id != null ? String(d.id) : String(at);
        L.r = Math.max(L.r, at);
        if (at > S.db.at) {
          S.db = { seen: {}, round: id, at: at }; S.votes = {}; S.ph = {}; S.qs = {}; S.done = {}; recount(); recountPoll();
          links.forEach(function (x2) { if (x2.c && x2.c.ok) x2.c.subscribe(B + '/c/+', 1); });   // ask again for the kept answers
        }
      }
    }
    var SCENES = { blank: 1, logo: 1, qr: 1, checkin: 1, poll: 1, slides: 1, game: 1 };
    // the same reaction can come through both servers (they pass messages to each other): count it once
    var seenRx = {}, seenRxList = [];
    function firstTime(id) {
      if (!id) return true;
      if (seenRx[id]) return false;
      seenRx[id] = 1; seenRxList.push(id);
      if (seenRxList.length > 600) delete seenRx[seenRxList.shift()];
      return true;
    }
    function idOk(x) { return typeof x === 'string' && /^[a-z0-9]{1,40}$/.test(x); }
    // who wrote a setting: when two changes have the same time, the same one wins on every device
    var WID = Math.random().toString(36).slice(2, 10), fixT = 0;
    function cfgOut() { return { scene: S.cfg.scene, qr: S.cfg.qr, rx: S.cfg.rx, deck: S.cfg.deck, live: S.cfg.live, at: S.cfg.at, w: S.cfg.w }; }
    function onCfg(x) {
      var d = json(x); if (!d) return;
      var at = +d.at || 0, w = String(d.w || '');
      if (at < S.cfg.at || (at === S.cfg.at && w < S.cfg.w)) {
        // an older state: a server that missed a change, or two changes at the same moment (host and screen).
        // Put the newest back on the servers, so every device (and every one that opens later) shows the same.
        if (S.cfg.at > 0) { clearTimeout(fixT); fixT = setTimeout(function () { pub(B + '/cfg', JSON.stringify(cfgOut()), { qos: 1, retain: true }); }, 600 + Math.random() * 600); }
        return;
      }
      S.cfg = { scene: SCENES[d.scene] ? d.scene : 'checkin', qr: d.qr !== false, rx: d.rx !== false,
        deck: idOk(d.deck) ? d.deck : '', live: idOk(d.live) ? d.live : '', at: at, w: w };
      changed();
    }
    function onReact(x) {
      if (!S.cfg.rx) return;                           // reactions are switched off by the host
      var m0 = /^#([a-z0-9]{6,60})(,|$)/.exec(x);       // "#<id>,fire:2,clap:1"
      if (!firstTime(m0 && m0[1])) return;
      String(x).split(',').forEach(function (p) {
        var m = /^([a-z][a-z0-9]*):(\d+)$/.exec(p.trim());
        if (m && S.rx.hasOwnProperty(m[1])) S.rx[m[1]] += Math.min(+m[2], 5);
      });
      if (opt.onReact) opt.onReact(x);
      changed();
    }
    function onAnswer(id, x) {
      if (!/^[a-z0-9]{12,40}$/.test(id) || !x) return;
      var d = json(x);
      if (!d || !ROLE[d.r] || typeof d.t !== 'number') return;
      if ((d.g == null ? '0' : String(d.g)) !== S.db.round) return;
      var old = S.db.seen[id];
      if (old && (old.t > d.t || (old.r === d.r && old.t === d.t))) return;
      S.db.seen[id] = { r: d.r, t: d.t };
      recount();
    }
    function onQuestion(id, x) {
      if (!/^[a-z0-9]{12,60}$/.test(id)) return;
      if (!x) { delete S.qs[id]; store(); return changed(); }
      var d = json(x);
      if (!d || typeof d.q !== 'string' || !d.q.trim()) return;
      S.qs[id] = { q: d.q.slice(0, 280), t: +d.t || Date.now(), g: d.g == null ? '0' : String(d.g) };
      store(); changed();
    }
    function onNow(x) {
      var d = json(x) || { k: 'none', at: 0 };
      var at = +d.at || 0;
      if (S.now && at < S.now.at) return;              // an older state from a broker that missed a change
      if (d.k === 'poll' && d.id && Array.isArray(d.o)) {
        var pid = String(d.id), q = String(d.q || ''), o = d.o.map(String).slice(0, 6);
        if (!S.ph[pid]) S.ph[pid] = { id: pid, q: q, o: o, votes: {}, n: o.map(function () { return 0; }), total: 0, at: at };
        if (!S.ph[pid].votes) S.ph[pid].votes = {};
        if (!S.now || S.now.id !== pid) {
          links.forEach(function (L) { if (L.c && L.c.ok) L.c.subscribe(B + '/v/' + pid + '/+', 1); });
        }
        S.votes = S.ph[pid].votes;                     // the votes of earlier polls stay in S.ph
        S.now = { k: 'poll', id: pid, q: q, o: o, open: !!d.open, at: at };
      } else { S.now = { k: 'none', at: at }; S.votes = {}; }
      recountPoll();
    }
    // ---- the opening game
    var G = { id: '', ph: {}, t0: 0, ms: 0 }, GK = KEY + '-game', gsT = null, gsLast = '', gsAt = 0, gfixT = 0;
    if (opt.screen) { try { var kg = JSON.parse(localStorage.getItem(GK) || 'null'); if (kg && kg.id) G = kg; } catch (e) {} }
    function onGame(x) {
      var d = json(x); if (!d) return;
      var at = +d.at || 0, w = String(d.w || '');
      if (at < S.game.at || (at === S.game.at && w < S.game.w)) {
        if (S.game.at > 0) { clearTimeout(gfixT); gfixT = setTimeout(function () { pub(B + '/game', JSON.stringify(S.game), { qos: 1, retain: true }); }, 600 + Math.random() * 600); }
        return;
      }
      var was = S.game;
      S.game = { id: /^[a-z0-9]{1,30}$/.test(d.id || '') ? d.id : '', st: /^(off|ready|run|done)$/.test(d.st) ? d.st : 'off', target: Math.max(0, +d.target || 0), per: +d.per || 0, at: at, w: w };
      if (S.game.id !== was.id) S.gs = null;
      if (opt.screen) gameScreen(was);
      changed();
    }
    // the screen: listens to the taps of this game and keeps the score (also over a reload)
    function gameScreen(was) {
      var g = S.game;
      if (g.id !== G.id) { G = { id: g.id, ph: {}, t0: 0, ms: 0 }; }
      if (g.id && g.st !== 'off' && (g.id !== was.id || was.st === 'off')) links.forEach(function (L) { if (L.c && L.c.ok) L.c.subscribe(B + '/gt/' + g.id + '/+'); });
      if (g.st === 'run' && !G.t0) G.t0 = Date.now() + 3000;      // the phones count down 3, 2, 1 first
      if (g.st === 'done' && !G.ms && G.t0) G.ms = Math.max(0, Date.now() - G.t0);
      gameScore();
      if (g.st !== (was.st || '') || g.id !== was.id) { gsLast = ''; pushGS(); }   // start / done: the phones hear it at once
    }
    function onTap(gid, dev, x) {
      if (!opt.screen || gid !== G.id || S.game.st === 'off' || !/^[a-z0-9]{12,40}$/.test(dev || '')) return;
      var m = /^([a-z]+):(\d{1,7})$/.exec(String(x || '')); if (!m || !ROLE[m[1]]) return;
      var n = +m[2], old = G.ph[dev];
      if (S.game.st === 'done' && old) return;           // the picture is rendered: the score stays
      if (G.t0) n = Math.min(n, Math.max(0, Math.round((Date.now() - G.t0) / 1000 * C.game.cap)) + 30);   // no auto-clickers
      if (old && old.n >= n) return;
      G.ph[dev] = { r: m[1], n: n };
      gameScore();
    }
    function gameScore() {
      var roles = {}, players = {}, total = 0, np = 0;
      for (var d in G.ph) { var p = G.ph[d]; roles[p.r] = (roles[p.r] || 0) + p.n; players[p.r] = (players[p.r] || 0) + 1; total += p.n; np++; }
      S.gs = { id: G.id, total: total, target: S.game.target, roles: roles, players: players, np: np, ms: G.ms, st: S.game.st, t: Date.now() };
      if (S.game.st === 'run' && S.game.target && total >= S.game.target) api.setGame({ st: 'done' });   // rendered!
      schedGS();
      changed();
    }
    // the score goes out at most every 2 s: every phone in the hall receives it, so each extra send is N messages.
    // pushGS always takes the pending timer down with it, so direct calls cannot pile up extra timer chains.
    function schedGS() { if (!gsT) gsT = setTimeout(pushGS, Math.max(250, gsAt + 2000 - Date.now())); }
    function pushGS() {
      clearTimeout(gsT); gsT = null; gsAt = Date.now();
      if (!opt.screen || !G.id || !S.gs) return;
      try { localStorage.setItem(GK, JSON.stringify(G)); } catch (e) {}
      var o = { id: G.id, total: S.gs.total, target: S.game.target, roles: S.gs.roles, players: S.gs.players, np: S.gs.np, ms: G.ms, st: S.game.st };
      var txt = JSON.stringify(o); if (txt === gsLast) return; gsLast = txt;
      pub(B + '/gs', txt, { retain: true });
    }
    if (opt.screen) setInterval(function () { if (G.id && S.game.st === 'run' && Date.now() - gsAt > 2500) { gsLast = ''; pushGS(); } }, 3000);

    // the polls of this round with their results (kept on the servers too, so a new device sees them)
    function onPH(x) {
      var d = json(x); if (!d || String(d.g) !== S.db.round || !Array.isArray(d.polls)) return;
      var ch = false;
      d.polls.forEach(function (p) {
        if (!p || typeof p.id !== 'string' || !Array.isArray(p.o) || !Array.isArray(p.n)) return;
        var mine = S.ph[p.id];
        if (!mine) { S.ph[p.id] = { id: p.id, q: String(p.q || ''), o: p.o.map(String).slice(0, 6), votes: {}, n: p.n.map(Number), total: +p.total || 0, at: +p.at || 0 }; ch = true; }
        else if (!Object.keys(mine.votes || {}).length && (+p.total || 0) > mine.total) { mine.n = p.n.map(Number); mine.total = +p.total || 0; ch = true; }
      });
      if (ch) { store(); changed(); }
    }
    function onVote(pid, dev, x) {
      if (!S.now || S.now.k !== 'poll' || pid !== S.now.id || !/^[a-z0-9]{12,40}$/.test(dev || '')) return;
      if (!x) { delete S.votes[dev]; return recountPoll(); }
      var d = json(x);
      if (!d || typeof d.o !== 'number' || d.o < 0 || d.o >= S.now.o.length) return;
      if ((d.g == null ? '0' : String(d.g)) !== S.db.round) return;
      var old = S.votes[dev];
      if (old && old.t >= d.t) return;
      S.votes[dev] = { o: d.o, t: +d.t || 0 };
      recountPoll();
    }

    // ---- counting
    var statT = null, prT = null, phT = null;
    function recount() {
      var c = {}, total = 0;
      for (var id in S.db.seen) { var r = S.db.seen[id].r; c[r] = (c[r] || 0) + 1; total++; }
      S.counts = c; S.total = total;
      store();
      if (!statT) statT = setTimeout(pushStats, 2000);
      changed();
    }
    function recountPoll() {
      var n = [], total = 0;
      if (S.now && S.now.k === 'poll') {
        n = S.now.o.map(function () { return 0; });
        for (var d in S.votes) { n[S.votes[d].o]++; total++; }
      }
      S.pollCounts = n; S.pollTotal = total;
      if (S.now && S.now.k === 'poll' && S.ph[S.now.id] && (total || !S.ph[S.now.id].total)) { S.ph[S.now.id].n = n; S.ph[S.now.id].total = total; }
      if (!prT) prT = setTimeout(pushPR, 1500);
      if (!phT) phT = setTimeout(pushPH, 1500);
      store(); changed();
    }
    // the total and the poll results also go to every phone, so only one device sends them:
    // the screen while it is on (its heartbeat is fresh), otherwise the host panel.
    function otherSends() { return !opt.screen && S.screenSeen && Date.now() - S.screenSeen < 20000; }
    function pushStats() { statT = null; if (otherSends()) return; pub(B + '/s', JSON.stringify({ n: S.total, g: S.db.round, t: Date.now() }), { retain: true }); }
    function phText() { return JSON.stringify({ g: S.db.round, polls: Object.keys(S.ph).map(function (k) { var p = S.ph[k]; return { id: p.id, q: p.q, o: p.o, n: p.n, total: p.total, at: p.at }; }) }); }
    function pushPH() { phT = null; if (Object.keys(S.ph).length) pub(B + '/ph', phText(), { qos: 1, retain: true }); }
    function pushPR() {
      prT = null;
      if (otherSends()) return;
      if (!S.now || S.now.k !== 'poll') return;
      pub(B + '/pr', JSON.stringify({ id: S.now.id, n: S.pollCounts, total: S.pollTotal, t: Date.now() }), { retain: true });
    }
    recount();

    // ---- actions (host panel)
    function rid() { return Math.random().toString(36).slice(2, 10); }
    function setNow(n) {
      n.at = Math.max(Date.now(), (S.now ? S.now.at : 0) + 1);
      pub(B + '/now', JSON.stringify(n), { qos: 1, retain: true });
      onNow(JSON.stringify(n));
    }
    function clearVotes() {                          // Reset only: the votes of every poll of the round leave the servers
      Object.keys(S.ph).forEach(function (pid) { Object.keys(S.ph[pid].votes || {}).forEach(function (dev) { pub(B + '/v/' + pid + '/' + dev, '', { retain: true }); }); });
    }
    var api = {
      state: S,
      up: up,
      links: links.length,
      // Reset: a new round — check-ins, questions, the poll and the question on the screen start from zero; phones go back to check-in
      reset: function () {
        var ids = Object.keys(S.db.seen);
        clearVotes();
        Object.keys(S.qs).forEach(function (id) { pub(B + '/q/' + id, '', { retain: true }); });
        ids.forEach(function (id) { pub(B + '/c/' + id, '', { retain: true }); });
        S.db = { seen: {}, round: rid(), at: Date.now() };
        S.qs = {}; S.done = {}; S.votes = {}; S.ph = {};
        pub(B + '/ph', JSON.stringify({ g: S.db.round, polls: [] }), { qos: 1, retain: true });
        links.forEach(function (L) { if (L.c && L.c.ok) pushRound(L); });
        pub(B + '/show', '', { qos: 1, retain: true }); S.show = '';
        setNow({ k: 'none' });
        if (S.cfg.scene === 'poll' || S.cfg.scene === 'game') api.setCfg({ scene: 'checkin' });
        if (S.game.st !== 'off') api.setGame({ st: 'off' });
        clearTimeout(statT); statT = null;
        recount(); pushStats(); storeNow();
      },
      startPoll: function (q, o) {                    // the earlier poll and its votes stay (Earlier polls in the panel)
        setNow({ k: 'poll', id: 'p' + rid(), q: q, o: o, open: true });
        api.setCfg({ scene: 'poll' });                 // the screen shows the results right away
      },
      // ---- the opening game (host): Show the game → Start rendering → (done by itself at 100%, or Finish now) → Close
      setGame: function (p) {
        var n = { id: S.game.id, st: S.game.st, target: S.game.target, per: S.game.per };
        for (var k in p) n[k] = p[k];
        n.at = Math.max(Date.now(), S.game.at + 1); n.w = WID;
        pub(B + '/game', JSON.stringify(n), { qos: 1, retain: true });
        onGame(JSON.stringify(n));
      },
      newGame: function (per) { api.setGame({ id: 'g' + rid(), st: 'ready', target: 0, per: per }); api.setCfg({ scene: 'game' }); },
      startGame: function () {
        var per = S.game.per || C.game.per.normal;
        api.setGame({ st: 'run', target: Math.max(C.game.min, Math.round(S.total * per)) });
        if (S.cfg.scene !== 'game') api.setCfg({ scene: 'game' });
      },
      finishGame: function () { api.setGame({ st: 'done' }); },
      closeGame: function () { api.setGame({ st: 'off' }); api.setCfg({ scene: 'logo' }); },
      // an earlier poll of this round back on the screen, voting closed
      showPoll: function (pid) {
        var x = S.ph[pid]; if (!x) return;
        setNow({ k: 'poll', id: x.id, q: x.q, o: x.o, open: false });
        api.setCfg({ scene: 'poll' });
      },
      closePoll: function () { if (S.now && S.now.k === 'poll') setNow({ k: 'poll', id: S.now.id, q: S.now.q, o: S.now.o, open: false }); },
      reopenPoll: function () { if (S.now && S.now.k === 'poll') setNow({ k: 'poll', id: S.now.id, q: S.now.q, o: S.now.o, open: true }); },
      endPoll: function () { setNow({ k: 'none' }); if (S.cfg.scene === 'poll') api.setCfg({ scene: 'checkin' }); },
      // what the screen shows: {scene}, {qr}, {rx}, {deck} (slides of which folder), {live} (the speaker who has the screen: Start / Stop)
      setCfg: function (p) {
        var n = { scene: S.cfg.scene, qr: S.cfg.qr, rx: S.cfg.rx, deck: S.cfg.deck, live: S.cfg.live };
        for (var k in p) n[k] = p[k];
        n.at = Math.max(Date.now(), S.cfg.at + 1); n.w = WID;
        pub(B + '/cfg', JSON.stringify(n), { qos: 1, retain: true });
        onCfg(JSON.stringify(n));
      },
      showQuestion: function (text) { S.show = text; pub(B + '/show', text, { qos: 1, retain: true }); changed(); },
      doneQuestion: function (id) {
        var q = S.qs[id];
        S.done[id] = 1; store();
        if (q && S.show === q.q) api.showQuestion('');
        pub(B + '/q/' + id, '', { qos: 1, retain: true });
        changed();
      },
      // the polls of this round except the current one, newest first
      pastPolls: function () {
        var cur = S.now && S.now.k === 'poll' ? S.now.id : '';
        return Object.keys(S.ph).filter(function (k) { return k !== cur; }).map(function (k) { return S.ph[k]; }).sort(function (a, b) { return b.at - a.at; });
      },
      questions: function () {                         // current round, newest first
        return Object.keys(S.qs).filter(function (id) { return !S.done[id] && S.qs[id].g === S.db.round; })
          .sort(function (a, b) { return S.qs[b].t - S.qs[a].t; }).map(function (id) { return { id: id, q: S.qs[id].q, t: S.qs[id].t }; });
      }
    };
    setInterval(changed, 2000);                         // status and "2 min ago" stay right
    // the screen page says "I am on" every 8 s, so the host panel can show whether the screen is running
    if (opt.screen) { var beat = function () { pub(B + '/scr', window.TAS3D_BUILD || '1', {}); }; setInterval(beat, 8000); setTimeout(beat, 1500); }
    return api;
  };

})();

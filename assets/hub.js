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
  window.TasAuth = {
    ok: function () {
      try { var a = JSON.parse(localStorage.getItem(AUTH) || 'null'); return !!(a && a.h === C.host.hash && a.until > Date.now()); } catch (e) { return false; }
    },
    check: function (pass) {
      if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('This browser cannot check the password here.'));
      return crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']).then(function (key) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(C.host.salt), iterations: C.host.iterations }, key, 256);
      }).then(function (bits) {
        var good = hex(bits) === C.host.hash;
        if (good) try { localStorage.setItem(AUTH, JSON.stringify({ h: C.host.hash, until: Date.now() + 24 * 3600 * 1000 })); } catch (e) {}
        return good;
      });
    },
    logout: function () { try { localStorage.removeItem(AUTH); } catch (e) {} },
    // shows the password form (#login) until the right password is typed, then calls go()
    gate: function (go) {
      var form = document.getElementById('login');
      if (TasAuth.ok()) { form.hidden = true; return go(); }
      form.hidden = false;
      var input = form.querySelector('input'), err = form.querySelector('.err'), btn = form.querySelector('button');
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
      votes: {},                             // phone id -> {o, t} for the current poll
      rx: {},                                // reactions since this page was opened
      cfg: { scene: 'checkin', qr: true, rx: true, at: 0 },   // what the screen shows, set by the host
      total: 0, counts: {}, pollCounts: [], pollTotal: 0
    };
    C.reactions.forEach(function (r) { S.rx[r[0]] = 0; });
    try { var sv = JSON.parse(localStorage.getItem(KEY) || 'null'); if (sv && sv.seen && typeof sv.round === 'string') S.db = sv; } catch (e) {}
    try { var dn = JSON.parse(localStorage.getItem(KEY + '-done') || 'null'); if (dn) S.done = dn; } catch (e) {}

    var changeT = null;
    function changed() { if (!changeT) changeT = setTimeout(function () { changeT = null; onChange(S); }, 30); }
    function store() { try { localStorage.setItem(KEY, JSON.stringify(S.db)); localStorage.setItem(KEY + '-done', JSON.stringify(S.done)); } catch (e) {} }

    // ---- connections to every broker, each reconnects by itself
    var links = [];
    function subsFor(c) {
      c.subscribe(B + '/r', 1); c.subscribe(B + '/c/+', 1); c.subscribe(B + '/q/+', 1);
      c.subscribe(B + '/show', 1); c.subscribe(B + '/now', 1); c.subscribe(B + '/cfg', 1); c.subscribe(B + '/x');
      if (S.now && S.now.k === 'poll') c.subscribe(B + '/v/' + S.now.id + '/+', 1);
    }
    C.brokers.forEach(function (url) {
      var L = { c: null, wait: 2000, r: -1 };
      function open() {
        var c = new TasMQ(url, {
          onConnect: function () {
            L.wait = 2000; L.r = -1; subsFor(c); changed(); pushStats(); pushPR();
            // a broker that missed the last Reset learns about it now
            setTimeout(function () { if (c.ok && (L.r < S.db.at || L.r === -1)) pushRound(L); }, 2500);
          },
          onMessage: function (t, x) { onMsg(t, x, L); },
          onClose: function () { changed(); setTimeout(open, L.wait); L.wait = Math.min(L.wait * 2, 30000); }
        });
        L.c = c; c.connect();
      }
      open(); links.push(L);
    });
    function up() { return links.filter(function (L) { return L.c && L.c.ok; }).length; }
    function pub(topic, text, o) { links.forEach(function (L) { if (L.c && L.c.ok) L.c.publish(topic, text, o || {}).catch(function () {}); }); }
    function pushRound(L) { L.c.publish(B + '/r', JSON.stringify({ id: S.db.round, at: S.db.at }), { qos: 1, retain: true }).catch(function () {}); L.r = Math.max(L.r, S.db.at); }

    // ---- incoming
    function json(x) { try { return JSON.parse(x); } catch (e) { return null; } }
    function onMsg(t, x, L) {
      if (t === B + '/x') return onReact(x);
      if (t.indexOf(B + '/c/') === 0) return onAnswer(t.slice(B.length + 3), x);
      if (t.indexOf(B + '/q/') === 0) return onQuestion(t.slice(B.length + 3), x);
      if (t.indexOf(B + '/v/') === 0) { var p = t.slice(B.length + 3).split('/'); return onVote(p[0], p[1], x); }
      if (t === B + '/show') { if (x !== S.show) { S.show = x; changed(); } return; }
      if (t === B + '/now') return onNow(x);
      if (t === B + '/cfg') return onCfg(x);
      if (t === B + '/r') {
        var d = json(x); if (!d) return;
        var at = +d.at || 0, id = d.id != null ? String(d.id) : String(at);
        L.r = Math.max(L.r, at);
        if (at > S.db.at) {
          S.db = { seen: {}, round: id, at: at }; S.votes = {}; recount(); recountPoll();
          links.forEach(function (x2) { if (x2.c && x2.c.ok) x2.c.subscribe(B + '/c/+', 1); });   // ask again for the kept answers
        }
      }
    }
    var SCENES = { blank: 1, qr: 1, checkin: 1, poll: 1 };
    function onCfg(x) {
      var d = json(x); if (!d) return;
      var at = +d.at || 0;
      if (at < S.cfg.at) return;                       // an older state from a broker that missed a change
      S.cfg = { scene: SCENES[d.scene] ? d.scene : 'checkin', qr: d.qr !== false, rx: d.rx !== false, at: at };
      changed();
    }
    function onReact(x) {
      if (!S.cfg.rx) return;                           // reactions are switched off by the host
      String(x).split(',').forEach(function (p) {
        var m = /^([a-z]+):(\d+)$/.exec(p.trim());
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
      if (!x) { delete S.qs[id]; return changed(); }
      var d = json(x);
      if (!d || typeof d.q !== 'string' || !d.q.trim()) return;
      S.qs[id] = { q: d.q.slice(0, 280), t: +d.t || Date.now(), g: d.g == null ? '0' : String(d.g) };
      changed();
    }
    function onNow(x) {
      var d = json(x) || { k: 'none', at: 0 };
      var at = +d.at || 0;
      if (S.now && at < S.now.at) return;              // an older state from a broker that missed a change
      if (d.k === 'poll' && d.id && Array.isArray(d.o)) {
        if (!S.now || S.now.id !== d.id) {
          S.votes = {};
          links.forEach(function (L) { if (L.c && L.c.ok) L.c.subscribe(B + '/v/' + d.id + '/+', 1); });
        }
        S.now = { k: 'poll', id: String(d.id), q: String(d.q || ''), o: d.o.map(String).slice(0, 6), open: !!d.open, at: at };
      } else S.now = { k: 'none', at: at };
      recountPoll();
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
    var statT = null, prT = null;
    function recount() {
      var c = {}, total = 0;
      for (var id in S.db.seen) { var r = S.db.seen[id].r; c[r] = (c[r] || 0) + 1; total++; }
      S.counts = c; S.total = total;
      store();
      if (!statT) statT = setTimeout(pushStats, 1000);
      changed();
    }
    function recountPoll() {
      var n = [], total = 0;
      if (S.now && S.now.k === 'poll') {
        n = S.now.o.map(function () { return 0; });
        for (var d in S.votes) { n[S.votes[d].o]++; total++; }
      }
      S.pollCounts = n; S.pollTotal = total;
      if (!prT) prT = setTimeout(pushPR, 800);
      changed();
    }
    function pushStats() { statT = null; pub(B + '/s', JSON.stringify({ n: S.total, g: S.db.round, t: Date.now() }), { retain: true }); }
    function pushPR() {
      prT = null;
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
    function clearVotes() {
      if (!S.now || S.now.k !== 'poll') return;
      var pid = S.now.id;
      Object.keys(S.votes).forEach(function (dev) { pub(B + '/v/' + pid + '/' + dev, '', { retain: true }); });
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
        S.qs = {}; S.done = {}; S.votes = {};
        links.forEach(function (L) { if (L.c && L.c.ok) pushRound(L); });
        pub(B + '/show', '', { qos: 1, retain: true }); S.show = '';
        setNow({ k: 'none' });
        if (S.cfg.scene === 'poll') api.setCfg({ scene: 'checkin' });
        clearTimeout(statT); statT = null;
        recount(); pushStats();
      },
      startPoll: function (q, o) {
        clearVotes();
        setNow({ k: 'poll', id: 'p' + rid(), q: q, o: o, open: true });
        api.setCfg({ scene: 'poll' });                 // the screen shows the results right away
      },
      closePoll: function () { if (S.now && S.now.k === 'poll') setNow({ k: 'poll', id: S.now.id, q: S.now.q, o: S.now.o, open: false }); },
      reopenPoll: function () { if (S.now && S.now.k === 'poll') setNow({ k: 'poll', id: S.now.id, q: S.now.q, o: S.now.o, open: true }); },
      endPoll: function () { clearVotes(); setNow({ k: 'none' }); if (S.cfg.scene === 'poll') api.setCfg({ scene: 'checkin' }); },
      // what the screen shows: {scene}, {qr}, {rx}
      setCfg: function (p) {
        var n = { scene: S.cfg.scene, qr: S.cfg.qr, rx: S.cfg.rx };
        for (var k in p) n[k] = p[k];
        n.at = Math.max(Date.now(), S.cfg.at + 1);
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
      questions: function () {                         // current round, newest first
        return Object.keys(S.qs).filter(function (id) { return !S.done[id] && S.qs[id].g === S.db.round; })
          .sort(function (a, b) { return S.qs[b].t - S.qs[a].t; }).map(function (id) { return { id: id, q: S.qs[id].q, t: S.qs[id].t }; });
      }
    };
    setInterval(changed, 2000);                         // status and "2 min ago" stay right
    return api;
  };
})();

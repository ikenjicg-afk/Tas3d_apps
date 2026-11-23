// TAS3D 2026 — check-in by QR. Shared settings for hi/ (guests' phones) and live/ (the screen on stage). English only.
// No server of our own: check-ins go through free public MQTT brokers (no account, no keys).
// A phone sends its answer to every broker at once; the screen listens to all of them, so one broker being down is fine.
// Each answer is kept on the broker ("retained"), so the screen gets everything back after a reload.
// room: random part of the topic, so other people's tests on these public brokers do not mix with ours.
// Topics: <base>/c/<phone id> = answer of one phone, <base>/s = total for phones, <base>/r = current round (changes on Reset),
//   <base>/x = reactions (not kept; text "fire:2,clap:1"), <base>/q/<question id> = anonymous question (kept),
//   <base>/show = the question shown over the slides (kept; plain text, empty = nothing shown),
//   <base>/now = the current poll (kept; {k:'poll', id, q, o:[options], open, at} or {k:'none'}),
//   <base>/v/<poll id>/<phone id> = one vote (kept; {o: option index, t, g: round}), <base>/pr = poll results for phones,
//   <base>/cfg = what the host shows on the screen (kept; {scene: blank|logo|qr|checkin|poll|slides, qr: QR on/off, rx: reactions on/off,
//     deck: which speaker's folder the slides scene shows, live: the speaker the host has started (only they control the screen), at}).
// Presentations (encrypted with the slides key, see deck.js): <base>/dk = the speakers' folders and files (kept, from the screen),
//   <base>/pv/<folder id> = where one folder is: slide number, file, video state (kept; small, sent at once),
//   <base>/px/<folder id>/c and /n = the pictures of the current and the next slide (kept; big, so they go apart, over
//   connections of their own), <base>/sa = "the screen is on" (every 8 s),
//   <base>/sk = commands from the speakers' page and the host panel (next, prev, show on screen ...).
// The game: <base>/game = {id, st: off|ready|run|hang|boot|bsod|done, target, per, pk, ph, t1, at, w} (kept, from the host and the screen);
//   pk = the prank is on (always, unless game.prank.on is false), ph = which render of the prank
//   (1: "Insufficient Memory" when 50% of the noise is left, 2: a blue screen when 1% of the noise is left),
//   hang = the error window, the game stands still; boot = the host's "Fake reset" (a new game id: everything starts from zero);
//   bsod = the blue screen, the results come by themselves after `prank.results` seconds.
//   <base>/gt/<game>/<phone> = "role:taps so far" (every second while tapping); <base>/gs = the score (kept, from the screen).
// <base>/ph = the polls of this round with their results (kept until Reset).
window.TAS3D_CHECKIN = {
  room: '24s57u4s6z',
  topic: 'testtopic/tas3d2026',
  // Checked from Tashkent on 06.11.2026: both EMQX addresses work. HiveMQ and Mosquitto did not open there, so they are not used.
  brokers: [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt'
  ],
  roles: [
    ['vis', 'Visualiser'],
    ['arch', 'Architect'],
    ['dev', 'Developer'],
    ['stud', 'Student'],
    ['teach', 'Teacher'],
    ['other', 'Other']
  ],
  // Host password: only its salted hash is here (PBKDF2-SHA256). It keeps guests out of the host panel; it is not strong security.
  host: { salt: 'edaa75343e03677b0559f9c0f6e435ab', iterations: 150000, hash: '8954e5646d38bb5d211581f1b8c99e1cdc5cb5da114af8b9ca5c51e8ec775902' },
  // Slides key (made by tools/make_slide_keys.js; no password is written here): the speakers' password gives the key,
  // the host password opens it too ("wrap"). Previews and commands of the presentations are encrypted with it.
  // the opening game: the hall renders TAS3D 2026 out of noise together. Samples needed = checked-in guests × per (at least min);
  // normal: a hall tapping at an easy pace ≈ 1 minute;
  // one phone counts at most cap taps a second
  // prank (part of the game; on: false takes it out): hang and bsod are the NOISE left on the screen's meter.
  // The 1st render stops with "Insufficient Memory" when the meter shows `hang` (0.5 = NOISE 50%); the host presses
  // Fake reset, the restart takes `boot` seconds; the 2nd render crashes with a blue screen at `bsod` (0.01 = NOISE 1%),
  // and the results come `results` seconds later.
  // (the meter: noise = (1 − rendered)^1.3, so NOISE 50% is 41% of the samples and NOISE 1% is 97%)
  game: { per: { short: 100, normal: 170, long: 300 }, min: 1000, cap: 12, prank: { on: true, hang: 0.5, bsod: 0.01, boot: 9, results: 10 } },
  slides: {
    iterations: 150000,
    ssalt: '4564344c5f5c5d59c48e5cfb395f3c52',
    check: 'b15a99081a9a4f15e15206b9833109d88978775d1b920ce986e55011cd5bea40bd52aee9200dc8bd',
    hsalt: 'd6c48d2d9d4b939d25b712c6a483ce87',
    wrap: '129ddf7e4e4b9bbda771f54a7a8b1c6678470a4bacb9fe137ca89db27c46342419c898bf56b9f73b804c2036ef0477b64b55d7b4bc13c4bb67407163'
  },
  // ready-made polls in the host panel (the host can also write a new one)
  polls: [
    ['How many years have you been in 3D?', ['Less than 1', '1–3', '3–5', '5–10', '10+']],
    ['Which renderer do you use most?', ['Corona', 'V-Ray', 'D5 Render', 'Unreal Engine', 'Twinmotion', 'Other']],
    ['Where are you from?', ['Uzbekistan', 'Russia', 'Kazakhstan', 'Other country']],
    ['Is this your first TAS3D?', ['Yes, first time', 'No, I was here in 2025']],
    ['How was this talk?', ['Loved it', 'It was good', 'So-so']]
  ],
  // the quiz "Render or photo?": seconds for one picture
  quiz: { sec: 15 },
  // how many reactions one guest may send: max in every `per` seconds (the phone stops there, the screen ignores the rest)
  rx: { max: 3, per: 10 },
  // reactions on the guests' remote: [key, emoji, label]. 'tas3d' is the logo.
  reactions: [
    ['tas3d', '', 'TAS3D'],                       // the TAS3D logo instead of an emoji
    ['fire', '\uD83D\uDD25', 'Fire'],
    ['clap', '\uD83D\uDC4F', 'Applause'],
    ['wow', '\uD83D\uDE2E', 'Wow'],
    ['love', '\u2764\uFE0F', 'Love'],
    ['haha', '\uD83D\uDE02', 'Haha'],
    ['like', '\uD83D\uDC4D', 'Like']
  ]
};
// For tests: ?broker=ws://localhost:9001/mqtt (comma-separated) replaces the list above.
(function (c) {
  try {
    var b = new URLSearchParams(location.search).get('broker');
    if (b) c.brokers = b.split(',').filter(function (u) { return /^wss?:\/\//.test(u); });
  } catch (e) {}
  c.base = c.topic + '/' + c.room;
})(window.TAS3D_CHECKIN);
// A new version of the site was published: fn(newBuild). TAS3D_BUILD is put into each page by tools/build_checkin.py.
(function () {
  window.TasUpdate = function (fn, first) {
    var mine = window.TAS3D_BUILD;
    if (!mine || location.protocol === 'file:') return;
    function check() {
      fetch(location.pathname + '?u=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (h) {
        var m = /TAS3D_BUILD\s*=\s*'([a-z0-9]+)'/.exec(h);
        if (m && m[1] !== mine) fn(m[1]);
      }).catch(function () {});
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
    setInterval(check, 120000);
    setTimeout(check, first || 20000);
    return check;
  };
  // open the new version: a new address, so no cached copy of the old page is used
  window.TasUpdate.reload = function (build) {
    try { var u = new URL(location.href); u.searchParams.set('v', build); location.replace(u.toString()); } catch (e) { location.reload(); }
  };
})();

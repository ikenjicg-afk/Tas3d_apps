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
//   <base>/pv/<folder id> = current and next slide previews of one folder (kept), <base>/sa = "the screen is on" (every 8 s),
//   <base>/sk = commands from the speakers' page and the host panel (next, prev, show on screen ...).
// The game: <base>/game = {id, st: off|ready|run|done, target, per, at, w} (kept, from the host);
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
  game: { per: { short: 100, normal: 170, long: 300 }, min: 1000, cap: 12 },
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
    ['Where are you from?', ['Tashkent', 'Another city in Uzbekistan', 'Another country']],
    ['Is this your first TAS3D?', ['Yes, first time', 'No, I was here in 2025']],
    ['How was this talk?', ['Loved it', 'It was good', 'So-so']]
  ],
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
  window.TasUpdate = function (fn) {
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
    setTimeout(check, 20000);
  };
  // open the new version: a new address, so no cached copy of the old page is used
  window.TasUpdate.reload = function (build) {
    try { var u = new URL(location.href); u.searchParams.set('v', build); location.replace(u.toString()); } catch (e) { location.reload(); }
  };
})();

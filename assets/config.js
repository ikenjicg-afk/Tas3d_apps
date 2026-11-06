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
//     deck: which speaker's folder the slides scene shows, sp: speakers may put their slides on the screen, at}).
// Presentations (encrypted with the slides key, see deck.js): <base>/dk = the speakers' folders and files (kept, from the screen),
//   <base>/pv/<folder id> = current and next slide previews of one folder (kept), <base>/sa = "the screen is on" (every 8 s),
//   <base>/sk = commands from the speakers' page and the host panel (next, prev, show on screen ...).
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
  host: { salt: 'f8e2ab141cbb493600a15bdc94c1ac07', iterations: 150000, hash: 'c9529d95eea44f58496334901404e3fbf9d750e178011999ea5dcecf006c9d22' },
  // Slides key (made by tools/make_slide_keys.js; no password is written here): the speakers' password gives the key,
  // the host password opens it too ("wrap"). Previews and commands of the presentations are encrypted with it.
  slides: {
    iterations: 150000,
    ssalt: '257c1ed3a3bab1584bfd637e5a440048',
    check: '8e8e36347243adb761e9fc2ee6f8430274d60c99622368dc8457c35d218d9e0b7b8d1be7886f1bf1',
    hsalt: 'ba8d13d05c37ba94b261dda5dea60f41',
    wrap: 'ab18fe631040f253b5391f1058577e4857e8734a86e7f6a8f9f081786abf204358798f13513356a599e96609256606180a897ad7b206254762c8656a'
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

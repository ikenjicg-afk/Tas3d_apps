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
// The game: <base>/game = {id, st: off|ready|run|hang|boot|bsod|done, target, per, pk, ph, t1, at, w} (kept, from the host and the screen;
//   target = the samples needed: the screen sets it again once it knows the hall's pace — see game.time below);
//   pk = the prank is on (always, unless game.prank.on is false), ph = which render of the prank
//   (1: "Insufficient Memory" when 50% of the noise is left, 2: a blue screen when 1% of the noise is left),
//   hang = the error window, the game stands still; boot = the host's "Fake reset" (a new game id: everything starts from zero);
//   bsod = the blue screen, the results come by themselves after `prank.results` seconds.
//   <base>/gt/<game>/<phone> = "role:taps so far" (every second while tapping); <base>/gs = the score (kept, from the screen).
// <base>/ph = the polls of this round with their results (kept until Reset).
// <base>/an = the host's announcement to the guests' phones (kept; {id, i: id of the programme item, at, w}; id '' = taken off).
//   The texts are not in the message: a phone shows the item of its own config.js, so nobody can put words of their own on the phones.
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
  // the opening game: the hall renders TAS3D 2026 out of noise together.
  // time: for how many seconds the hall taps in the whole game (with the prank: both renders together) — 150 = 2.5 minutes,
  //   whatever the number of guests and however fast they tap. How: the first guess of the samples needed is
  //   checked-in guests × per (at least min); after `cal` seconds of tapping the screen measures the hall's real pace
  //   (samples a second) and sets the amount so that the render lasts its share of `time` at that pace. With the prank the
  //   1st render (to NOISE 50%) is about 30% of the time and the 2nd (to NOISE 1%) about 70%; each one is measured once.
  //   time: 0 = no measuring, the amount stays guests × per.
  // one phone counts at most cap taps a second
  // prank (part of the game; on: false takes it out): hang and bsod are the NOISE left on the screen's meter.
  // The 1st render stops with "Insufficient Memory" when the meter shows `hang` (0.5 = NOISE 50%); the host presses
  // Fake reset, the restart takes `boot` seconds; the 2nd render crashes with a blue screen at `bsod` (0.01 = NOISE 1%),
  // and the results come `results` seconds later.
  // (the meter: noise = (1 − rendered)^1.3, so NOISE 50% is 41% of the samples and NOISE 1% is 97%)
  game: { time: 150, cal: 10, per: 330, min: 150, cap: 12, prank: { on: true, hang: 0.5, bsod: 0.01, boot: 9, results: 10 } },
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
    ['Where are you from?', ['Uzbekistan', 'Russia', 'Kazakhstan', 'Belarus', 'Other country']],
    ['Is this your first TAS3D?', ['Yes, first time', 'No, I was here in 2025']],
    ['How was this talk?', ['Loved it', 'It was good', 'So-so']]
  ],
  // the talk timer (host: under Start; the speaker's page: the same row): after `glow` minutes of a running talk the row
  // glows softly in orange (a slow pulse, nothing jumps) — on the speaker's phone and in the host panel. 0 = never.
  timer: { glow: 30 },
  // announcements: the host announces an item of the programme (Slides tab → "Announce to the guests"); every guest's phone
  // with the page open shows it over the remote — who is on stage and a request to listen.
  // show: for how many seconds after the host's tap a phone still brings the notice up (a phone that opens the page later
  //   only marks the item "Now" in its programme); now: for how many minutes the item stays marked "Now" if nothing else is announced.
  // talk / pause: the request under a talk and under a break when the item has no `say` of its own ({to} = the item's end time).
  announce: { show: 120, now: 60,
    talk: 'Please listen carefully: this talk is full of useful and important things.',
    pause: 'We start again at {to}.' },
  // the programme of the day: the guests' tab "Programme" and the host's announcements.
  // people: who is on stage. name; role = title / company (one line); bio = the text about them (\n\n between paragraphs);
  //   photo = a file name in media/speakers/ (square, about 800 px) or a full address (https://…); ig = the Instagram name
  //   (without @). No photo: the initials. Neither role nor bio: "More about the speaker will be here soon."
  // items, in the order of the day: id (letters and digits; do not change one after the forum has started), from, to ('HH:MM'),
  //   kind: talk | break | info, title, by: [keys of people], lang: 'EN' = the talk is in English,
  //   note = a small line for the guests, say = the request on the phones when it is announced, ann: false = not in the host's list.
  // 28.11.2026: times, order and titles from the organizer's programme (the A4 sheet "TAS3D 2026 — Programme"); its lines
  //   "Host announces the next speaker" are stage notes and are not shown to the guests.
  //   Roles, photos and Instagram: from https://tas3d.uz/en/ as it was on 28.11.2026 (the photos are the files on that site,
  //   by address — they are not copied here). The site has no longer texts about the speakers. The speaker of Bloom
  //   (the programme says "Bloom Architects") is on the site as Islambek Urazbaev; PromptX is not on it.
  program: {
    day: '3 December 2026',
    note: 'Times are approximate and may shift on the day. Each talk: about 25 minutes plus questions.',
    people: {
      kenji: { name: 'KENJI', role: 'Host · Lead 3D Artist at Apex Development', bio: '', photo: 'https://tas3d.uz/media/speakers/kenji.jpg', ig: 'knji.knji' },
      artem: { name: 'Artem Kupriianenko', role: 'Founder of OMEGA RENDER', bio: '', photo: 'https://tas3d.uz/media/speakers/artem-kupriianenko.jpg', ig: 'kupriianenko_art' },
      daniel: { name: 'Daniel Nagaets', role: 'Founder of RENDER CAMP and Fortes Vision', bio: '', photo: 'https://tas3d.uz/media/speakers/daniel-nagaets-hq.jpg', ig: 'danielnagaets' },
      vlad: { name: 'Vlad Sidorenko', role: 'Art Director at OMEGA RENDER', bio: '', photo: 'https://tas3d.uz/media/speakers/vlad-sidorenko.jpg', ig: 'vsdrnko' },
      promptx: { name: 'PromptX', role: '', bio: '', photo: '', ig: '' },
      bloom: { name: 'Islambek Urazbaev', role: 'Architect, co-founder and COO of Bloom Arch Studio', bio: '', photo: 'https://tas3d.uz/media/speakers/islambek-urazbaev.jpg', ig: 'iurazbaevv' },
      zach: { name: 'Zach Bai', role: 'Co-founder of D5 Render', bio: '', photo: 'https://tas3d.uz/media/speakers/zach-bai.jpg', ig: 'd5officialaccount' },
      wellington: { name: 'Wellington Franzao', role: 'Creative Director, podcast host, and three-time award-winning CG artist', bio: '', photo: 'https://tas3d.uz/media/speakers/wellington-franzao.jpg', ig: 'franzao.f' }
    },
    items: [
      { id: 'doors', from: '14:00', kind: 'info', title: 'Doors open, registration', ann: false },
      { id: 'opening', from: '15:00', to: '15:20', kind: 'talk', by: ['kenji'], title: 'Opening video + opening of the forum',
        say: 'We are starting. Please take your seats.' },
      { id: 'artem', from: '15:20', to: '15:50', kind: 'talk', by: ['artem'], title: 'AI and content: the beautiful picture has lost its value — how to stay in demand' },
      { id: 'vlad', from: '15:53', to: '16:23', kind: 'talk', by: ['vlad'], title: 'An AI pipeline on a real project' },
      { id: 'daniel', from: '16:26', to: '16:56', kind: 'talk', by: ['daniel'], title: 'Archviz is marketing: what to learn and what level to aim for' },
      { id: 'bloom', from: '16:59', to: '17:29', kind: 'talk', by: ['bloom'], title: 'Architecture and AI: how it was before and how it is now' },
      { id: 'coffee', from: '17:32', to: '18:02', kind: 'break', title: 'Coffee break', note: 'The PromptX giveaway is right after the break.',
        say: 'We start again at {to} with PromptX and the giveaway. Do not be late.' },
      { id: 'promptx', from: '18:05', to: '18:35', kind: 'talk', by: ['promptx'], title: 'How AI works under the hood + giveaway' },
      { id: 'wellington', from: '18:38', to: '19:08', kind: 'talk', by: ['wellington'], lang: 'EN', title: 'Sketches art' },
      { id: 'zach', from: '19:11', to: '19:41', kind: 'talk', by: ['zach'], lang: 'EN', title: 'AI agents take a project from first idea to final delivery' },
      { id: 'panel', from: '19:44', to: '20:09', kind: 'talk', by: ['artem', 'daniel', 'vlad', 'bloom'], title: 'Panel discussion',
        say: 'Four speakers on one stage. Please listen carefully.' },
      { id: 'closing', from: '20:09', to: '20:25', kind: 'info', title: 'Closing and group photo', say: 'Thank you for this day. Please stay for the photo.' }
    ]
  },
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
// For tests: ?broker=ws://localhost:9001/mqtt (comma-separated) replaces the list above;
// ?game=time:0,min:1000 replaces numbers of `game` on that page (a short game for a test).
(function (c) {
  try {
    var P = new URLSearchParams(location.search), b = P.get('broker'), g = P.get('game');
    if (b) c.brokers = b.split(',').filter(function (u) { return /^wss?:\/\//.test(u); });
    if (g) g.split(',').forEach(function (kv) { var m = /^(time|cal|per|min|cap):(\d+(?:\.\d+)?)$/.exec(kv); if (m) c.game[m[1]] = +m[2]; });
  } catch (e) {}
  c.base = c.topic + '/' + c.room;
})(window.TAS3D_CHECKIN);
// A new version of the site was published: fn(newBuild). TAS3D_BUILD is put into each page by tools/build_checkin.py.
(function () {
  // quick (the screen and the host panel: 5000): every `quick` ms the tiny file build.txt next to the pages is asked for
  // the build id, so those two take a new version within seconds and nobody has to press anything. The guests' phones do
  // not do it: hundreds of them asking every 5 s would be too many requests.
  window.TasUpdate = function (fn, first, quick) {
    var mine = window.TAS3D_BUILD;
    if (!mine || location.protocol === 'file:') return;
    if (quick) setInterval(function () {
      fetch(new URL('../build.txt', location.href.split(/[?#]/)[0]).href + '?u=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
        t = (t || '').trim();
        if (!/^[a-z0-9]{6,20}$/.test(t) || t === mine) return;
        // this page has just loaded itself again for that build and is still not it (the page is not out yet): not at once again
        var m = null; try { m = /^([a-z0-9]+)\|(\d+)$/.exec(sessionStorage.getItem('tas3d-upd') || ''); } catch (e) {}
        if (m && m[1] === t && Date.now() - +m[2] < 60000) return;
        fn(t);
      }).catch(function () {});
    }, quick);
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
    try { sessionStorage.setItem('tas3d-upd', build + '|' + Date.now()); } catch (e) {}
    try { var u = new URL(location.href); u.searchParams.set('v', build); location.replace(u.toString()); } catch (e) { location.reload(); }
  };
})();

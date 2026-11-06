// TAS3D — tiny MQTT 3.1.1 client over WebSocket (just what check-in needs: connect, subscribe, publish QoS 0/1, retain, ping).
// new TasMQ(url, { onConnect(), onMessage(topic, text, retained), onClose() }); .connect() .subscribe(filter, qos) .publish(topic, text, {qos, retain}) → Promise .close()
(function () {
  var enc = new TextEncoder(), dec = new TextDecoder();
  function u16(n) { return [(n >> 8) & 255, n & 255]; }
  function str(s) { var b = enc.encode(s); return u16(b.length).concat(Array.prototype.slice.call(b)); }
  function len(n) { var out = []; do { var d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; out.push(d); } while (n > 0); return out; }
  function pack(head, body) { return new Uint8Array([head].concat(len(body.length), body)); }
  function cat(a, b) { var c = new Uint8Array(a.length + b.length); c.set(a, 0); c.set(b, a.length); return c; }

  function TasMQ(url, o) {
    this.url = url; this.o = o || {}; this.ws = null; this.ok = false;
    this.buf = new Uint8Array(0); this.pid = 1; this.wait = {}; this.ping = null; this.rx = Date.now();
    this.id = 'tas3d' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
  }
  TasMQ.prototype.connect = function () {
    var me = this, ws;
    try { ws = new WebSocket(this.url, ['mqtt']); } catch (e) { setTimeout(function () { me._closed(); }, 0); return this; }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = function () {
      // CONNECT: protocol "MQTT", level 4, clean session, keep-alive 120 s (a background tab pings only once a minute;
      // a dead connection is still noticed in 40 s by the check below while the page is in front)
      ws.send(pack(0x10, str('MQTT').concat([4, 0x02], u16(120), str(me.id))));
    };
    ws.onmessage = function (e) { me.rx = Date.now(); if (e.data instanceof ArrayBuffer) me._feed(new Uint8Array(e.data)); };
    ws.onerror = function () {};
    ws.onclose = function () { me._closed(); };
    return this;
  };
  TasMQ.prototype._closed = function () {
    if (this.dead) return;
    this.dead = true; this.ok = false; clearInterval(this.ping); clearTimeout(this.chk);
    if (this.vis) document.removeEventListener('visibilitychange', this.vis);
    for (var k in this.wait) { this.wait[k][1](new Error('closed')); }
    this.wait = {};
    if (this.o.onClose) this.o.onClose();
  };
  TasMQ.prototype._send = function (bytes) { if (this.ws && this.ws.readyState === 1) { this.ws.send(bytes); return true; } return false; };
  TasMQ.prototype._feed = function (chunk) {
    this.buf = cat(this.buf, chunk);
    while (this.buf.length >= 2) {
      var mul = 1, n = 0, i = 1, d;
      do { if (i >= this.buf.length) return; d = this.buf[i++]; n += (d & 127) * mul; mul *= 128; } while (d & 128 && i < 5);
      if (this.buf.length < i + n) return;
      var head = this.buf[0], body = this.buf.subarray(i, i + n);
      this.buf = this.buf.slice(i + n);
      this._packet(head, body);
    }
  };
  TasMQ.prototype._packet = function (head, b) {
    var me = this, type = head >> 4;
    if (type === 2) {                                   // CONNACK
      if (b[1] === 0) {
        this.ok = true;
        // ping every 15 s; a connection that has not answered for 40 s is dead (phone lost the network): close it, it reconnects.
        // In a background tab the browser slows timers down to once a minute, so there the limit is longer.
        var beat = function () { if (Date.now() - me.rx > (document.hidden ? 170000 : 40000)) return me.close(); me._send(new Uint8Array([0xC0, 0])); };
        this.ping = setInterval(beat, 15000);
        // back in front (a phone unlocked, a window shown again): check the connection at once
        this.vis = function () { if (!document.hidden && me.ok) { beat(); me.chk = setTimeout(function () { if (me.ok && Date.now() - me.rx > 6000) me.close(); }, 6000); } };
        document.addEventListener('visibilitychange', this.vis);
        if (this.o.onConnect) this.o.onConnect();
      } else this.close();
    } else if (type === 3) {                            // PUBLISH from the broker
      var qos = (head >> 1) & 3, tl = (b[0] << 8) | b[1], topic = dec.decode(b.subarray(2, 2 + tl)), p = 2 + tl;
      if (qos > 0) { var id = (b[p] << 8) | b[p + 1]; p += 2; if (qos === 1) this._send(pack(0x40, [b[p - 2], b[p - 1]])); }
      if (this.o.onMessage) this.o.onMessage(topic, dec.decode(b.subarray(p)), !!(head & 1));
    } else if (type === 4) {                            // PUBACK
      var k = (b[0] << 8) | b[1], w = this.wait[k];
      if (w) { delete this.wait[k]; w[0](); }
    }
    // SUBACK (9) and PINGRESP (13) need nothing
  };
  TasMQ.prototype._next = function () { this.pid = this.pid % 65535 + 1; return this.pid; };
  TasMQ.prototype.subscribe = function (filter, qos) {    // qos 1: the broker queues messages for us instead of dropping them under load
    return this._send(pack(0x82, u16(this._next()).concat(str(filter), [qos ? 1 : 0])));
  };
  TasMQ.prototype.unsubscribe = function (filter) {
    return this._send(pack(0xA2, u16(this._next()).concat(str(filter))));
  };
  TasMQ.prototype.publish = function (topic, text, opt) {
    var me = this, qos = opt && opt.qos ? 1 : 0, retain = opt && opt.retain ? 1 : 0;
    var head = str(topic), id = 0;
    if (qos) { id = this._next(); head = head.concat(u16(id)); }
    // built as bytes, not as an array of numbers: previews of slides are tens of KB
    var pl = enc.encode(text || ''), n = head.length + pl.length, ln = len(n);
    var bytes = new Uint8Array(1 + ln.length + n);
    bytes[0] = 0x30 | (qos << 1) | retain; bytes.set(ln, 1); bytes.set(head, 1 + ln.length); bytes.set(pl, 1 + ln.length + head.length);
    if (!qos) return Promise.resolve(this._send(bytes));
    return new Promise(function (ok, no) {
      // no confirmation in 8 s: the connection is not working — give up on it (the caller tries again / elsewhere)
      var t = setTimeout(function () { if (me.wait[id]) { delete me.wait[id]; no(new Error('no answer')); me.close(); } }, 8000);
      me.wait[id] = [function () { clearTimeout(t); ok(); }, function (e) { clearTimeout(t); no(e); }];
      if (!me._send(bytes)) { delete me.wait[id]; clearTimeout(t); no(new Error('not connected')); }
    });
  };
  TasMQ.prototype.close = function () {
    try { this._send(new Uint8Array([0xE0, 0])); this.ws && this.ws.close(); } catch (e) {}
    this._closed();
  };
  window.TasMQ = TasMQ;
})();

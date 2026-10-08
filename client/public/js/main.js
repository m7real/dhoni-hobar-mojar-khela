/* main.js — socket wiring, scene sync and lobby flow. */
(function () {
  'use strict';

  var socket = io({ transports: ['websocket', 'polling'] });
  var ui, scene;
  var youId = null;
  var roomCode = null;
  var sessionToken = null;
  var started = false;
  var resuming = false;
  var seenVersions = {};

  // Where we are in a game, so a refresh can drop us back into the same seat.
  var SEAT_KEY = 'dhk:seat';

  function $(id) { return document.getElementById(id); }

  function emit(ev, data) {
    // A light click for the player's own actions, so the board feels alive.
    if (ev !== 'chat' && ev !== 'resume') {
      var a = global.GameAudio;
      if (a) a.click();
    }
    socket.emit(ev, data || {});
  }

  function saveSeat(code, token) {
    try {
      if (!code || !token) return;
      localStorage.setItem(SEAT_KEY, JSON.stringify({ code: code, token: token }));
    } catch (_) { /* private browsing */ }
  }

  function readSeat() {
    try {
      var raw = localStorage.getItem(SEAT_KEY);
      if (!raw) return null;
      var seat = JSON.parse(raw);
      return seat && seat.code && seat.token ? seat : null;
    } catch (_) { return null; }
  }

  function clearSeat() {
    try { localStorage.removeItem(SEAT_KEY); } catch (_) { /* ignore */ }
  }

  // ── connection overlay ───────────────────────────────────────────────────

  function showNet(title, body, canRetry) {
    var el = $('netOverlay');
    if (!el) return;
    $('netTitle').textContent = title;
    $('netBody').textContent = body;
    $('btnNetRetry').hidden = !canRetry;
    el.hidden = false;
  }

  function hideNet() {
    var el = $('netOverlay');
    if (el) el.hidden = true;
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  function boot() {
    ui = new UI(emit);
    ui.onExit = function () {
      youId = null;
      roomCode = null;
      sessionToken = null;
      started = false;
      resuming = false;
      seenVersions = {};
      clearSeat();
      hideNet();
      ui.showLobby();
    };

    scene = new Scene3D($('board'), $('labels'));
    scene.onTileClick = function (id) {
      scene.focusTile(id);
      ui.showTile(id);
    };

    $('btnCamReset').addEventListener('click', function () { scene.resetCamera(); });

    // Sound: the first gesture unlocks audio, as browsers require.
    var soundBtn = $('btnSound');
    var audio = global.GameAudio || null;

    function paintSound() {
      if (!soundBtn) return;
      var muted = audio ? audio.isMuted() : false;
      soundBtn.textContent = muted ? '🔇' : '🔊';
      soundBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    }
    paintSound();

    if (soundBtn) {
      soundBtn.addEventListener('click', function () {
        if (!audio) return;
        audio.unlock();
        audio.toggle();
        paintSound();
        if (!audio.isMuted()) audio.click();
      });
    }
    // Unlock on any first interaction, without changing the user's choice.
    ['pointerdown', 'keydown'].forEach(function (evt) {
      document.addEventListener(evt, function unlockOnce() {
        if (audio) audio.unlock();
        document.removeEventListener(evt, unlockOnce);
      }, { once: true });
    });
    $('btnCopy').addEventListener('click', function () {
      var code = roomCode || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () {
          ui.toast('রুম কোড কপি হয়েছে: ' + code, 'good');
        }, function () { ui.toast('কোড: ' + code); });
      } else {
        ui.toast('রুম কোড: ' + code);
      }
    });
    $('btnLeave').addEventListener('click', function () {
      socket.emit('leave');
      clearSeat();
      sessionToken = null;
      youId = null;
      roomCode = null;
      started = false;
      hideNet();
      ui.showLobby();
    });

    $('btnCreate').addEventListener('click', function () { join(null); });
    $('btnJoin').addEventListener('click', function () {
      var code = $('codeInput').value.trim().toUpperCase();
      if (!code) { ui.toast('রুম কোড দিন।', 'bad'); return; }
      join(code);
    });
    $('codeInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnJoin').click();
    });
    $('nameInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnCreate').click();
    });

    $('codeInput').addEventListener('input', function (e) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });

    $('btnNetRetry').addEventListener('click', function () {
      tryResume(true);
    });
    $('btnNetLeave').addEventListener('click', function () {
      clearSeat();
      sessionToken = null;
      roomCode = null;
      youId = null;
      hideNet();
      emit('leave');
      socket.disconnect();
      ui.showLobby();
    });

    socket.on('connect', function () {
      // On a first visit there is no seat to reclaim, so stay in the lobby.
      if (!started && !readSeat()) return;
      tryResume(false);
    });

    socket.on('connect_error', function (err) {
      if (started || readSeat()) {
        showNet('সার্ভারের সাথে যুক্ত হচ্ছে…', String(err.message || err), false);
      } else {
        ui.toast('সার্ভারের সাথে সংযোগ হচ্ছে না: ' + err.message, 'bad');
      }
    });

    socket.on('disconnect', function (reason) {
      if (reason === 'io client disconnect') return;   // we asked for it
      if (started || sessionToken) {
        showNet('সংযোগ বিচ্ছিন্ন হয়েছে', 'আবার যুক্ত হওয়ার চেষ্টা করছি…', true);
      }
    });

    socket.on('rooms', function (rooms) { ui.renderRooms(rooms); });
    socket.on('tradeTick', function () { ui.tickTrades(); });

    socket.on('state', onState);
    socket.on('fx', onFx);
    socket.on('toast', function (t) { ui.toast(t.bn); });
    socket.on('chat', function (m) { ui.addChat(m); });
  }

  // Try to reclaim the seat we were given earlier.
  function tryResume(manual) {
    if (resuming) return;
    var seat = readSeat();
    if (!seat) {
      hideNet();
      return;
    }
    resuming = true;
    showNet(
      manual ? 'আবার যুক্ত হওয়ার চেষ্টা…' : 'সংযোগ পুনরায় স্থাপন হচ্ছে…',
      'খেলাটি আপনার জন্য অপেক্ষা করছে।',
      false
    );

    socket.emit('resume', { code: seat.code, sessionToken: seat.token }, function (res) {
      resuming = false;
      if (res && res.ok) {
        youId = res.you;
        roomCode = res.code;
        sessionToken = res.sessionToken;
        saveSeat(res.code, res.sessionToken);
        started = true;
        hideNet();
        ui.showGame();
        ui.addChat({ system: true, text: 'আবার যুক্ত হলেন। রুম কোড: ' + res.code });
        onState(res.state);
        return;
      }
      // The seat is gone — stop pretending and go back to the lobby.
      clearSeat();
      sessionToken = null;
      roomCode = null;
      youId = null;
      started = false;
      hideNet();
      ui.showLobby();
      ui.toast((res && res.error) || 'খেলাটি আর নেই।', 'bad');
    });
  }

  function join(code) {
    var name = $('nameInput').value.trim();
    if (!name) {
      ui.toast('আগে আপনার নাম লিখুন।', 'bad');
      $('nameInput').focus();
      return;
    }
    socket.emit('join', { name: name, code: code }, function (res) {
      if (!res || !res.ok) {
        ui.toast((res && res.error) || 'যোগ দেওয়া যায়নি।', 'bad');
        return;
      }
      youId = res.you;
      roomCode = res.code;
      sessionToken = res.sessionToken;
      saveSeat(res.code, res.sessionToken);
      $('codeInput').value = '';
      ui.showGame();
      ui.addChat({ system: true, text: 'আপনি খেলায় যোগ দিলেন। রুম কোড: ' + res.code });
      onState(res.state);
    });
  }

  // ── state ────────────────────────────────────────────────────────────────

  function onState(state) {
    if (!state) return;
    started = true;

    roomCode = state.code;
    ui.render(state, youId);
    watchForSounds(state);

    scene.setBoard(state);
    scene.syncTokens(state, seenVersions[state.code] !== undefined);
    seenVersions[state.code] = state.version;

    // Tile labels
    var cur = state.players.find(function (p) { return p.id === state.currentPlayerId; });
    for (var i = 0; i < state.board.length; i++) {
      var t = state.board[i];
      var cls = '';
      if (t.ownerId) cls += ' is-owned';
      if (t.mortgaged) cls += ' is-mortgaged';
      scene.setLabelText(i, t.bn, cls);
    }

    // Highlight: the buy decision beats "whose turn is it".
    var pending = state.pending || {};
    if (state.phase === 'awaitBuy' && pending.playerId === youId) {
      scene.setHighlight(pending.tileId, '#2fa35c');
    } else if (state.phase === 'gameOver') {
      var w = state.players.find(function (p) { return p.id === state.winnerId; });
      if (w && w.position != null) scene.setHighlight(w.position, '#e0a63a');
      else scene.setHighlight(null);
    } else if (cur && cur.position != null) {
      scene.setHighlight(cur.position, '#e0a63a');
    } else {
      scene.setHighlight(null);
    }

    // Keep the cash/properties tab fresh if the user is looking at it.
    if (state.phase === 'gameOver' && !document.getElementById('modal').dataset.shown) {
      document.getElementById('modal').dataset.shown = '1';
      ui.showGameOver(state);
      setTimeout(function () {
        delete document.getElementById('modal').dataset.shown;
      }, 800);
    }
  }

  // ── effects ──────────────────────────────────────────────────────────────

  function audio() { return global.GameAudio || null; }

  function sound(kind) {
    var a = audio();
    if (a) a.forEvent(kind);
  }

  // A streak and a floating amount where the pawn that owes rent is standing.
  function flashPayment(playerId) {
    if (!scene || !scene.tokenScreen) return;
    if (window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var pos = scene.tokenScreen(playerId);
    if (!pos) return;

    var host = document.getElementById('fxLayer');
    if (!host) return;

    var line = document.createElement('div');
    line.className = 'pay-line';
    line.style.left = pos.x - 40 + 'px';
    line.style.top = pos.y - 26 + 'px';
    line.style.width = '80px';
    host.appendChild(line);

    var label = document.createElement('div');
    label.className = 'pay-amount';
    label.textContent = '🏠 ভাড়া';
    label.style.left = pos.x + 'px';
    label.style.top = pos.y - 10 + 'px';
    host.appendChild(label);

    setTimeout(function () {
      line.remove();
      label.remove();
    }, 1100);
  }

  function onFx(fx) {
    if (!fx) return;
    var state = ui.state;

    if (fx.type === 'roll') {
      scene.rollDice(fx.dice);
      var d = fx.dice || [0, 0];
      ui.el.diceA.textContent = d[0] ? UIUtil.bnDigits(d[0]) : '–';
      ui.el.diceB.textContent = d[1] ? UIUtil.bnDigits(d[1]) : '–';
      sound('roll');

      if (fx.doubles) ui.fxNote('জোড়া ডাইস!');

      var who = state && state.players.find(function (p) { return p.id === fx.playerId; });
      if (who && fx.landedOn) {
        var type = fx.landedOn.type;
        if (type === 'go') ui.fxNote('🎁 ' + who.name + ' পেলেন ৳২০০');
        else if (type === 'gotojail') {
          ui.fxNote('⛓ ' + who.name + ' → জেল');
          sound('jail');
        } else if (type === 'tax' || type === 'luxury') {
          ui.fxNote('💸 ' + who.name + ' কর দিতে হবে');
        }
      }

      if (fx.chargedRent) {
        ui.fxNote('🏠 ' + UIUtil.money(fx.chargedRent.amount) + ' ভাড়া');
        sound('rent');
        flashPayment(fx.playerId);
      }
      if (fx.credit) {
        ui.fxNote('💵 +' + UIUtil.money(fx.credit));
      }
      if (fx.card) {
        sound('card');
        if (who) setTimeout(function () { ui.showCard(fx.card, who.name); }, 850);
      }
    }
  }

  // Sounds for things the state broadcast implies but no fx event covers:
  // purchases, building, trades, bankruptcy and the winner.
  var lastSeen = null;

  function sumHouses(p) {
    var h = 0;
    p.holdings.forEach(function (x) { h += x.houses; });
    return h;
  }

  function watchForSounds(state) {
    var prev = lastSeen;
    lastSeen = {
      phase: state.phase,
      winnerId: state.winnerId,
      titles: {},
      houses: {},
      bankrupt: {}
    };
    state.players.forEach(function (p) {
      lastSeen.titles[p.id] = p.holdings.length;
      lastSeen.houses[p.id] = sumHouses(p);
      lastSeen.bankrupt[p.id] = p.bankrupt;
    });
    if (!prev) return;

    state.players.forEach(function (p) {
      if (p.holdings.length > prev.titles[p.id]) sound('buy');
      if (sumHouses(p) > prev.houses[p.id]) sound('build');
      if (p.bankrupt && !prev.bankrupt[p.id]) sound('bankrupt');
    });

    if (state.phase === 'gameOver' && prev.phase !== 'gameOver' && state.winnerId) {
      setTimeout(function () { sound('win'); }, 350);
    }
  }

  // ── go ───────────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
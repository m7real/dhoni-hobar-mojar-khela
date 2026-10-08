/* ui.js — HUD, panels, modals and toasts. */
(function (global) {
  'use strict';

  var GROUP_LABELS = {
    brown: 'ক) গলি',
    lightblue: 'গ) মহল',
    pink: 'হ) গেম',
    orange: 'ঘ) বিলাস',
    red: 'চ) টাওয়ার',
    yellow: 'জ) খেলার মাঠ',
    green: 'ট) বাণিজ্য',
    darkblue: 'ভ) বিজলি',
    rail: 'র) স্টেশন',
    utility: 'ব) সেবা'
  };

  var GROUP_HEX = {
    brown: '#a9714b', lightblue: '#8fd3e8', pink: '#d1478f', orange: '#f08b28',
    red: '#d63b3b', yellow: '#ecd22e', green: '#2fa35c', darkblue: '#2f5fa8',
    rail: '#5f6a76', utility: '#717d8a'
  };

  var TYPE_LABELS = {
    go: 'শুরু', jail: 'জেল', gotojail: 'জেলে যান', parking: 'ফ্রি পার্কিং',
    tax: 'আয়কর', luxury: 'বিলাসিতা কর', chance: 'সুযোগ', chest: 'ভাগ্য',
    property: 'জমি', rail: 'স্টেশন', utility: 'সেবা কেন্দ্র'
  };

  var BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

  function money(n) {
    n = Math.round(n || 0);
    return '৳' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function bnDigits(n) {
    return String(n).replace(/\d/g, function (d) { return BN_DIGITS[+d]; });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── constructor ──────────────────────────────────────────────────────────

  function UI(send) {
    this.send = send;
    this.youId = null;
    this.state = null;
    this.seenLog = 0;
    this.seenChat = 0;
    this.lastTurnId = null;

    this.el = {
      lobby: document.getElementById('lobby'),
      game: document.getElementById('game'),
      nameInput: document.getElementById('nameInput'),
      codeInput: document.getElementById('codeInput'),
      roomCode: document.getElementById('roomCode'),
      turnBanner: document.getElementById('turnBanner'),
      playersList: document.getElementById('playersList'),
      propsPanel: document.getElementById('propsPanel'),
      tradePanel: document.getElementById('tradePanel'),
      tradeBadge: document.getElementById('tradeBadge'),
      logList: document.getElementById('logList'),
      chatList: document.getElementById('chatList'),
      controls: document.getElementById('controls'),
      modal: document.getElementById('modal'),
      modalCard: document.getElementById('modalCard'),
      toasts: document.getElementById('toasts'),
      roundCount: document.getElementById('roundCount'),
      roundMax: document.getElementById('roundMax'),
      diceA: document.getElementById('diceA'),
      diceB: document.getElementById('diceB'),
      fxLayer: document.getElementById('fxLayer'),
      roomList: document.getElementById('roomList')
    };

    this._bind();
  }

  UI.prototype._bind = function () {
    var self = this;

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.dataset.tab;
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-body'), function (p) {
          p.classList.toggle('is-active', p.dataset.panel === name);
        });
      });
    });

    document.getElementById('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = document.getElementById('chatInput');
      var text = input.value.trim();
      if (!text) return;
      self.send('chat', { text: text });
      input.value = '';
    });

    this.el.modal.addEventListener('click', function (e) {
      if (e.target === self.el.modal && self.el.modal.dataset.dismissable === '1') self.closeModal();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.el.modal.dataset.dismissable === '1') self.closeModal();
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 'Enter') {
        var roll = document.getElementById('btnRoll');
        if (roll && !roll.disabled) { e.preventDefault(); roll.click(); }
      }
    });
  };

  // ── screens ──────────────────────────────────────────────────────────────

  UI.prototype.showLobby = function () {
    this.el.lobby.hidden = false;
    this.el.game.hidden = true;
  };

  UI.prototype.showGame = function () {
    this.el.lobby.hidden = true;
    this.el.game.hidden = false;
    this.el.nameInput.blur();
  };

  UI.prototype.renderRooms = function (rooms) {
    var host = this.el.roomList;
    if (!rooms || !rooms.length) {
      host.innerHTML = '<li class="muted">এখন কোনো খালি ঘর নেই।</li>';
      return;
    }
    host.innerHTML = rooms.map(function (r) {
      return '<li><span>রুম <code>' + esc(r.code) + '</code> · ' + r.playerCount + ' জন</span>' +
        '<button class="btn btn-ghost" data-join="' + esc(r.code) + '">যোগ দিন</button></li>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('[data-join]'), function (b) {
      b.addEventListener('click', function () {
        document.getElementById('codeInput').value = b.dataset.join;
        document.getElementById('btnJoin').click();
      });
    });
  };

  // ── render ───────────────────────────────────────────────────────────────

  UI.prototype.render = function (state, youId) {
    this.state = state;
    this.youId = youId;
    this._tradeStamp = Date.now();

    this.el.roomCode.textContent = state.code;

    // Round counter, so the end condition is visible rather than a surprise.
    if (this.el.roundCount) {
      this.el.roundCount.textContent = bnDigits(state.rounds || 0);
      this.el.roundMax.textContent = bnDigits(state.maxRounds || 0);
      var chip = this.el.roundCount.parentNode;
      var near = state.maxRounds && (state.rounds || 0) >= state.maxRounds * 0.8;
      if (chip) chip.classList.toggle('is-near', !!near);
    }

    this._renderTurn(state);
    this._renderPlayers(state);
    this._renderProps(state);
    this._renderTrades(state);
    this._renderLog(state);
    this._renderControls(state);
    this._renderDice(state);
  }

  // Called on the server's one-second tick so offer countdowns stay live.
  UI.prototype.tickTrades = function () {
    if (!this.state) return;
    var panel = this.el.tradePanel;
    if (!panel || panel.offsetParent === null) return;   // tab not visible
    this._tickTradeTimers();
  };;

  UI.prototype._renderTurn = function (state) {
    var me = state.players.find(function (p) { return p.id === this.youId; }.bind(this));
    var cur = state.players.find(function (p) { return p.id === state.currentPlayerId; });
    var banner = this.el.turnBanner;

    if (state.phase === 'lobby') {
      banner.textContent = 'খেলোয়াড়দের অপেক্ষা… (' + state.players.length + '/4)';
      banner.style.color = '';
      return;
    }
    if (state.phase === 'gameOver') {
      var w = state.players.find(function (p) { return p.id === state.winnerId; });
      banner.textContent = w ? '🏆 ' + w.name + ' জিতেছেন!' : 'খেলা শেষ।';
      banner.style.color = '#e0a63a';
      return;
    }
if (!cur) return;

var mine = cur.id === this.youId;
    var away = cur.connected === false;

    if (away) {
      banner.textContent = cur.name + '-এর সংযোগ নেই — অপেক্ষা করছি…';
      banner.style.color = '#e2b341';
      this.lastTurnId = cur.id;
      return;
    }

    banner.textContent = (mine ? 'আপনার চাল' : cur.name + '-এর চাল') + ' — ' + this._phaseText(state);
    banner.style.color = cur.color;

    if (this.lastTurnId && this.lastTurnId !== cur.id && banner.animate) {
      banner.animate(
        [{ transform: 'scale(.94)', opacity: .5 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 260, easing: 'ease-out' }
      );
    }
    this.lastTurnId = cur.id;
    void me;
  };

  UI.prototype._phaseText = function (state) {
    var p = state.pending || {};
    switch (state.phase) {
      case 'awaitRoll': return 'ডাইস ফেলুন';
      case 'awaitBuy': return 'জমি কেনার সিদ্ধান্ত';
      case 'awaitCard': return 'কার্ডের সিদ্ধান্ত';
      case 'awaitEnd': return p.type === 'end' ? 'এগিয়ে যান' : 'চাল শেষ করুন';
      default: return '';
    }
  };

  UI.prototype._renderPlayers = function (state) {
    var self = this;
    var max = Math.max.apply(null, state.players.map(function (p) { return p.netWorth; }).concat([1]));

    var html = state.players.map(function (p) {
      var cls = 'player-card';
      if (p.id === state.currentPlayerId) cls += ' is-turn';
      if (p.id === self.youId) cls += ' is-me';
      if (p.connected === false && !p.bankrupt) cls += ' is-away';
      if (p.bankrupt) cls += ' is-out';

      var badges = '';
      if (p.id === self.youId) badges += '<span class="pc-badge badge-you">আপনি</span>';
      if (p.isBot) badges += '<span class="pc-badge badge-bot">বট</span>';
      if (p.jail) badges += '<span class="pc-badge badge-jail">জেল ' + (p.jailTurns || 0) + '/3</span>';
      if (p.getOutOfJail) badges += '<span class="pc-badge badge-card">🎟</span>';
      if (p.connected === false) badges += '<span class="pc-badge badge-away">সংযোগ নেই</span>';
      if (p.bankrupt) badges += '<span class="pc-badge badge-out">বাদ</span>';

      var pos = state.board[p.position] || {};
      var pct = Math.max(3, Math.round((p.netWorth / max) * 100));

      return '<li class="' + cls + '">' +
        '<span class="pc-dot" style="background:' + p.color + '"></span>' +
        '<span class="pc-main">' +
          '<span class="pc-name">' + esc(p.name) + badges + '</span>' +
          '<span class="pc-meta">' +
            '<span>' + esc(pos.bn || '') + '</span>' +
            '<span>' + p.holdings.length + ' জমি</span>' +
          '</span>' +
          '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
        '</span>' +
        '<span class="pc-cash">' + money(p.cash) + '</span>' +
      '</li>';
    }).join('');

    this.el.playersList.innerHTML = html;
  };

  UI.prototype._renderProps = function (state) {
    var me = state.players.find(function (p) { return p.id === this.youId; }.bind(this));
    if (!me) { this.el.propsPanel.innerHTML = ''; return; }

    if (!me.holdings.length) {
      this.el.propsPanel.innerHTML = '<div class="empty">এখনো কোনো জমি নেই।<br>ডাইস ফেলে খালি জমিতে পা রাখুন!</div>';
      return;
    }

    var myTurn = state.currentPlayerId === this.youId && state.phase !== 'gameOver' && state.phase !== 'lobby';
    var byGroup = {};
    me.holdings.forEach(function (h) {
      var t = state.board[h.tileId];
      var g = t.group || 'other';
      (byGroup[g] = byGroup[g] || []).push({ t: t, h: h });
    });

    var order = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue', 'rail', 'utility', 'other'];
    var html = '';

    order.forEach(function (g) {
      if (!byGroup[g]) return;
      html += '<div class="prop-group-title">' + (GROUP_LABELS[g] || 'অন্যান্য') + '</div>';
      byGroup[g].forEach(function (pair) {
        var t = pair.t, h = pair.h;
        var acts = '';

        if (myTurn && !h.mortgaged) {
          if (h.canBuild) {
            acts += '<button class="btn-mini" data-act="build" data-id="' + t.id + '">বাড়ি</button>';
          }
          if (h.canSell) {
            acts += '<button class="btn-mini" data-act="sell" data-id="' + t.id + '">সরান</button>';
          }
          if (t.mortgageValue) {
            acts += '<button class="btn-mini" data-act="mortgage" data-id="' + t.id + '">বন্ধ (' + money(t.mortgageValue) + ')</button>';
          }
        }
        if (myTurn && h.mortgaged) {
          acts += '<button class="btn-mini" data-act="unmortgage" data-id="' + t.id + '">খুলুন (' + money(t.unmortgageValue) + ')</button>';
        }

        var marks = '';
        if (h.houses >= 5) marks += ' <span class="hotel">🏨 হোটেল</span>';
        else if (h.houses > 0) marks += ' <span class="houses">' + bnDigits(h.houses) + ' নং বাড়ি</span>';

        html += '<div class="prop' + (h.mortgaged ? ' is-mortgaged' : '') + '">' +
          '<span class="prop-bar" style="background:' + (GROUP_HEX[g] || '#5f6a76') + '"></span>' +
          '<span>' +
            '<span class="prop-name" data-open="' + t.id + '">' + esc(t.bn) + '</span>' +
            '<span class="prop-sub">' +
              (t.price ? money(t.price) : (t.amount ? money(t.amount) : TYPE_LABELS[t.type] || '')) +
              marks +
              (h.mortgaged ? ' · বন্ধ' : '') +
            '</span>' +
          '</span>' +
          '<span class="prop-actions">' + acts + '</span>' +
        '</div>';
      });
    });

    this.el.propsPanel.innerHTML = html;
    this._wirePropActions();
  };

  UI.prototype._wirePropActions = function () {
    var self = this;
    var host = this.el.propsPanel;

    Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act;
        var id = parseInt(b.dataset.id, 10);
        if (act === 'build') self.send('build', { tileId: id });
        else if (act === 'sell') self.send('sell', { tileId: id });
        else if (act === 'mortgage') self.send('mortgage', { tileId: id });
        else if (act === 'unmortgage') self.send('unmortgage', { tileId: id });
      });
    });

    Array.prototype.forEach.call(host.querySelectorAll('[data-open]'), function (el) {
      el.addEventListener('click', function () {
        self.showTile(parseInt(el.dataset.open, 10));
      });
    });
  };

  UI.prototype._renderLog = function (state) {
    var host = this.el.logList;
    var logs = state.log || [];
    if (!logs.length) {
      host.innerHTML = '<li class="muted">খবর এখনো নেই।</li>';
      return;
    }
    var start = Math.max(0, logs.length - 40);
    var html = logs.slice(start).map(function (l) {
      return '<li>' + esc(l.bn) + '</li>';
    }).join('');
    if (host.innerHTML !== html) {
      host.innerHTML = html;
      host.parentNode.scrollTop = host.parentNode.scrollHeight;
    }
  };

  UI.prototype._renderDice = function (state) {
    var d = state.dice || [0, 0];
    this.el.diceA.textContent = d[0] ? bnDigits(d[0]) : '–';
    this.el.diceB.textContent = d[1] ? bnDigits(d[1]) : '–';
  };

  UI.prototype._renderControls = function (state) {
    var self = this;
    var me = state.players.find(function (p) { return p.id === this.youId; }.bind(this));
    var mine = state.currentPlayerId === this.youId;
    var out = [];

    if (state.phase === 'lobby') {
      var isFirst = state.players[0] && state.players[0].id === this.youId;
      var hasRoom = state.players.length < 4;
      if (hasRoom) {
        out.push('<button id="btnAddBot" class="btn btn-ghost">🤖 বট যোগ করুন</button>');
      }
      var bots = state.players.filter(function (p) { return p.isBot; });
      if (bots.length) {
        out.push('<button id="btnRemoveBot" class="btn btn-ghost">বট সরান</button>');
      }
      if (isFirst) {
        out.push(state.players.length >= 2
          ? '<button id="btnRoll" class="btn btn-primary">খেলা শুরু করুন</button>'
          : '<div class="hint">আরও ' + (2 - state.players.length) + ' জন খেলোয়াড় বা একজন বট যোগ করুন…</div>');
      } else if (state.players.length < 2) {
        out.push('<div class="hint">হোস্ট শুরু করার জন্য অপেক্ষা করছে…</div>');
      } else {
        out.push('<div class="hint">হোস্ট শুরু করার জন্য অপেক্ষা করছে…</div>');
      }
      this.el.controls.innerHTML = out.join('');

      var addBtn = document.getElementById('btnAddBot');
      if (addBtn) addBtn.addEventListener('click', function () { self.send('addBot'); });
      var rmBtn = document.getElementById('btnRemoveBot');
      if (rmBtn) rmBtn.addEventListener('click', function () { self.send('removeBot'); });
      var s = document.getElementById('btnRoll');
      if (s) s.addEventListener('click', function () { self.send('start'); });
      return;
    }

    if (state.phase === 'gameOver') {
      out.push('<button id="btnRematch" class="btn btn-primary">আবার খেলুন</button>');
      this.el.controls.innerHTML = out.join('');
      var r = document.getElementById('btnRematch');
      if (r) r.addEventListener('click', function () { self.send('rematch'); });
      return;
    }

    if (!mine) {
      var who = state.players.find(function (p) { return p.id === state.currentPlayerId; });
      var waiting = who && who.isBot ? 'বট ভাবছে…' : 'চলছে…';
      out.push('<div class="hint">' + esc(who ? who.name : 'খেলোয়াড়') + '-এর চাল ' + waiting + '</div>');
      this.el.controls.innerHTML = out.join('');
      return;
    }

    var pending = state.pending || {};

    if (state.phase === 'awaitRoll') {
      out.push('<button id="btnRoll" class="btn btn-primary">🎲 ডাইস ফেলুন</button>');
      if (me && me.getOutOfJail) {
        out.push('<button id="btnJail" class="btn btn-accent">🎟 জেল ছাড়ার কার্ড ব্যবহার</button>');
      }
      if (me && me.jail) {
        out.push('<div class="hint">জেলে বসে আছেন — জোড়া ডাইস এলে বের হতে পারবেন।</div>');
      }
    } else if (state.phase === 'awaitBuy' && pending.playerId === this.youId) {
      var tile = state.board[pending.tileId];
      out.push('<button id="btnBuy" class="btn btn-ok">' + esc(tile.bn) + ' কিনুন — ' + money(tile.price) + '</button>');
      out.push('<button id="btnSkip" class="btn btn-ghost">কিনব না</button>');
    } else if (state.phase === 'awaitCard' && pending.playerId === this.youId) {
      out.push('<button id="btnKeepCard" class="btn btn-accent">🎟 কার্ডটি রাখুন</button>');
      out.push('<button id="btnSkip" class="btn btn-ghost">ব্যবহার করব না</button>');
    } else if (state.phase === 'awaitEnd') {
      out.push('<div class="hint">জমি বাড়ি/বন্ধ করতে পারেন — তারপর নিচের বোতাম চাপুন।</div>');
      out.push('<button id="btnNext" class="btn btn-primary">পরের খেলোয়াড় →</button>');
    }

    this.el.controls.innerHTML = out.join('');
    this._wireControls();
  };

  UI.prototype._wireControls = function () {
    var self = this;
    var bind = function (id, ev, data) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function () { self.send(ev, data); });
    };
    bind('btnRoll', 'roll');
    bind('btnNext', 'next');
    bind('btnSkip', 'skip');
    bind('btnJail', 'jailcard');
    var buy = document.getElementById('btnBuy');
    if (buy) {
      buy.addEventListener('click', function () {
        var p = self.state.pending || {};
        self.send('buy', { tileId: p.tileId });
      });
    }
    bind('btnKeepCard', 'useCard');
  };

  // ── chat ─────────────────────────────────────────────────────────────────

  UI.prototype.addChat = function (msg) {
    var li = document.createElement('li');
    if (msg.system) {
      li.className = 'system';
      li.textContent = msg.text;
    } else {
      var b = document.createElement('b');
      b.style.color = msg.color || '#e6edf3';
      b.textContent = msg.name + ':';
      li.appendChild(b);
      li.appendChild(document.createTextNode(msg.text));
    }
    this.el.chatList.appendChild(li);
    var sc = this.el.chatList.parentNode;
    sc.scrollTop = sc.scrollHeight;
  };

  // ── trading ────────────────────────────────────────────────────────────────

  UI.prototype._renderTrades = function (state) {
    var self = this;
    var host = this.el.tradePanel;
    var trades = state.trades || [];
    var me = state.players.find(function (p) { return p.id === this.youId; }.bind(this));

    var badge = this.el.tradeBadge;
    if (badge) {
      badge.textContent = String(trades.length);
      badge.hidden = trades.length === 0;
    }

    // Who can be traded with?
    var partners = state.players.filter(function (p) {
      return p.id !== self.youId && !p.bankrupt && !p.isBot && p.connected !== false;
    });
    var partner = partners[0] || null;

    if (state.phase === 'lobby' || state.phase === 'gameOver') {
      host.innerHTML = '<div class="empty">' +
        (state.phase === 'lobby' ? 'খেলা শুরু হলে ট্রেড করা যাবে।' : 'খেলা শেষ।') + '</div>';
      return;
    }
    if (!partner) {
      host.innerHTML = '<div class="empty">এখন কারও সাথে ট্রেড করা যাচ্ছে না।</div>';
      return;
    }

    var html = '';

    trades.filter(function (t) { return t.direction === 'incoming'; }).forEach(function (t) {
      html += '<div class="trade-card incoming">' +
        '<div class="tc-head">' + esc(t.fromName) + ' → আপনি</div>' +
        '<div class="tc-body">' +
          '<div class="tc-side"><span class="tc-label">আপনি যা দেবেন</span>' + self._sideHtml(t.want) + '</div>' +
          '<div class="tc-side"><span class="tc-label">আপনি যা পাবেন</span>' + self._sideHtml(t.offer) + '</div>' +
        '</div>' +
        '<div class="tc-actions">' +
          '<button class="btn-mini ok" data-trade-accept="' + esc(t.id) + '">গ্রহণ করুন</button>' +
          '<button class="btn-mini" data-trade-decline="' + esc(t.id) + '">বাতিল</button>' +
          '<span class="tc-timer" data-expires="' + t.expiresIn + '"></span>' +
        '</div>' +
      '</div>';
    });

    trades.filter(function (t) { return t.direction === 'outgoing'; }).forEach(function (t) {
      html += '<div class="trade-card outgoing">' +
        '<div class="tc-head">আপনি → ' + esc(t.toName) + '</div>' +
        '<div class="tc-body">' +
          '<div class="tc-side"><span class="tc-label">আপনি দিচ্ছেন</span>' + self._sideHtml(t.offer) + '</div>' +
          '<div class="tc-side"><span class="tc-label">আপনি চাইছেন</span>' + self._sideHtml(t.want) + '</div>' +
        '</div>' +
        '<div class="tc-actions">' +
          '<button class="btn-mini" data-trade-decline="' + esc(t.id) + '">ফিরিয়ে আনুন</button>' +
          '<span class="tc-timer" data-expires="' + t.expiresIn + '"></span>' +
        '</div>' +
      '</div>';
    });

    html += '<div class="prop-group-title">নতুন প্রস্তাব — ' + esc(partner.name) + '</div>';
    html += '<div class="trade-cols">';
    html += '<div><div class="trade-col-title">আপনি দেবেন</div>' +
      this._tradeTilePicker(state, me, 'give') +
      '<label class="trade-cash">টাকা<input type="number" id="tradeGiveCash" min="0" max="' +
      (me ? me.cash : 0) + '" value="0" /></label></div>';
    html += '<div><div class="trade-col-title">আপনি চাইছেন</div>' +
      this._tradeTilePicker(state, partner, 'want') +
      '<label class="trade-cash">টাকা<input type="number" id="tradeWantCash" min="0" value="0" /></label></div>';
    html += '</div>';
    html += '<div class="modal-actions"><button id="btnTradeSend" class="btn btn-primary">প্রস্তাব পাঠান</button></div>';

    host.innerHTML = html;
    this._wireTrade(partner.id);
    this._tickTradeTimers();
  };

  // Titles that can actually be traded: no buildings on them.
  UI.prototype._tradeTilePicker = function (state, owner, side) {
    if (!owner) return '<div class="muted">—</div>';
    var holdings = owner.holdings.filter(function (h) { return h.houses === 0; });
    if (!holdings.length) {
      return '<div class="muted">' +
        (side === 'give' ? 'বিক্রির উপযোগী জমি নেই।' : 'তার কাছে এমন জমি নেই।') + '</div>';
    }
    return holdings.map(function (h) {
      var t = state.board[h.tileId];
      return '<label class="trade-tile' + (h.mortgaged ? ' mortgaged' : '') + '">' +
        '<input type="checkbox" data-trade-tile="' + t.id + '" data-side="' + side + '" />' +
        '<span>' + esc(t.bn) + '</span></label>';
    }).join('');
  };

  UI.prototype._sideHtml = function (side) {
    var self = this;
    var bits = [];
    if (side.cash > 0) bits.push(money(side.cash));
    if (side.tiles && side.tiles.length) {
      bits.push(side.tiles.map(function (id) {
        var t = self.state && self.state.board[id];
        return t ? t.bn : String(id);
      }).join(', '));
    }
    return bits.length ? esc(bits.join(' + ')) : '<span class="muted">কিছু নয়</span>';
  };

  UI.prototype._wireTrade = function (partnerId) {
    var self = this;
    var host = this.el.tradePanel;

    var send = document.getElementById('btnTradeSend');
    if (send) {
      send.addEventListener('click', function () {
        var pick = function (side) {
          var tiles = [].slice
            .call(host.querySelectorAll('input[data-trade-tile][data-side="' + side + '"]'))
            .filter(function (i) { return i.checked; })
            .map(function (i) { return parseInt(i.dataset.tradeTile, 10); });
          var el = document.getElementById('trade' + (side === 'give' ? 'Give' : 'Want') + 'Cash');
          return { cash: Math.max(0, parseInt(el && el.value, 10) || 0), tiles: tiles };
        };
        self.send('tradePropose', {
          toId: partnerId,
          offer: pick('give'),
          want: pick('want')
        });
      });
    }

    Array.prototype.forEach.call(host.querySelectorAll('[data-trade-accept]'), function (b) {
      b.addEventListener('click', function () {
        self.send('tradeAccept', { tradeId: b.dataset.tradeAccept });
      });
    });
    Array.prototype.forEach.call(host.querySelectorAll('[data-trade-decline]'), function (b) {
      b.addEventListener('click', function () {
        self.send('tradeDecline', { tradeId: b.dataset.tradeDecline });
      });
    });
  };

  UI.prototype._tickTradeTimers = function () {
    var self = this;
    var now = Date.now();
    Array.prototype.forEach.call(this.el.tradePanel.querySelectorAll('[data-expires]'), function (el) {
      var secs = Math.max(0, Math.ceil((parseInt(el.dataset.expires, 10) - (now - self._tradeStamp)) / 1000));
      el.textContent = secs > 0 ? secs + 's বাকি' : 'সময় শেষ';
      if (secs <= 0) el.classList.add('over');
    });
  };

  // ── modal ────────────────────────────────────────────────────────────────

  UI.prototype.closeModal = function () {
    this.el.modal.hidden = true;
    this.el.modal.dataset.dismissable = '';
    this.el.modalCard.innerHTML = '';
  };

  UI.prototype._openModal = function (html, dismissable) {
    this.el.modalCard.innerHTML = html;
    this.el.modal.hidden = false;
    this.el.modal.dataset.dismissable = dismissable ? '1' : '';
  };

  UI.prototype.showCard = function (card, playerName) {
    var self = this;
    var isChance = card.deck === 'chance';
    this._openModal(
      '<div class="card-face ' + (isChance ? 'chance' : 'chest') + '">' +
        '<div class="card-kind">' + (isChance ? 'সুযোগ · Chance' : 'ভাগ্য · Bhagya') + '</div>' +
        '<div class="card-bn">' + esc(card.bn) + '</div>' +
        '<div class="card-en">' + esc(card.en) + '</div>' +
      '</div>' +
      '<div class="sub" style="margin-top:14px;text-align:center">' + esc(playerName) + '</div>' +
      (card.action === 'getout'
        ? '<div class="modal-actions"><button id="mKeep" class="btn btn-primary">কার্ডটি রাখুন</button>' +
          '<button id="mSkip" class="btn btn-ghost">ব্যবহার করব না</button></div>'
        : '<div class="modal-actions"><button id="mOk" class="btn btn-primary">ঠিক আছে</button></div>'),
      false
    );

    var ok = document.getElementById('mOk');
    if (ok) ok.addEventListener('click', function () { self.closeModal(); });
    var skip = document.getElementById('mSkip');
    if (skip) {
      skip.addEventListener('click', function () { self.send('skip'); self.closeModal(); });
      document.getElementById('mKeep').addEventListener('click', function () {
        self.send('useCard');
        self.closeModal();
      });
    }
  };

  UI.prototype.showTile = function (id) {
    var state = this.state;
    if (!state) return;
    var t = state.board[id];
    if (!t) return;
    var self = this;

    var owner = state.players.find(function (p) { return p.id === t.ownerId; });
    var rows = '';

    var rentRows = function (list) {
      return list.map(function (r) { return '<div>' + r[0] + ': ' + money(r[1]) + '</div>'; }).join('');
    };

    if (t.type === 'property' && t.rents) {
      var r = t.rents;
      rows += rentRows([
        ['খালি জমির ভাড়া', r[0]],
        ['১ নং বাড়ি', r[1]], ['২ নং বাড়ি', r[2]], ['৩ নং বাড়ি', r[3]],
        ['৪ নং বাড়ি', r[4]], ['হোটেল', r[5]]
      ]);
      rows += '<div style="margin-top:6px">প্রতি বাড়ির দাম: ' + money(t.houseCost) + '</div>';
    } else if (t.type === 'rail' && t.rents) {
      rows += rentRows([['১টি স্টেশন', t.rents[0]], ['২টি', t.rents[1]], ['৩টি', t.rents[2]], ['৪টি', t.rents[3]]]);
    } else if (t.type === 'utility' && t.baseRent) {
      rows += '<div>১টি থাকলে: ডাইস × ' + t.baseRent + '</div>';
      rows += '<div>২টি থাকলে: ডাইস × ' + t.diceRent + '</div>';
    } else if (t.amount) {
      rows += '<div>পরিশোধযোগ্য: ' + money(t.amount) + '</div>';
    } else {
      rows += '<div class="muted">' + esc(TYPE_LABELS[t.type] || t.type) + '</div>';
    }

    var status = owner
      ? (t.mortgaged
          ? '<span style="color:#8b97a5">বন্ধ আছে — ' + esc(owner.name) + '</span>'
          : '<span style="color:' + owner.color + '">মালিক: ' + esc(owner.name) + '</span>' +
            (t.houses >= 5 ? ' · 🏨 হোটেল' : (t.houses ? ' · ' + bnDigits(t.houses) + ' নং বাড়ি' : '')))
      : '<span class="muted">খালি জমি</span>';

    var priceLine = (t.price && owner == null)
      ? '<div style="margin-top:10px">দাম: <b>' + money(t.price) + '</b> · বন্ধ করলে পাবেন ' +
        money(t.mortgageValue || 0) + '</div>'
      : (owner ? '<div style="margin-top:10px">মূল্য ' + money(t.price || 0) +
          ' · খুলতে লাগবে ' + money(t.unmortgageValue || 0) + '</div>' : '');

    this._openModal(
      '<h2>' + esc(t.bn) + '</h2>' +
      '<p class="sub">' + esc(t.name) + ' · ' + esc(GROUP_LABELS[t.group] || TYPE_LABELS[t.type] || '') + '</p>' +
      '<div style="font-size:13px">' + status + '</div>' +
      rows + priceLine +
      '<div class="modal-actions"><button id="tClose" class="btn btn-ghost">বন্ধ করুন</button></div>',
      true
    );

    document.getElementById('tClose').addEventListener('click', function () { self.closeModal(); });
  };

  UI.prototype.showGameOver = function (state) {
    var w = state.players.find(function (p) { return p.id === state.winnerId; });
    var self = this;
    if (!w) return;

    var rows = state.players
      .slice()
      .sort(function (a, b) { return b.netWorth - a.netWorth; })
      .map(function (p, i) {
        return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #2b3542;font-size:13px">' +
          '<span>' + (i + 1) + '. <span style="color:' + p.color + '">' + esc(p.name) + '</span>' +
          (p.bankrupt ? ' <span class="muted">(দেউলিয়া)</span>' : '') + '</span>' +
          '<span>' + money(p.netWorth) + ' · ' + p.holdings.length + ' জমি</span></div>';
      }).join('');

    this._openModal(
      '<div class="winner-crown">🏆</div>' +
      '<h2 style="text-align:center">' + esc(w.name) + ' জিতেছেন!</h2>' +
      '<p class="sub" style="text-align:center">' + w.holdings.length + ' টি জমি · সম্পদ ' + money(w.netWorth) + '</p>' +
      '<div>' + rows + '</div>' +
      '<div class="modal-actions">' +
        '<button id="goRematch" class="btn btn-primary">আবার খেলুন</button>' +
        '<button id="goLobby" class="btn btn-ghost">লবি ফিরে যান</button>' +
      '</div>',
      false
    );

    document.getElementById('goRematch').addEventListener('click', function () {
      self.send('rematch');
      self.closeModal();
    });
    document.getElementById('goLobby').addEventListener('click', function () {
      self.send('leave');
      self.closeModal();
      self.onExit && self.onExit();
    });
  };

  // ── toast + fx ───────────────────────────────────────────────────────────

  UI.prototype.toast = function (text, kind) {
    if (!text) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = text;
    this.el.toasts.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, 2600);
  };

  UI.prototype.fxNote = function (text) {
    var el = document.createElement('div');
    el.className = 'fx-note';
    el.textContent = text;
    this.el.fxLayer.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 320);
    }, 1500);
  };

  global.UI = UI;
  global.UIUtil = { money: money, bnDigits: bnDigits, esc: esc, GROUP_HEX: GROUP_HEX };
})(window);
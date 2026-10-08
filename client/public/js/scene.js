/* scene.js — Three.js board, tokens and dice for Dhoni Hobar Mojar Khela. */
(function (global) {
  'use strict';

  var TILE = 1;          // tile edge length
  var HALF = 5;          // distance from centre to the centre-line of the tile ring
  var TILE_H = 0.22;     // tile thickness
  var TABLE_TOP = -0.02;

  var GROUP_COLORS = {
    brown: '#a9714b',
    lightblue: '#8fd3e8',
    pink: '#d1478f',
    orange: '#f08b28',
    red: '#d63b3b',
    yellow: '#ecd22e',
    green: '#2fa35c',
    darkblue: '#2f5fa8',
    rail: '#5f6a76',
    utility: '#717d8a'
  };

  var TYPE_COLORS = {
    go: '#d9a441',
    jail: '#8a4b4b',
    gotojail: '#b5522f',
    parking: '#3f7d5c',
    tax: '#7a4b52',
    luxury: '#7a4b52',
    chance: '#c9873a',
    chest: '#3a7ea8'
  };

  var OWNABLE = { property: 1, rail: 1, utility: 1 };
  var MAX_HOUSES = 5;

  // ── board geometry ───────────────────────────────────────────────────────

  function tilePos(i) {
    var side = Math.floor(i / 10);
    var k = i % 10;
    if (side === 0) return { x: -HALF + k, z: HALF };
    if (side === 1) return { x: HALF, z: HALF - k };
    if (side === 2) return { x: HALF - k, z: -HALF };
    return { x: -HALF, z: -HALF + k };
  }

  function innerDir(i) {
    var side = Math.floor(i / 10);
    return [{ x: 0, z: -1 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 0 }][side];
  }

  function outerDir(i) {
    var d = innerDir(i);
    return { x: -d.x, z: -d.z };
  }

  function tangent(i) {
    var d = innerDir(i);
    return d.x !== 0 ? { x: 0, z: 1 } : { x: 1, z: 0 };
  }

  // Face order for BoxGeometry materials: +X, -X, +Y, -Y, +Z, -Z
  var FACE_UP_ROT = {
    1: new THREE.Euler(0, 0, 0),
    2: new THREE.Euler(-Math.PI / 2, 0, 0),
    3: new THREE.Euler(0, 0, Math.PI / 2),
    4: new THREE.Euler(0, 0, -Math.PI / 2),
    5: new THREE.Euler(Math.PI / 2, 0, 0),
    6: new THREE.Euler(Math.PI, 0, 0)
  };

  // ── pip textures ─────────────────────────────────────────────────────────

  function pipCanvas(value) {
    var S = 128;
    var c = document.createElement('canvas');
    c.width = c.height = S;
    var g = c.getContext('2d');

    g.fillStyle = '#f6f2e6';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = '#c9c0aa';
    g.lineWidth = 5;
    g.strokeRect(3, 3, S - 6, S - 6);

    var pip = function (u, v) {
      g.beginPath();
      g.arc(u * S, v * S, S * 0.095, 0, Math.PI * 2);
      g.fillStyle = '#16191d';
      g.fill();
    };

    var P = [[0.26, 0.26], [0.26, 0.5], [0.26, 0.74], [0.5, 0.26], [0.5, 0.5],
             [0.5, 0.74], [0.74, 0.26], [0.74, 0.5], [0.74, 0.74]];
    var layouts = {
      1: [[4]],
      2: [[0, 8]],
      3: [[0, 4, 8]],
      4: [[0, 2, 6, 8]],
      5: [[0, 2, 4, 6, 8]],
      6: [[0, 2, 3, 5, 6, 8]]
    };
    (layouts[value] || []).forEach(function (idx) {
      pip(P[idx][0], P[idx][1]);
    });
    return c;
  }

  function diceMaterials() {
    // Opposite faces add up to seven.
    var byFace = [3, 4, 1, 6, 2, 5];
    var cache = {};
    return byFace.map(function (v) {
      if (!cache[v]) {
        var tex = new THREE.CanvasTexture(pipCanvas(v));
        tex.colorSpace = THREE.SRGBColorSpace;
        cache[v] = new THREE.MeshPhongMaterial({ map: tex, shininess: 26 });
      }
      return cache[v];
    });
  }

  // ── centre nameplate ─────────────────────────────────────────────────────

  function nameplateTexture() {
    var W = 1024, H = 512;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');

    var grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#2b2116');
    grad.addColorStop(0.5, '#3b2c1b');
    grad.addColorStop(1, '#241b12');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    g.strokeStyle = 'rgba(224,166,58,.65)';
    g.lineWidth = 6;
    g.strokeRect(18, 18, W - 36, H - 36);
    g.strokeStyle = 'rgba(224,166,58,.28)';
    g.lineWidth = 2;
    g.strokeRect(40, 40, W - 80, H - 80);

    g.textAlign = 'center';
    g.fillStyle = '#e0a63a';
    g.font = '700 92px "Hind Siliguri","Noto Sans Bengali",sans-serif';
    g.fillText('ধনি হবার মোজার খেলা', W / 2, H / 2 - 6);

    g.fillStyle = 'rgba(230,237,243,.62)';
    g.font = '600 34px "Segoe UI",sans-serif';
    g.fillText('D H O N I   H O B A R   M O J A R   K H E L A', W / 2, H / 2 + 54);

    g.fillStyle = 'rgba(224,166,58,.75)';
    g.font = '600 26px "Segoe UI",sans-serif';
    g.fillText('ঢাকা · চট্টগ্রাম · সিলেট · খুলনা', W / 2, H / 2 + 106);

    var tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ── pawn ─────────────────────────────────────────────────────────────────

  function buildPawn(color) {
    var mat = new THREE.MeshPhongMaterial({ color: color, shininess: 60, specular: 0x666666 });
    var g = new THREE.Group();

    var base = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.175, 0.07, 20), mat);
    base.position.y = 0.035;
    g.add(base);

    var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.17, 16), mat);
    stem.position.y = 0.15;
    g.add(stem);

    var body = new THREE.Mesh(new THREE.ConeGeometry(0.135, 0.2, 18), mat);
    body.position.y = 0.30;
    g.add(body);

    var head = new THREE.Mesh(new THREE.SphereGeometry(0.098, 18, 14), mat);
    head.position.y = 0.44;
    g.add(head);

    g.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  }

  // ── scene ────────────────────────────────────────────────────────────────

  function Scene3D(canvas, labelHost) {
    this.canvas = canvas;
    this.labelHost = labelHost;

    this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0b0f14, 26, 46);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

    this.cam = { az: -0.42, pol: 0.72, r: 17.5, target: new THREE.Vector3(0, 0, 0) };
    this.camHome = { az: this.cam.az, pol: this.cam.pol, r: this.cam.r };

    this.tiles = [];
    this.tileGroups = [];
    this.houseGroups = [];
    this.labels = [];
    this.tokens = new Map();
    this.dice = [];

    this.highlight = null;
    this.onTileClick = null;

    this._buildLights();
    this._buildTable();
    this._buildRing();
    this._buildCentre();
    this._buildDice();
    this._buildHighlight();
    this._bindControls();

    this._resize();
    window.addEventListener('resize', this._resizeBound = this._resize.bind(this));

    this._loop = this._loop.bind(this);
    this.clock = new THREE.Clock();
    requestAnimationFrame(this._loop);
  }

  Scene3D.prototype._buildLights = function () {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    var hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2a1f16, 0.5);
    this.scene.add(hemi);

    var key = new THREE.DirectionalLight(0xfff2dc, 1.15);
    key.position.set(7, 13, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    var c = key.shadow.camera;
    c.left = -10; c.right = 10; c.top = 10; c.bottom = -10;
    c.near = 1; c.far = 40;
    key.shadow.bias = -0.0012;
    this.scene.add(key);

    var rim = new THREE.DirectionalLight(0x7fa8ff, 0.35);
    rim.position.set(-8, 6, -9);
    this.scene.add(rim);
  };

  Scene3D.prototype._buildTable = function () {
    var top = new THREE.Mesh(
      new THREE.BoxGeometry(13.4, 0.5, 13.4),
      new THREE.MeshPhongMaterial({ color: 0x1b232d, shininess: 14 })
    );
    top.position.y = TABLE_TOP - 0.25;
    top.receiveShadow = true;
    this.scene.add(top);

    var skirt = new THREE.Mesh(
      new THREE.BoxGeometry(13.9, 0.9, 13.9),
      new THREE.MeshPhongMaterial({ color: 0x11161d })
    );
    skirt.position.y = TABLE_TOP - 0.95;
    skirt.receiveShadow = true;
    this.scene.add(skirt);

    var felt = new THREE.Mesh(
      new THREE.PlaneGeometry(9.4, 9.4),
      new THREE.MeshPhongMaterial({ color: 0x16323f, shininess: 4 })
    );
    felt.rotation.x = -Math.PI / 2;
    felt.position.y = TABLE_TOP + 0.005;
    felt.receiveShadow = true;
    this.scene.add(felt);
  };

  Scene3D.prototype._buildRing = function () {
    var tileGeo = new THREE.BoxGeometry(TILE * 0.97, TILE_H, TILE * 0.97);
    var barGeo = new THREE.BoxGeometry(0.86, 0.075, 0.2);
    var ownerGeo = new THREE.BoxGeometry(0.84, 0.1, 0.09);

    for (var i = 0; i < 40; i++) {
      var p = tilePos(i);
      var grp = new THREE.Group();
      grp.position.set(p.x, 0, p.z);
      grp.userData.tileId = i;

      var isCorner = i % 10 === 0;
      var base = new THREE.Mesh(
        new THREE.BoxGeometry(isCorner ? 1.06 : 0.97, TILE_H, isCorner ? 1.06 : 0.97),
        new THREE.MeshPhongMaterial({ color: 0xe9e3d6, shininess: 8 })
      );
      base.position.y = TABLE_TOP + TILE_H / 2;
      base.castShadow = true;
      base.receiveShadow = true;
      base.userData.tileId = i;
      grp.add(base);
      this.tiles.push(base);

      // Colour band on the inner edge, for the property groups.
      var idn = innerDir(i);
      var band = new THREE.Mesh(barGeo, new THREE.MeshPhongMaterial({ color: 0x555f6a }));
      band.position.set(idn.x * 0.33, TABLE_TOP + TILE_H + 0.035, idn.z * 0.33);
      band.rotation.y = (Math.floor(i / 10)) * (Math.PI / 2);
      band.visible = false;
      grp.add(band);

      // Owner stripe on the outer edge.
      var od = outerDir(i);
      var own = new THREE.Mesh(ownerGeo, new THREE.MeshPhongMaterial({ color: 0x000000 }));
      own.position.set(od.x * 0.42, TABLE_TOP + TILE_H + 0.02, od.z * 0.42);
      own.rotation.y = (Math.floor(i / 10)) * (Math.PI / 2);
      own.visible = false;
      grp.add(own);

      var houses = new THREE.Group();
      grp.add(houses);
      this.houseGroups.push(houses);
      this.tileGroups.push(grp);

      this.scene.add(grp);
      this.labels.push(this._makeLabel(i, grp));
    }
  };

  Scene3D.prototype._makeLabel = function (i, grp) {
    var el = document.createElement('div');
    el.className = 'tile-label';
    el.dataset.tileId = String(i);
    el.textContent = '—';
    var self = this;
    el.addEventListener('click', function () {
      if (self.onTileClick) self.onTileClick(i);
    });
    this.labelHost.appendChild(el);
    return el;
  };

  Scene3D.prototype._buildCentre = function () {
    var plate = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 2.3),
      new THREE.MeshBasicMaterial({ map: nameplateTexture(), transparent: true })
    );
    plate.rotation.x = -Math.PI / 2;
    plate.position.set(0, TABLE_TOP + 0.02, -0.5);
    this.scene.add(plate);

    // Four subtle corner studs for depth.
    var studGeo = new THREE.CylinderGeometry(0.11, 0.14, 0.16, 16);
    var studMat = new THREE.MeshPhongMaterial({ color: 0xcaa04a, shininess: 70 });
    [[-4.2, -4.2], [4.2, -4.2], [-4.2, 4.2], [4.2, 4.2]].forEach(function (p) {
      var s = new THREE.Mesh(studGeo, studMat);
      s.position.set(p[0], TABLE_TOP + 0.08, p[1]);
      s.castShadow = true;
      this.scene.add(s);
    }, this);
  };

  Scene3D.prototype._buildDice = function () {
    var mats = diceMaterials();
    var geo = new THREE.BoxGeometry(0.52, 0.52, 0.52);
    var self = this;
    [-1.05, 1.05].forEach(function (x, idx) {
      var d = new THREE.Mesh(geo, mats);
      d.position.set(x, TABLE_TOP + 1.35, 1.85);
      d.castShadow = true;
      d.visible = false;
      d.userData = { value: 0, anim: null };
      self.scene.add(d);
      self.dice.push(d);
    });
  };

  Scene3D.prototype._buildHighlight = function () {
    this.highlight = new THREE.Mesh(
      new THREE.BoxGeometry(TILE * 0.99, 0.045, TILE * 0.99),
      new THREE.MeshBasicMaterial({ color: 0xe0a63a, transparent: true, opacity: 0.55 })
    );
    this.highlight.position.y = TABLE_TOP + TILE_H + 0.055;
    this.highlight.visible = false;
    this.scene.add(this.highlight);
  };

  // ── controls ─────────────────────────────────────────────────────────────

  Scene3D.prototype._bindControls = function () {
    var self = this;
    var el = this.canvas;
    var dragging = false;
    var moved = 0;
    var last = { x: 0, y: 0 };

    el.addEventListener('pointerdown', function (e) {
      dragging = true;
      moved = 0;
      last.x = e.clientX;
      last.y = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.parentNode.classList.add('dragging');
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - last.x;
      var dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last.x = e.clientX;
      last.y = e.clientY;
      self.cam.az -= dx * 0.006;
      self.cam.pol = Math.max(0.16, Math.min(1.36, self.cam.pol - dy * 0.005));
    });

    function release(e) {
      if (!dragging) return;
      dragging = false;
      el.parentNode.classList.remove('dragging');
      try { el.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved < 6) self._pick(e);
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);

    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.cam.r = Math.max(8.5, Math.min(34, self.cam.r + e.deltaY * 0.014));
    }, { passive: false });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  };

  Scene3D.prototype._pick = function (e) {
    if (!this.onTileClick) return;
    var rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    var hits = this.raycaster.intersectObjects(this.tiles, false);
    if (hits.length) this.onTileClick(hits[0].object.userData.tileId);
  };

  Scene3D.prototype.resetCamera = function () {
    this.cam.az = this.camHome.az;
    this.cam.pol = this.camHome.pol;
    this.cam.r = this.camHome.r;
  };

  Scene3D.prototype.focusTile = function (id) {
    var p = tilePos(id);
    this.cam.target.set(p.x * 0.35, 0, p.z * 0.35);
    this.cam.r = Math.min(this.cam.r, 15);
  };

  Scene3D.prototype._updateCamera = function () {
    var c = this.cam;
    var sp = Math.sin(c.pol), cp = Math.cos(c.pol);
    this.camera.position.set(
      c.target.x + c.r * sp * Math.sin(c.az),
      c.target.y + c.r * cp,
      c.target.z + c.r * sp * Math.cos(c.az)
    );
    this.camera.lookAt(c.target);
  };

  Scene3D.prototype._resize = function () {
    var host = this.canvas.parentNode;
    var w = host.clientWidth || 1;
    var h = host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.hostW = w;
    this.hostH = h;
  };

  // ── board state ──────────────────────────────────────────────────────────

  // state.board = [{id,type,group,ownerId,mortgaged,houses}]
  Scene3D.prototype.setBoard = function (state) {
    var self = this;
    var ownerColor = {};
    (state.players || []).forEach(function (p) { ownerColor[p.id] = p.color; });

    state.board.forEach(function (t) {
      var grp = self.tileGroups[t.id];
      var base = self.tiles[t.id];
      var band = grp.children[1];
      var owner = grp.children[2];
      var houses = self.houseGroups[t.id];

      var tint = OWNABLE[t.type] ? 0xe9e3d6 : (TYPE_COLORS[t.type] || 0x3b4552);
      if (t.ownerId && !t.mortgaged) tint = 0xdfd8c8;
      base.material.color.setHex(tint);

      if (OWNABLE[t.type]) {
        band.visible = true;
        band.material.color.set(GROUP_COLORS[t.group] || '#5f6a76');
        band.material.opacity = t.mortgaged ? 0.4 : 1;
        band.material.transparent = t.mortgaged;
      } else {
        band.visible = false;
      }

      if (t.ownerId) {
        owner.visible = true;
        owner.material.color.set(ownerColor[t.ownerId] || '#ffffff');
      } else {
        owner.visible = false;
      }

      // rebuild houses
      while (houses.children.length) {
        var old = houses.children.pop();
        if (old.geometry) old.geometry.dispose();
        houses.remove(old);
      }
      if (t.houses > 0 && !t.mortgaged) self._buildHouses(houses, t);
    });
  };

  var HOUSE_OFFSETS = {
    1: [0],
    2: [-0.21, 0.21],
    3: [-0.3, 0, 0.3],
    4: [-0.36, -0.12, 0.12, 0.36]
  };

  Scene3D.prototype._buildHouses = function (parent, tile) {
    var id = tile.id;
    var idn = innerDir(id);
    var tg = tangent(id);
    var isHotel = tile.houses >= MAX_HOUSES;

    if (isHotel) {
      var h = new THREE.Mesh(
        new THREE.BoxGeometry(0.56, 0.3, 0.56),
        new THREE.MeshPhongMaterial({ color: 0xd63b3b, shininess: 40 })
      );
      h.position.set(idn.x * 0.2, TABLE_TOP + TILE_H + 0.15, idn.z * 0.2);
      h.castShadow = true;
      parent.add(h);
      return;
    }

    var n = Math.max(1, Math.min(4, tile.houses));
    var offs = HOUSE_OFFSETS[n];
    for (var i = 0; i < offs.length; i++) {
      var m = new THREE.Mesh(
        new THREE.BoxGeometry(0.17, 0.17, 0.17),
        new THREE.MeshPhongMaterial({ color: 0x2fa35c, shininess: 40 })
      );
      m.position.set(
        idn.x * 0.24 + tg.x * offs[i],
        TABLE_TOP + TILE_H + 0.085,
        idn.z * 0.24 + tg.z * offs[i]
      );
      m.castShadow = true;
      parent.add(m);
    }
  };

  // ── tokens ───────────────────────────────────────────────────────────────

  // Shortest signed distance around the ring, so a "back 3 spaces" card
  // animates backwards instead of crawling the long way round.
  function shortestDelta(from, to) {
    var d = to - from;
    if (d > 20) d -= 40;
    if (d < -20) d += 40;
    return d;
  }

  Scene3D.prototype.syncTokens = function (state, animate) {
    var self = this;
    var seen = new Set();
    this.pos = this.pos || {};

    // Spread players that share a tile so they do not overlap.
    var byTile = {};
    state.players.forEach(function (p) {
      if (p.bankrupt) return;
      (byTile[p.position] = byTile[p.position] || []).push(p);
    });

    state.players.forEach(function (p) {
      if (p.bankrupt) return;
      seen.add(p.id);

      var tok = self.tokens.get(p.id);
      var fresh = false;
      if (!tok) {
        tok = buildPawn(p.color);
        self.scene.add(tok);
        self.tokens.set(p.id, tok);
        fresh = true;
      }

      var mates = byTile[p.position] || [];
      var idx = mates.indexOf(p);
      var idn = innerDir(p.position);
      var tg = tangent(p.position);
      var off = (idx - (mates.length - 1) / 2) * 0.26;
      var spread = 0.16 + Math.abs(off) * 0.55;
      var tp = tilePos(p.position);
      var target = new THREE.Vector3(
        tp.x + idn.x * spread + tg.x * off,
        TABLE_TOP,
        tp.z + idn.z * spread + tg.z * off
      );

      var prev = self.pos[p.id];
      self.pos[p.id] = p.position;

      // Being sent to jail teleports rather than walks.
      var teleported = p.jail && prev != null && prev !== p.position;

      if (fresh || !animate || prev == null || prev === p.position || teleported) {
        tok.anim = null;
        tok.position.copy(target);
      } else {
        var delta = shortestDelta(prev, p.position);
        self._walk(tok, prev, delta, target);
      }

      tok.rotation.z = p.jail ? 0.15 : 0;
      if (p.jail) tok.position.y = TABLE_TOP;
    });

    // Drop tokens for players who left or went bust.
    this.tokens.forEach(function (tok, id) {
      if (seen.has(id)) return;
      self.scene.remove(tok);
      tok.traverse(function (o) { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      self.tokens.delete(id);
      if (self.pos) delete self.pos[id];
    });
  };

  // Walk `delta` tiles around the ring from `fromTile`, ending on `targetPos`.
  Scene3D.prototype._walk = function (tok, fromTile, delta, targetPos) {
    var path = [];
    var n = Math.abs(delta);
    for (var s = 0; s <= n; s++) {
      path.push(((fromTile + Math.sign(delta) * s) % 40 + 40) % 40);
    }
    tok.anim = {
      path: path,
      t: 0,
      dur: 0.115 * n + 0.2,
      target: targetPos.clone()
    };
  };

  Scene3D.prototype._stepTokens = function (dt) {
    var self = this;
    this.tokens.forEach(function (tok) {
      var a = tok.anim;
      if (!a) return;
      a.t += dt;
      var k = Math.min(1, a.t / a.dur);
      var eased = k < 0.5 ? 2 * k * k : -1 + (4 - 2 * k) * k; // easeInOutQuad

      var total = a.path.length - 1;
      var pos = eased * total;
      var i = Math.min(total, Math.floor(pos));
      var frac = pos - i;

      var from = tilePos(a.path[i]);
      var to = tilePos(a.path[Math.min(i + 1, total)]);
      var hop = Math.sin(frac * Math.PI) * 0.22;

      tok.position.x = from.x + (to.x - from.x) * frac;
      tok.position.z = from.z + (to.z - from.z) * frac;
      tok.position.y = TABLE_TOP + hop;

      // face the direction of travel
      if (i < total) {
        var dx = to.x - from.x, dz = to.z - from.z;
        if (dx || dz) tok.rotation.y = Math.atan2(dx, dz);
      }

      if (k >= 1) {
        tok.anim = null;
        tok.position.copy(a.target);
        if (tok.queueTarget) {
          var t = tok.queueTarget;
          tok.queueTarget = null;
          tok.position.copy(t);
        }
      }
    });
    void self;
  };

  // ── dice ─────────────────────────────────────────────────────────────────

  Scene3D.prototype.rollDice = function (values) {
    var self = this;
    this.dice.forEach(function (d, i) {
      var v = values && values[i] ? values[i] : 0;
      if (!v) { d.visible = false; return; }
      d.visible = true;
      d.userData.value = v;
      d.userData.anim = {
        t: 0,
        dur: 1.0,
        target: FACE_UP_ROT[v] ? FACE_UP_ROT[v].clone() : new THREE.Euler(0, 0, 0)
      };
    });
    void self;
  };

  Scene3D.prototype._stepDice = function (dt) {
    this.dice.forEach(function (d, i) {
      var a = d.userData.anim;
      if (!a) return;
      a.t += dt;
      var k = Math.min(1, a.t / a.dur);

      if (k < 0.72) {
        d.rotation.x += dt * 17;
        d.rotation.y += dt * 13;
        d.rotation.z += dt * 9;
        d.position.y = TABLE_TOP + 1.35 + Math.abs(Math.sin(a.t * 22)) * 0.5;
      } else {
        var s = (k - 0.72) / 0.28;
        var e = 1 - Math.pow(1 - s, 3);
        d.rotation.x = a.target.x;
        d.rotation.y = a.target.y;
        d.rotation.z = a.target.z;
        d.position.y = TABLE_TOP + 0.28 + (1 - e) * 1.07;
      }
      if (k >= 1) d.userData.anim = null;
      void i;
    });
  };

  // ── screen position of a token, for effects that overlay the board ──

  Scene3D.prototype.tokenScreen = function (playerId) {
    var tok = this.tokens.get(playerId);
    if (!tok || !this.hostW) return null;
    var v = new THREE.Vector3();
    tok.getWorldPosition(v);
    v.project(this.camera);
    if (v.z > 1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * this.hostW,
      y: (-v.y * 0.5 + 0.5) * this.hostH
    };
  };

  // ── highlight ────────────────────────────────────────────────────────────

  Scene3D.prototype.setHighlight = function (id, color) {
    if (id == null) { this.highlight.visible = false; return; }
    var p = tilePos(id);
    this.highlight.position.set(p.x, TABLE_TOP + TILE_H + 0.06, p.z);
    this.highlight.material.color.set(color || '#e0a63a');
    this.highlight.visible = true;
  };

  // ── labels ───────────────────────────────────────────────────────────────

  Scene3D.prototype.setLabelText = function (id, text, cls) {
    var el = this.labels[id];
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
    el.className = 'tile-label' + (cls ? ' ' + cls : '');
  };

  Scene3D.prototype._projectLabels = function () {
    if (!this.hostW) return;
    var v = new THREE.Vector3();
    for (var i = 0; i < 40; i++) {
      var el = this.labels[i];
      var p = tilePos(i);
      v.set(p.x, TABLE_TOP + TILE_H + 0.02, p.z).project(this.camera);
      var x = (v.x * 0.5 + 0.5) * this.hostW;
      var y = (-v.y * 0.5 + 0.5) * this.hostH;
      var behind = v.z > 1;
      el.style.display = behind ? 'none' : 'block';
      if (!behind) {
        el.style.left = x.toFixed(1) + 'px';
        el.style.top = y.toFixed(1) + 'px';
      }
    }
  };

  // ── frame ────────────────────────────────────────────────────────────────

  Scene3D.prototype._loop = function () {
    var dt = Math.min(this.clock.getDelta(), 0.05);
    this._updateCamera();
    this._stepTokens(dt);
    this._stepDice(dt);
    if (this.highlight && this.highlight.visible) {
      this.highlight.material.opacity = 0.4 + Math.sin(performance.now() / 260) * 0.18;
    }
    this.renderer.render(this.scene, this.camera);
    this._projectLabels();
    requestAnimationFrame(this._loop);
  };

  global.Scene3D = Scene3D;
  global.BoardGeo = { tilePos: tilePos, innerDir: innerDir, tangent: tangent, TILE: TILE, HALF: HALF };
})(window);
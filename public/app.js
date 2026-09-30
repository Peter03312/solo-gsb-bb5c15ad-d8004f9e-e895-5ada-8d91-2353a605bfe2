/* app.js —— 服装裁片排版编辑器前端（无框架，Canvas 2D） */
(function () {
  'use strict';
  var G = window.Geom;

  /* ================= 状态 ================= */
  var state = {
    revision: null,
    locked: false,
    doc: null,                 // {fabric, defects:[{id,name,points}], pieces:[...], placements:[...]}
    mode: 'setup',             // setup | layout
    dirty: false,
    conflicts: null,           // 最近一次保存被拒返回的冲突
    selectedId: null,
    draw: null,                // {kind:'defect'|'piece', points:[]}
    view: { scale: 4, ox: 40, oy: 40 }, // 屏幕像素 = (世界坐标) 换算；y 翻转
    showMargin: false,
    spaceDown: false,
    dragging: null,
    panning: null,
    hoverId: null
  };

  var PIECE_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#ea580c', '#4d7c0f', '#0891b2', '#a16207'];
  function pieceColor(id) {
    if (!state.doc) return '#888';
    var i = state.doc.pieces.findIndex(function (p) { return p.id === id; });
    return PIECE_COLORS[(i < 0 ? 0 : i) % PIECE_COLORS.length];
  }

  /* ================= DOM ================= */
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('canvas'), ctx = canvas.getContext('2d');

  /* ================= 坐标变换 =================
   * 世界（布面，cm，原点左下，y 向上） -> 屏幕（原点左上，y 向下）
   * sx = ox + wx * scale ; sy = oy + (H - wy) * scale
   */
  function W2S(p) {
    var H = state.doc.fabric.height;
    return { x: state.view.ox + p.x * state.view.scale, y: state.view.oy + (H - p.y) * state.view.scale };
  }
  function S2W(p) {
    var H = state.doc.fabric.height;
    return { x: (p.x - state.view.ox) / state.view.scale, y: H - (p.y - state.view.oy) / state.view.scale };
  }

  /* ================= API ================= */
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().then(function (d) { return { status: r.status, d: d }; });
    });
  }

  function loadBoard() {
    return api('GET', '/api/board').then(function (r) {
      if (r.status !== 200) throw new Error(r.d.message || '读取版图失败');
      applyServerRow(r.d);
    });
  }
  function applyServerRow(row) {
    state.revision = row.revision;
    state.locked = row.locked;
    state.doc = row.doc;
    state.dirty = false;
    state.conflicts = null;
    if (state.selectedId && !state.doc.placements.some(function (p) { return p.id === state.selectedId; })) {
      state.selectedId = null;
    }
    renderAll();
  }

  function markDirty() {
    state.dirty = true;
    state.conflicts = null;
    renderChrome();
  }
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty && !state.locked) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ================= 画布尺寸 ================= */
  function resizeCanvas() {
    var wrap = canvas.parentElement;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = wrap.clientWidth * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width = wrap.clientWidth + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function fitView() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var fw = state.doc.fabric.width, fh = state.doc.fabric.height;
    var s = Math.min((w - 80) / fw, (h - 90) / fh);
    state.view.scale = Math.max(0.2, s);
    state.view.ox = (w - fw * state.view.scale) / 2;
    state.view.oy = (h - fh * state.view.scale) / 2;
    draw();
  }

  /* ================= 绘制 ================= */
  function polyPath(points) {
    ctx.beginPath();
    points.forEach(function (p, i) {
      var s = W2S(p);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  function draw() {
    if (!state.doc) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    drawGrid();
    drawFabric();
    drawDefects();
    drawPlacements();
    drawDraft();
    drawConflicts();
  }

  function drawGrid() {
    var f = state.doc.fabric;
    var tl = W2S({ x: 0, y: f.height }), br = W2S({ x: f.width, y: 0 });
    // 布外阴影
    ctx.fillStyle = '#dde1e7';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    ctx.save();
    ctx.beginPath(); ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y); ctx.clip();
    ctx.fillStyle = '#fbf7ee';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

    var step = state.view.scale >= 2 ? 10 : state.view.scale >= 0.8 ? 50 : 100;
    ctx.strokeStyle = '#e7dfce'; ctx.lineWidth = 1;
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#b4a583';
    for (var x = 0; x <= f.width + 0.01; x += step) {
      var a = W2S({ x: x, y: 0 });
      ctx.beginPath(); ctx.moveTo(a.x, tl.y); ctx.lineTo(a.x, br.y); ctx.stroke();
      if (x > 0) ctx.fillText(x + '', a.x + 2, br.y - 4);
    }
    for (var y = 0; y <= f.height + 0.01; y += step) {
      var b = W2S({ x: 0, y: y });
      ctx.beginPath(); ctx.moveTo(tl.x, b.y); ctx.lineTo(br.x, b.y); ctx.stroke();
      if (y > 0) ctx.fillText(y + '', tl.x + 3, b.y - 2);
    }
    // 原点标注
    var o = W2S({ x: 0, y: 0 });
    ctx.fillText('(0,0)', o.x + 3, o.y - 4);
    ctx.restore();
  }

  function drawFabric() {
    var f = state.doc.fabric;
    var tl = W2S({ x: 0, y: f.height }), br = W2S({ x: f.width, y: 0 });
    ctx.strokeStyle = '#8d6e3f'; ctx.lineWidth = 2.5;
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }

  function hatch(points, color) {
    var bb = G.bbox(points);
    var tl = W2S({ x: bb.minX, y: bb.maxY }), br = W2S({ x: bb.maxX, y: bb.minY });
    ctx.save();
    polyPath(points); ctx.clip();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha = .7;
    for (var x = tl.x - (br.y - tl.y); x < br.x; x += 7) {
      ctx.beginPath(); ctx.moveTo(x, tl.y); ctx.lineTo(x + (br.y - tl.y), br.y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawDefects() {
    state.doc.defects.forEach(function (d) {
      var bad = state.conflicts && state.conflicts.some(function (c) { return c.defectId === d.id; });
      polyPath(d.points);
      ctx.fillStyle = bad ? 'rgba(220,38,38,.18)' : 'rgba(154,52,18,.10)';
      ctx.fill();
      hatch(d.points, bad ? '#dc2626' : '#b45309');
      ctx.strokeStyle = bad ? '#dc2626' : '#9a3412'; ctx.lineWidth = bad ? 2.5 : 1.5;
      ctx.setLineDash([]); ctx.stroke();
      var c = W2S(G.centroid(d.points));
      ctx.fillStyle = bad ? '#b91c1c' : '#9a3412'; ctx.font = 'bold 11px sans-serif';
      ctx.fillText('⚠ ' + (d.name || d.id), c.x - 14, c.y);
    });
  }

  function drawPlacements() {
    state.doc.placements.forEach(function (pl) {
      var piece = pieceById(pl.pieceId);
      if (!piece) return;
      var selected = pl.id === state.selectedId;
      var hovered = pl.id === state.hoverId;
      var bad = state.conflicts && state.conflicts.some(function (c) {
        return c.target === pl.id || (c.targets && c.targets.indexOf(pl.id) >= 0);
      });
      var color = bad ? '#dc2626' : pieceColor(pl.pieceId);

      // 间距圈（仅选中或开关打开时）
      if (state.showMargin && piece.margin > 0) {
        drawHalo(pl.points, piece.margin, selected ? color : '#94a3b8');
      }
      polyPath(pl.points);
      ctx.fillStyle = hexA(color, selected ? .28 : .14);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 3 : (hovered ? 2.2 : 1.6);
      ctx.setLineDash([]);
      ctx.stroke();

      if (bad) {
        // 冲突片加红色粗虚线外框
        polyPath(pl.points);
        ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 3; ctx.setLineDash([7, 4]); ctx.stroke();
        ctx.setLineDash([]);
      }

      // 标签：名称 + 角度 + 位置
      var c = W2S(G.centroid(pl.points));
      ctx.fillStyle = bad ? '#991b1b' : color;
      ctx.font = (selected ? 'bold ' : '') + '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(piece.name, c.x, c.y - 2);
      ctx.font = '10.5px sans-serif'; ctx.fillStyle = bad ? '#b91c1c' : '#475569';
      ctx.fillText(G.normalizeAngle(pl.angle) + '°  (' + r1(pl.x) + ', ' + r1(pl.y) + ')', c.x, c.y + 12);
      ctx.textAlign = 'left';
    });
  }

  // 用外扩描边近似安全间距圈（仅示意）
  function drawHalo(points, margin, color) {
    ctx.save();
    polyPath(points);
    ctx.strokeStyle = hexA(color, .55);
    ctx.lineWidth = margin * 2 * state.view.scale;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();
  }

  function drawDraft() {
    if (!state.draw) return;
    var pts = state.draw.points;
    // 已确认边
    if (pts.length >= 1) {
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 2; ctx.beginPath();
      pts.forEach(function (p, i) { var s = W2S(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
      ctx.stroke();
    }
    // 鼠标悬停的橡皮筋
    if (state.draw.hover && pts.length) {
      var a = W2S(pts[pts.length - 1]), b = W2S(state.draw.hover);
      ctx.strokeStyle = 'rgba(29,78,216,.55)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
    }
    pts.forEach(function (p, i) {
      var s = W2S(p);
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#16a34a' : '#1d4ed8'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }

  function drawConflicts() {
    if (!state.conflicts) return;
    state.conflicts.forEach(function (c) {
      if (c.points && c.points.length === 2) {
        var a = W2S(c.points[0]), b = W2S(c.points[1]);
        ctx.strokeStyle = 'rgba(220,38,38,.9)'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        [a, b].forEach(function (p) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#dc2626'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        });
        // 间距文字
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.fillStyle = '#b91c1c'; ctx.font = 'bold 11px sans-serif';
        ctx.fillText((c.gap != null ? c.gap + ' / 需 ' + c.required : '冲突'), mx + 6, my - 6);
      }
    });
  }

  /* ================= 命中测试 ================= */
  function placementAt(wp) {
    var list = state.doc.placements;
    // 从后往前（上面的先选中）
    for (var i = list.length - 1; i >= 0; i--) {
      if (G.pointInPoly(wp, list[i].points) <= 0) return list[i];
    }
    // 细片容差：距边 6px 内也算命中
    var tol = 6 / state.view.scale;
    for (var j = list.length - 1; j >= 0; j--) {
      var edges = list[j].points;
      for (var k = 0; k < edges.length; k++) {
        if (G.pointSegmentDistance(wp, edges[k], edges[(k + 1) % edges.length]) <= tol) return list[j];
      }
    }
    return null;
  }

  /* ================= 鼠标交互 ================= */
  function mousePos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('mousedown', function (e) {
    if (state.locked) return;
    var sp = mousePos(e), wp = S2W(sp);

    if (state.draw) {
      if (e.button !== 0) return;
      // 双击闭合时浏览器会在同一坐标触发两次 mousedown，丢弃与末点重合的点
      var draftPts = state.draw.points;
      if (draftPts.length && G.dist(draftPts[draftPts.length - 1], wp) <= G.EPS) return;
      state.draw.points.push(wp);
      draw();
      return;
    }

    // 中键或空格 -> 平移
    if (e.button === 1 || state.spaceDown || e.button === 2) {
      e.preventDefault();
      state.panning = { x: sp.x, y: sp.y, ox: state.view.ox, oy: state.view.oy };
      return;
    }
    if (state.mode !== 'layout' || e.button !== 0) return;

    var hit = placementAt(wp);
    state.selectedId = hit ? hit.id : null;
    if (hit) {
      state.dragging = {
        id: hit.id,
        start: wp,
        origX: hit.x, origY: hit.y,
        moved: false
      };
      canvas.style.cursor = 'grabbing';
    }
    renderSidebar();
    draw();
  });

  canvas.addEventListener('mousemove', function (e) {
    var sp = mousePos(e), wp = S2W(sp);

    if (state.panning) {
      state.view.ox = state.panning.ox + (sp.x - state.panning.x);
      state.view.oy = state.panning.oy + (sp.y - state.panning.y);
      draw();
      return;
    }
    if (state.draw) { state.draw.hover = wp; draw(); return; }

    if (state.dragging) {
      var hit = placementById(state.dragging.id);
      if (!hit) return;
      var dx = wp.x - state.dragging.start.x, dy = wp.y - state.dragging.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.05) state.dragging.moved = true;
      movePlacement(hit, state.dragging.origX + dx, state.dragging.origY + dy);
      state.dirty = true; renderChrome();
      renderSidebar();
      draw();
      return;
    }

    if (state.mode === 'layout' && !state.locked) {
      var h = placementAt(wp);
      state.hoverId = h ? h.id : null;
      canvas.style.cursor = h ? 'grab' : 'default';
      draw();
    }
  });

  window.addEventListener('mouseup', function () {
    if (state.dragging) { state.dragging = null; canvas.style.cursor = 'default'; }
    state.panning = null;
  });

  canvas.addEventListener('dblclick', function () {
    if (state.draw) finishDraft(true);
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var sp = mousePos(e);
    var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(sp, factor);
  }, { passive: false });

  function zoomAt(sp, factor) {
    var before = S2W(sp);
    var ns = Math.min(40, Math.max(0.2, state.view.scale * factor));
    factor = ns / state.view.scale;
    state.view.scale = ns;
    state.view.ox = sp.x - before.x * ns;
    state.view.oy = sp.y - (state.doc.fabric.height - before.y) * ns;
    $('zoomLabel').textContent = Math.round(ns / 4 * 100) + '%';
    draw();
  }

  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { state.spaceDown = true; canvas.style.cursor = 'grab'; e.preventDefault(); }
    if (e.code === 'Enter' && state.draw) finishDraft(true);
    if (e.code === 'Escape') {
      if (state.draw) cancelDraft();
      else { state.selectedId = null; renderSidebar(); draw(); }
    }
    if (state.locked || !state.selectedId) return;
    if (e.key === 'r' || e.key === 'R') rotateSelected(1);
    if (e.key === 'q' || e.key === 'Q') rotateSelected(-1);
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.mode === 'layout') deleteSelected();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { state.spaceDown = false; canvas.style.cursor = 'default'; }
  });

  /* ================= 放置移动 / 旋转 ================= */
  function placementById(id) { return state.doc.placements.find(function (p) { return p.id === id; }); }
  function pieceById(id) { return state.doc.pieces.find(function (p) { return p.id === id; }); }

  function recomputePlacement(pl) {
    var piece = pieceById(pl.pieceId);
    pl.points = G.transformTemplate(piece.points, pl.angle, pl.x, pl.y);
  }
  function movePlacement(pl, x, y) {
    pl.x = r2(x); pl.y = r2(y);
    recomputePlacement(pl);
  }

  // 旋转时尽量保持原几何中心不动（避免包围盒角点锚定造成画面跳变）
  function rotateKeepingCenter(pl, newAngle) {
    var before = G.centroid(G.transformTemplate(pieceById(pl.pieceId).points, pl.angle, pl.x, pl.y));
    pl.angle = newAngle;
    var tpl = pieceById(pl.pieceId).points;
    var bb = G.bbox(G.rotatePoints(tpl, newAngle));
    // 中心 = (x + bb.w/2, y + bb.h/2)（模板原点为包围盒左下）
    pl.x = r2(before.x - bb.w / 2);
    pl.y = r2(before.y - bb.h / 2);
    recomputePlacement(pl);
  }

  function rotateSelected(dir) {
    var pl = placementById(state.selectedId);
    if (!pl) return;
    var piece = pieceById(pl.pieceId);
    var cur = G.normalizeAngle(pl.angle);
    var sorted = piece.allowedAngles.map(G.normalizeAngle).sort(function (a, b) { return a - b; });
    var idx = sorted.reduce(function (best, a, i) {
      return Math.abs(a - cur) <= G.ANG_EPS + 1e-6 ? i : best;
    }, 0);
    var ni = (idx + (dir > 0 ? 1 : sorted.length - 1)) % sorted.length;
    rotateKeepingCenter(pl, sorted[ni]);
    markDirty(); renderSidebar(); draw();
  }

  function deleteSelected() {
    var id = state.selectedId;
    state.doc.placements = state.doc.placements.filter(function (p) { return p.id !== id; });
    state.selectedId = null;
    markDirty(); renderSidebar(); draw();
  }

  function addPlacement(pieceId) {
    var piece = pieceById(pieceId);
    var used = state.doc.placements.filter(function (p) { return p.pieceId === pieceId; }).length;
    if (used >= piece.qty) { flash('「' + piece.name + '」已排满 ' + piece.qty + ' 片'); return; }
    var ang = piece.allowedAngles.map(Number)[0];
    var f = state.doc.fabric;
    // 找一个不与现有片重叠的初始位置（简单扫描）
    var pos = findFreeSpot(piece, ang) || { x: Math.max(1, f.width / 2 - 10), y: Math.max(1, f.height / 2 - 10) };
    var pl = { id: uid('pl'), pieceId: pieceId, angle: G.normalizeAngle(ang), x: pos.x, y: pos.y, points: [] };
    recomputePlacement(pl);
    state.doc.placements.push(pl);
    state.selectedId = pl.id;
    state.mode = 'layout';
    switchMode('layout');
    markDirty();
  }

  function findFreeSpot(piece, ang) {
    var f = state.doc.fabric;
    var rotated = G.rotatePoints(piece.points, ang);
    var bb = G.bbox(rotated);
    for (var y = piece.margin; y + bb.h + piece.margin <= f.height + 0.01; y += 2) {
      for (var x = piece.margin; x + bb.w + piece.margin <= f.width + 0.01; x += 2) {
        var poly = G.transformTemplate(piece.points, ang, x, y);
        var clash = state.doc.placements.some(function (p) { return G.polygonsOverlap(poly, p.points); }) ||
          state.doc.defects.some(function (d) { return G.polygonsOverlap(poly, d.points); });
        if (!clash) return { x: r2(x), y: r2(y) };
      }
    }
    return null;
  }

  /* ================= 绘制缺陷/裁片草稿 ================= */
  function startDraft(kind) {
    if (state.locked) return;
    state.draw = { kind: kind, points: [], hover: null };
    $('drawBanner').classList.remove('hidden');
    $('drawBanner').textContent = kind === 'defect'
      ? '正在绘制缺陷多边形：单击添加顶点，双击/回车闭合，Esc 取消'
      : '正在绘制裁片轮廓：单击添加顶点，双击/回车闭合，Esc 取消';
    $('btnDrawDefect').classList.add('hidden');
    $('btnCancelDraw').classList.toggle('hidden', kind !== 'defect');
    $('btnDrawPiece').classList.add('hidden');
    $('btnCancelPieceDraw').classList.toggle('hidden', kind !== 'piece');
    $('btnAddPiece').classList.toggle('hidden', kind === 'piece');
    $('peDrawHint').classList.toggle('hidden', kind !== 'piece');
    draw();
  }
  function cancelDraft() {
    state.draw = null;
    $('drawBanner').classList.add('hidden');
    $('btnDrawDefect').classList.remove('hidden');
    $('btnCancelDraw').classList.add('hidden');
    $('btnDrawPiece').classList.remove('hidden');
    $('btnCancelPieceDraw').classList.add('hidden');
    $('btnAddPiece').classList.remove('hidden');
    $('peDrawHint').classList.add('hidden');
    draw();
  }
  function finishDraft(silent) {
    var draft = state.draw;
    if (!draft || draft.points.length < 3) { flash('至少需要 3 个顶点'); return; }
    var cleaned = G.cleanPolygon(draft.points);
    if (!cleaned.ok) { alert('多边形非法：' + cleaned.reason); return; }
    var si = G.selfIntersection(cleaned.points);
    if (si) { alert('自交多边形，禁止使用：' + si.reason); return; }
    var pts = cleaned.points;

    if (draft.kind === 'defect') {
      var name = prompt('缺陷名称（可留空，使用自动编号）', '缺陷 ' + (state.doc.defects.length + 1));
      if (name === null) { cancelDraft(); return; }
      state.doc.defects.push({
        id: uid('defect'), name: name || ('缺陷 ' + (state.doc.defects.length + 1)),
        points: pts
      });
    } else {
      var pname = $('peName').value.trim();
      if (!pname) { alert('请先填写裁片名称'); return; }
      var qty = parseInt($('peQty').value, 10);
      var margin = parseFloat($('peMargin').value);
      var angles = $('peAngles').value.split(/[,，\s]+/).map(function (s) { return parseFloat(s); }).filter(function (v) { return !isNaN(v); });
      if (!(qty > 0)) { alert('所需数量必须为正整数'); return; }
      if (!(margin >= 0)) { alert('安全间距必须为非负数'); return; }
      if (!angles.length || angles.some(function (a) { return !isFinite(a); })) { alert('允许角度非法，示例：0,90,180,270'); return; }
      var norm = G.normalizeToOrigin(pts);
      var id = uid('piece');
      state.doc.pieces.push({
        id: id, name: pname, qty: qty, margin: margin,
        allowedAngles: angles.map(G.normalizeAngle), points: norm
      });
      $('peName').value = '';
    }
    cancelDraft();
    markDirty();
    renderSidebar();
  }

  /* ================= 保存 / 锁定 ================= */
  function saveBoard() {
    if (state.locked) { alert('版图已锁定，禁止改动'); return; }
    // 先在本地做一次快速结构校验（服务端是唯一权威）
    var local = validateLocally();
    if (local.length) {
      state.conflicts = local;
      renderConflicts(); draw();
      alert('本地检查未通过，未提交服务器：\n\n' + local.map(function (c) { return '· ' + c.message; }).join('\n'));
      return;
    }
    $('saveState').textContent = '保存中…';
    api('PUT', '/api/board', { revision: state.revision, doc: state.doc }).then(function (r) {
      if (r.status === 200) {
        applyServerRow(r.d.row);
        state.revision = r.d.revision;
        state.locked = false;
        renderChrome();
        flash('✓ 已保存，新修订号 ' + r.d.revision);
      } else if (r.status === 422) {
        // 校验失败：服务器整稿未变；标出冲突对象与原因
        state.conflicts = r.d.conflicts;
        state.revision = state.revision; // 本地稿保留（可能未保存），服务器稿不变
        renderConflicts(); renderSidebar(); draw();
      } else if (r.status === 409) {
        if (confirm('保存被拒：您的修订号 ' + state.revision + ' 已过期，服务器已有新稿（修订号 ' +
          r.d.current.revision + '）。\n\n确定放弃本地未保存改动并载入新稿吗？\n（选“取消”可先自行备份本地稿）')) {
          applyServerRow(r.d.current);
          fitView();
        }
      } else if (r.status === 423) {
        alert('版图已锁定，禁止改动。'); loadBoard();
      } else {
        alert('保存失败：' + (r.d.message || r.status));
      }
    }).catch(function (err) { alert('网络错误：' + err.message); });
  }

  function lockBoard() {
    if (state.locked) return;
    // 若有未排数量，明确提示（仍允许锁定，清单会保留未排数）
    var pending = [];
    state.doc.pieces.forEach(function (p) {
      var used = state.doc.placements.filter(function (x) { return x.pieceId === p.id; }).length;
      if (used < p.qty) pending.push(p.name + ' 缺 ' + (p.qty - used) + ' 片');
      if (used > p.qty) pending.push(p.name + ' 超排 ' + (used - p.qty) + ' 片（将无法保存/锁定）');
    });
    var msg = '锁定后整幅版图将禁止任何改动，并据此输出正式裁切清单。确定锁定（修订号 ' + state.revision + '）？';
    if (pending.length) {
      if (!confirm('当前尚未排满：\n· ' + pending.join('\n· ') + '\n\n仍要锁定吗？（裁切清单会保留未排数量）')) return;
    } else if (!confirm(msg)) return;
    api('POST', '/api/board/lock', { revision: state.revision }).then(function (r) {
      if (r.status === 200) {
        applyServerRow(r.d.row); state.revision = r.d.revision; state.locked = true;
        renderChrome(); switchMode('cutlist');
        flash('🔒 版图已锁定');
      } else if (r.status === 409) {
        alert('修订号已过期，请刷新后再锁定。');
        if (confirm('是否立即载入服务器新稿？')) applyServerRow(r.d.current);
      } else if (r.status === 423) { loadBoard(); }
      else alert('锁定失败：' + (r.d.message || r.status));
    });
  }

  // 本地快速校验（服务端仍会全量复核）
  function validateLocally() {
    var errs = [], d = state.doc;
    if (!(d.fabric.width > 0 && d.fabric.height > 0)) errs.push({ code: 'BAD_FABRIC_SIZE', message: '布幅宽/高必须为正数' });
    d.defects.forEach(function (x) {
      var c = G.cleanPolygon(x.points);
      if (!c.ok) errs.push({ code: 'BAD_DEFECT_POLY', target: x.id, message: '缺陷「' + x.id + '」：' + c.reason });
      else if (G.selfIntersection(c.points)) errs.push({ code: 'SELF_INTERSECT', target: x.id, message: '缺陷「' + x.id + '」自交' });
    });
    d.pieces.forEach(function (p) {
      var c = G.cleanPolygon(p.points);
      if (!c.ok) errs.push({ code: 'BAD_PIECE_POLY', target: p.id, message: '裁片「' + p.name + '」：' + c.reason });
      else if (G.selfIntersection(c.points)) errs.push({ code: 'SELF_INTERSECT', target: p.id, message: '裁片「' + p.name + '」自交' });
      if (!(p.qty > 0 && p.qty === Math.floor(p.qty))) errs.push({ code: 'BAD_QTY', target: p.id, message: '裁片「' + p.name + '」数量非法' });
      if (!(p.margin >= 0)) errs.push({ code: 'BAD_MARGIN', target: p.id, message: '裁片「' + p.name + '」间距非法' });
      if (!p.allowedAngles.length || p.allowedAngles.some(function (a) { return !isFinite(a); }))
        errs.push({ code: 'BAD_ANGLES', target: p.id, message: '裁片「' + p.name + '」允许角度非法' });
    });
    return errs;
  }

  /* ================= 冲突面板 ================= */
  var CODE_CN = {
    BAD_DOC: '版图数据', BAD_FABRIC: '布幅', BAD_FABRIC_SIZE: '布幅尺寸', BAD_DEFECTS: '缺陷区',
    BAD_DEFECT_ID: '缺陷编号', BAD_DEFECT_POLY: '缺陷多边形', SELF_INTERSECT: '自交多边形',
    BAD_PIECES: '裁片库', BAD_PIECE_ID: '裁片编号', DUP_PIECE_ID: '编号重复',
    BAD_PIECE_POLY: '裁片多边形', BAD_QTY: '数量非法', BAD_MARGIN: '间距非法', BAD_ANGLES: '角度非法',
    BAD_PLACEMENTS: '放置列表', BAD_PLACEMENT: '放置项', BAD_PLACEMENT_ID: '放置编号',
    DUP_PLACEMENT_ID: '编号重复',
    UNKNOWN_PIECE: '未知裁片', BAD_PL_ANGLE: '角度非法', ANGLE_NOT_ALLOWED: '角度不允许',
    BAD_PL_POS: '位置非法', BAD_PL_POLY: '轮廓非法', FLIP_OR_MORPH: '翻面/变形',
    QTY_EXCEEDED: '数量超限', EDGE_TOO_CLOSE: '距布边过近', DEFECT_TOO_CLOSE: '距缺陷过近',
    PIECE_TOO_CLOSE: '片间过近', BAD_REVISION: '修订号'
  };
  function renderConflicts() {
    var cs = state.conflicts || [];
    var dock = $('conflictDock');
    if (!cs.length) { dock.classList.add('hidden'); return; }
    dock.classList.remove('hidden');
    $('conflictTitle').textContent = '⚠ 保存被拒绝：' + cs.length + ' 处冲突 —— 整张版图未改动';
    var ul = $('conflictList');
    ul.innerHTML = '';
    cs.forEach(function (c) {
      var li = document.createElement('li');
      var tag = document.createElement('span');
      tag.className = 'ccode'; tag.textContent = CODE_CN[c.code] || c.code;
      li.appendChild(tag);
      li.appendChild(document.createTextNode(c.message));
      li.onclick = function () { focusConflict(c); };
      ul.appendChild(li);
    });
  }
  function focusConflict(c) {
    var id = c.target || (c.targets && c.targets[0]);
    if (id) {
      state.selectedId = id;
      switchMode('layout');
      var pl = placementById(id);
      if (pl) {
        var ctr = W2S(G.centroid(pl.points));
        centerScreen(ctr);
      }
      renderSidebar(); draw();
    } else if (c.points) {
      centerScreen(W2S(c.points[0]));
    }
  }
  function centerScreen(sp) {
    state.view.ox = canvas.clientWidth / 2 - sp.x + state.view.ox;
    state.view.oy = canvas.clientHeight / 2 - sp.y + state.view.oy;
    draw();
  }

  /* ================= 侧栏渲染 ================= */
  function renderSidebar() {
    if (!state.doc) return;
    // 缺陷列表
    var dl = $('defectList'); dl.innerHTML = '';
    state.doc.defects.forEach(function (d) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="swatch" style="background:#c2703a"></span>' +
        '<span class="meta"><b></b><span></span></span>';
      li.querySelector('b').textContent = d.name || d.id;
      li.querySelector('span.meta span').textContent = d.points.length + ' 个顶点';
      var del = document.createElement('button');
      del.className = 'icon-btn del'; del.textContent = '删除';
      del.onclick = function () {
        if (state.locked) return;
        state.doc.defects = state.doc.defects.filter(function (x) { return x.id !== d.id; });
        markDirty(); renderSidebar(); draw();
      };
      li.appendChild(del);
      if (state.locked) del.disabled = true;
      dl.appendChild(li);
    });

    // 裁片款式库
    var pl = $('pieceList'); pl.innerHTML = '';
    state.doc.pieces.forEach(function (p) {
      var li = document.createElement('li');
      var used = state.doc.placements.filter(function (x) { return x.pieceId === p.id; }).length;
      li.innerHTML = '<span class="swatch"></span><span class="meta"><b></b><span></span></span>';
      li.querySelector('.swatch').style.background = pieceColor(p.id);
      li.querySelector('b').textContent = p.name;
      li.querySelector('.meta span').textContent =
        '需 ' + p.qty + ' · 间距 ' + p.margin + 'cm · 角度 {' + p.allowedAngles.join('/') + '} · ' + p.points.length + ' 顶点';
      var del = document.createElement('button');
      del.className = 'icon-btn del'; del.textContent = '删除';
      del.title = '删除款式（同时移除其已放置片）';
      del.onclick = function () {
        if (state.locked) return;
        if (!confirm('删除款式「' + p.name + '」及其全部放置片？')) return;
        state.doc.pieces = state.doc.pieces.filter(function (x) { return x.id !== p.id; });
        state.doc.placements = state.doc.placements.filter(function (x) { return x.pieceId !== p.id; });
        markDirty(); renderSidebar(); draw();
      };
      if (state.locked) del.disabled = true;
      li.appendChild(del);
      pl.appendChild(li);
    });

    // 排版面板：款式目录
    var cat = $('placeCatalog'); cat.innerHTML = '';
    state.doc.pieces.forEach(function (p) {
      var used = state.doc.placements.filter(function (x) { return x.pieceId === p.id; }).length;
      var box = document.createElement('div');
      box.className = 'catalog-item';
      var over = used > p.qty;
      box.innerHTML =
        '<div class="top"><span class="swatch" style="display:inline-block;width:12px;height:12px;border-radius:3px;background:' + pieceColor(p.id) + '"></span>' +
        '<span class="name"></span><button class="btn primary mini">＋ 放置</button></div>' +
        '<div class="sub"></div><div class="progressbar' + (over ? ' over' : '') + '"><i style="width:' + Math.min(100, used / p.qty * 100) + '%"></i></div>';
      box.querySelector('.name').textContent = p.name;
      box.querySelector('.sub').textContent =
        '已排 ' + used + ' / 需 ' + p.qty + ' · 未排 ' + Math.max(p.qty - used, 0) +
        ' · 间距 ' + p.margin + 'cm · {' + p.allowedAngles.join('/') + '}°';
      var btn = box.querySelector('button');
      if (state.locked || used >= p.qty) { btn.disabled = true; btn.textContent = used >= p.qty ? '已排满' : '锁定中'; }
      btn.onclick = function () { addPlacement(p.id); };
      cat.appendChild(box);
    });

    // 选中信息
    var sel = placementById(state.selectedId);
    if (!sel) {
      $('selectionInfo').className = 'selection-empty';
      $('selectionInfo').textContent = '未选中任何裁片';
      $('selectionCtl').classList.add('hidden');
    } else {
      var piece = pieceById(sel.pieceId);
      $('selectionInfo').className = '';
      $('selectionInfo').innerHTML = '<b>' + piece.name + '</b> <span style="color:#52606d">(' + sel.id + ')</span>';
      $('selectionCtl').classList.remove('hidden');
      $('selX').value = r2(sel.x); $('selY').value = r2(sel.y);
      var ac = $('selAngles'); ac.innerHTML = '';
      piece.allowedAngles.map(G.normalizeAngle).sort(function (a, b) { return a - b; }).forEach(function (a) {
        var b2 = document.createElement('button');
        b2.className = 'angle-chip' + (Math.abs(a - G.normalizeAngle(sel.angle)) <= G.ANG_EPS + 1e-6 ? ' active' : '');
        b2.textContent = a + '°';
        b2.onclick = function () { rotateKeepingCenter(sel, a); markDirty(); renderSidebar(); draw(); };
        ac.appendChild(b2);
      });
    }

    // 统计
    var totalReq = 0, totalPlaced = 0;
    var rows = state.doc.pieces.map(function (p) {
      var used = state.doc.placements.filter(function (x) { return x.pieceId === p.id; }).length;
      totalReq += p.qty; totalPlaced += used;
      var rem = p.qty - used;
      return '<div class="st-row"><span>' + esc(p.name) + '</span><span>' +
        used + ' / ' + p.qty + ' （<span class="' + (rem > 0 ? 'cl-rem' : 'cl-done') + '">未排 ' + Math.max(rem, 0) + (used > p.qty ? '，超限 ' + (used - p.qty) : '') + '</span>）</span></div>';
    }).join('');
    $('statsBox').innerHTML = rows +
      '<div class="st-row total"><span>合计</span><span>' + totalPlaced + ' / ' + totalReq + ' 片</span></div>';
  }

  /* ================= 裁切清单 ================= */
  function renderCutlist() {
    var box = $('cutlistBox');
    if (!state.locked) {
      box.innerHTML = '<p class="hint">尚未锁定。当前修订号 ' + state.revision + '，锁定后此处显示正式清单，并可下载 CSV。</p>';
      $('btnDownloadCsv').disabled = true;
      return;
    }
    api('GET', '/api/cutlist').then(function (r) {
      if (r.status !== 200) { box.textContent = r.d.message || '清单不可用'; return; }
      var list = r.d;
      var html = '<p class="hint">布幅 ' + list.fabric.width + ' × ' + list.fabric.height +
        ' cm · 修订号 ' + list.revision + ' · 锁定时间 ' + esc(list.lockedAt || '') + '</p>';
      list.groups.forEach(function (g) {
        html += '<div class="cl-group"><div class="h"><span>' + esc(g.name) + '</span>' +
          '<span>需 ' + g.required + ' · 已排 ' + g.placed + ' · <span class="' + (g.remaining ? 'cl-rem' : 'cl-done') + '">未排 ' + g.remaining + '</span></span></div>';
        if (g.items.length) {
          html += '<table><tr><th>编号</th><th>X(cm)</th><th>Y(cm)</th><th>角度</th></tr>';
          g.items.forEach(function (it) {
            html += '<tr><td>' + esc(it.placementId) + '</td><td>' + it.x + '</td><td>' + it.y + '<td>' + it.angle + '°</td></tr>';
          });
          html += '</table>';
        }
        html += '</div>';
      });
      box.innerHTML = html;
      $('btnDownloadCsv').disabled = false;
    });
  }

  /* ================= 模式切换 / 顶栏 ================= */
  function switchMode(mode) {
    state.mode = mode;
    ['Setup', 'Layout', 'Cutlist'].forEach(function (m) {
      $('tab' + m).classList.toggle('active', m.toLowerCase() === mode);
      $('panel' + m).classList.toggle('hidden', m.toLowerCase() !== mode);
    });
    if (state.draw) cancelDraft();
    if (mode === 'layout') renderSidebar();
    if (mode === 'cutlist') renderCutlist();
    draw();
  }

  function renderChrome() {
    $('revBadge').textContent = '修订号 ' + (state.revision == null ? '—' : state.revision) + (state.dirty ? '（有未保存改动）' : '');
    $('revBadge').classList.toggle('dirty', state.dirty);
    $('lockBadge').classList.toggle('hidden', !state.locked);
    $('lockedBanner').classList.toggle('hidden', !state.locked);
    if (state.locked) $('lockedRev').textContent = state.revision;
    $('btnSave').disabled = state.locked;
    $('btnLock').disabled = state.locked;
    $('saveState').textContent = state.dirty ? '● 未保存' : '已同步';
    $('zoomLabel').textContent = Math.round(state.view.scale / 4 * 100) + '%';
    // 设置模式下输入框只读
    var ro = state.locked;
    ['fabricW', 'fabricH', 'peName', 'peQty', 'peMargin', 'peAngles'].forEach(function (id) { $(id).disabled = ro; });
    $('btnDrawDefect').disabled = ro; $('btnDrawPiece').disabled = ro; $('btnAddPiece').disabled = ro;
  }

  function renderAll() {
    // 同步布幅输入
    $('fabricW').value = state.doc.fabric.width;
    $('fabricH').value = state.doc.fabric.height;
    renderChrome();
    renderSidebar();
    if (state.mode === 'cutlist') renderCutlist();
    draw();
  }

  /* ================= 工具 ================= */
  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  var flashTimer = null;
  function flash(msg) {
    $('saveState').textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { renderChrome(); }, 2500);
  }

  /* ================= 事件绑定 ================= */
  $('tabSetup').onclick = function () { switchMode('setup'); };
  $('tabLayout').onclick = function () { switchMode('layout'); };
  $('tabCutlist').onclick = function () { switchMode('cutlist'); };
  $('btnReload').onclick = function () {
    if (state.dirty && !confirm('放弃本地未保存改动并从服务器重新载入？')) return;
    loadBoard().then(fitView);
  };
  $('btnSave').onclick = saveBoard;
  $('btnLock').onclick = lockBoard;
  $('btnCloseConflicts').onclick = function () { $('conflictDock').classList.add('hidden'); };
  $('btnDrawDefect').onclick = function () { switchMode('setup'); startDraft('defect'); };
  $('btnCancelDraw').onclick = cancelDraft;
  $('btnDrawPiece').onclick = function () { startDraft('piece'); };
  $('btnCancelPieceDraw').onclick = cancelDraft;
  $('btnAddPiece').onclick = function () {
    // 通过表单直接添加矩形裁片（方便快速录入）；也可用“绘制”按钮画任意多边形
    var name = $('peName').value.trim();
    var qty = parseInt($('peQty').value, 10), margin = parseFloat($('peMargin').value);
    var angles = $('peAngles').value.split(/[,，\s]+/).filter(Boolean).map(Number);
    if (!name) return alert('请填写裁片名称');
    if (!(qty > 0)) return alert('数量必须为正整数');
    if (!(margin >= 0)) return alert('间距必须 ≥ 0');
    if (!angles.length || angles.some(isNaN)) return alert('角度非法');
    var w = parseFloat(prompt('矩形裁片宽度 (cm)', '20'));
    if (!(w > 0)) return;
    var h = parseFloat(prompt('矩形裁片高度 (cm)', '30'));
    if (!(h > 0)) return;
    state.doc.pieces.push({
      id: uid('piece'), name: name, qty: qty, margin: margin,
      allowedAngles: angles.map(G.normalizeAngle),
      points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
    });
    $('peName').value = '';
    markDirty(); renderSidebar();
  };

  $('fabricW').addEventListener('change', function () {
    var v = parseFloat(this.value);
    if (!(v > 0)) { alert('布幅宽必须为正数'); this.value = state.doc.fabric.width; return; }
    state.doc.fabric.width = v; markDirty(); draw();
  });
  $('fabricH').addEventListener('change', function () {
    var v = parseFloat(this.value);
    if (!(v > 0)) { alert('布幅高必须为正数'); this.value = state.doc.fabric.height; return; }
    state.doc.fabric.height = v; markDirty(); draw();
  });
  $('selX').addEventListener('change', function () {
    var sel = placementById(state.selectedId); if (!sel) return;
    var v = parseFloat(this.value); if (isNaN(v)) return;
    movePlacement(sel, v, sel.y); markDirty(); renderSidebar(); draw();
  });
  $('selY').addEventListener('change', function () {
    var sel = placementById(state.selectedId); if (!sel) return;
    var v = parseFloat(this.value); if (isNaN(v)) return;
    movePlacement(sel, sel.x, v); markDirty(); renderSidebar(); draw();
  });
  $('btnRotateCW').onclick = function () { rotateSelected(1); };
  $('btnRotateCCW').onclick = function () { rotateSelected(-1); };
  $('btnDelete').onclick = deleteSelected;
  $('zoomIn').onclick = function () { zoomAt({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, 1.2); };
  $('zoomOut').onclick = function () { zoomAt({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, 1 / 1.2); };
  $('zoomFit').onclick = fitView;
  $('zoomOne').onclick = function () {
    zoomAt({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, 4 / state.view.scale);
  };
  $('showMargin').onchange = function () { state.showMargin = this.checked; draw(); };
  $('btnDownloadCsv').onclick = function () {
    if (!state.locked) return;
    window.location.href = '/api/cutlist?format=csv';
  };

  /* ================= 启动 ================= */
  resizeCanvas();
  loadBoard().then(function () {
    fitView();
    renderSidebar();
    renderChrome();
  }).catch(function (err) {
    document.body.insertAdjacentHTML('beforeend',
      '<div style="position:fixed;inset:0;background:#fff;padding:40px;font-family:sans-serif">' +
      '<h2>无法连接版图服务</h2><p>' + esc(err.message) + '</p><p>请确认服务已启动（npm start）。</p></div>');
  });
})();

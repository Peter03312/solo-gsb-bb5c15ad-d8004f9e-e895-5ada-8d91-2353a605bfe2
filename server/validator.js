/*
 * validator.js —— 服务端保存/锁定时的全量版图校验
 *
 * 校验顺序：
 *   1) 结构与取值（尺寸为正、角度合法、间距非负、多边形顶点合法且不自交）—— 命中即拒绝
 *   2) 逐片几何（数量、角度白名单、防翻面、布边、缺陷、片间间距）—— 收集全部冲突
 * 任一不合格：返回 {ok:false, rejected:true, conflicts:[...]}，调用方保证数据库不写入。
 */
'use strict';
var Geom = require('../shared/geom.js');

var G = Geom;

function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0; }

function validateBoard(doc) {
  // ---------- 第一阶段：结构 ----------
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_DOC', message: '版图数据必须是 JSON 对象' }] };
  }
  var fabric = doc.fabric;
  if (!fabric || typeof fabric !== 'object') {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_FABRIC', message: '缺少布幅信息' }] };
  }
  if (!(G.num(fabric.width) && fabric.width > 0 && G.num(fabric.height) && fabric.height > 0)) {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_FABRIC_SIZE', message: '布幅宽/高必须为正数（cm），当前：width=' + fabric.width + '，height=' + fabric.height }] };
  }
  var W = fabric.width, H = fabric.height;

  var defects = Array.isArray(doc.defects) ? doc.defects : null;
  if (!defects) {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_DEFECTS', message: '缺陷区必须为数组（可为空）' }] };
  }
  for (var di = 0; di < defects.length; di++) {
    var d = defects[di];
    if (!d || typeof d.id !== 'string' || !d.id) {
      return { ok: false, rejected: true, conflicts: [{ code: 'BAD_DEFECT_ID', message: '第 ' + (di + 1) + ' 个缺陷缺少 id' }] };
    }
    var cd = G.cleanPolygon(d.points);
    if (!cd.ok) return { ok: false, rejected: true, conflicts: [{ code: 'BAD_DEFECT_POLY', target: d.id, message: '缺陷「' + d.id + '」多边形非法：' + cd.reason }] };
    var sd = G.selfIntersection(cd.points);
    if (sd) return { ok: false, rejected: true, conflicts: [{ code: 'SELF_INTERSECT', target: d.id, kind: 'defect', message: '缺陷「' + d.id + '」自交：' + sd.reason }] };
    d.points = cd.points;
  }

  var pieces = Array.isArray(doc.pieces) ? doc.pieces : null;
  if (!pieces) {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_PIECES', message: '裁片款式必须为数组（可为空）' }] };
  }
  var pieceMap = Object.create(null);
  for (var pi = 0; pi < pieces.length; pi++) {
    var p = pieces[pi];
    if (!p || typeof p.id !== 'string' || !p.id) {
      return { ok: false, rejected: true, conflicts: [{ code: 'BAD_PIECE_ID', message: `第 ${pi + 1} 个裁片缺少 id` }] };
    }
    if (pieceMap[p.id]) return { ok: false, rejected: true, conflicts: [{ code: 'DUP_PIECE_ID', target: p.id, message: '裁片 id 重复：' + p.id }] };
    if (typeof p.name !== 'string' || !p.name) p.name = p.id;

    var cp = G.cleanPolygon(p.points);
    if (!cp.ok) return { ok: false, rejected: true, conflicts: [{ code: 'BAD_PIECE_POLY', target: p.id, message: '裁片「' + p.name + '」多边形非法：' + cp.reason }] };
    var sp = G.selfIntersection(cp.points);
    if (sp) return { ok: false, rejected: true, conflicts: [{ code: 'SELF_INTERSECT', target: p.id, kind: 'piece', message: '裁片「' + p.name + '」自交：' + sp.reason }] };

    if (!isInt(p.qty) || p.qty <= 0) {
      return { ok: false, rejected: true, conflicts: [{ code: 'BAD_QTY', target: p.id, message: '裁片「' + p.name + '」所需数量必须为正整数，当前：' + p.qty }] };
    }
    if (!(G.num(p.margin) && p.margin >= 0)) {
      return { ok: false, rejected: true, conflicts: [{ code: 'BAD_MARGIN', target: p.id, message: '裁片「' + p.name + '」安全间距必须为非负数，当前：' + p.margin }] };
    }
    if (!Array.isArray(p.allowedAngles) || p.allowedAngles.length === 0) {
      return { ok: false, rejected: true, conflicts: [{ code: 'BAD_ANGLES', target: p.id, message: '裁片「' + p.name + '」必须给出至少一个允许旋转角度' }] };
    }
    for (var ai = 0; ai < p.allowedAngles.length; ai++) {
      if (!G.num(p.allowedAngles[ai])) {
        return { ok: false, rejected: true, conflicts: [{ code: 'BAD_ANGLES', target: p.id, message: '裁片「' + p.name + '」存在非法角度：' + p.allowedAngles[ai] }] };
      }
    }
    // 模板统一规整到原点，作为服务端重算基准
    p.points = G.normalizeToOrigin(cp.points);
    pieceMap[p.id] = p;
  }

  var placements = Array.isArray(doc.placements) ? doc.placements : null;
  if (!placements) {
    return { ok: false, rejected: true, conflicts: [{ code: 'BAD_PLACEMENTS', message: '裁片放置列表必须为数组（可为空）' }] };
  }

  // ---------- 第二阶段：逐片几何（收集全部冲突） ----------
  var conflicts = [];
  var placed = []; // {id, placementId, piece, angle, x, y, poly}

  var seenPlacement = Object.create(null);
  for (var li = 0; li < placements.length; li++) {
    var pl = placements[li];
    var errs = [];
    if (!pl || typeof pl !== 'object') { conflicts.push({ code: 'BAD_PLACEMENT', message: '第 ' + (li + 1) + ' 个放置项不是对象' }); continue; }
    if (typeof pl.id !== 'string' || !pl.id) errs.push({ code: 'BAD_PLACEMENT_ID', message: '第 ' + (li + 1) + ' 个放置项缺少 id' });
    else if (seenPlacement[pl.id]) errs.push({ code: 'DUP_PLACEMENT_ID', target: pl.id, message: '放置编号重复：' + pl.id });
    else seenPlacement[pl.id] = true;
    var piece = pieceMap[pl.pieceId];
    if (!piece) errs.push({ code: 'UNKNOWN_PIECE', target: pl.pieceId, message: '放置 ' + pl.id + ' 引用了不存在的裁片款式：' + pl.pieceId });
    if (!G.num(pl.angle)) errs.push({ code: 'BAD_PL_ANGLE', target: pl.id, message: '放置 ' + pl.id + ' 角度非法：' + pl.angle });
    else if (piece && !G.angleAllowed(pl.angle, piece.allowedAngles)) {
      errs.push({ code: 'ANGLE_NOT_ALLOWED', target: pl.id, pieceId: piece.id,
        message: '裁片「' + piece.name + '」角度 ' + G.normalizeAngle(pl.angle) + '° 不在允许值 {' + piece.allowedAngles.join(', ') + '} 中' });
    }
    if (!G.num(pl.x) || !G.num(pl.y)) errs.push({ code: 'BAD_PL_POS', target: pl.id, message: '放置 ' + pl.id + ' 位置坐标非法' });

    var actual = null;
    if (Array.isArray(pl.points)) {
      var cpl = G.cleanPolygon(pl.points);
      if (!cpl.ok) errs.push({ code: 'BAD_PL_POLY', target: pl.id, message: '放置 ' + pl.id + ' 轮廓非法：' + cpl.reason });
      else {
        var spl = G.selfIntersection(cpl.points);
        if (spl) errs.push({ code: 'SELF_INTERSECT', target: pl.id, kind: 'placement', message: '放置 ' + pl.id + ' 旋转平移后轮廓自交：' + spl.reason });
        actual = cpl.points;
      }
    } else {
      errs.push({ code: 'BAD_PL_POLY', target: pl.id, message: '放置 ' + pl.id + ' 缺少实际轮廓点' });
    }

    if (piece && actual && G.num(pl.angle) && G.num(pl.x) && G.num(pl.y)) {
      // 防翻面：屏幕坐标下旋转保持有向面积符号，镜像（翻面）必使符号反转。
      // 先按环绕方向否决，再按“允许角度旋转+平移”的模板逐点比对（允许起点循环位移）。
      var sTpl = signedArea(piece.points);
      var sAct = signedArea(actual);
      var flipped = (sTpl > 0 && sAct < 0) || (sTpl < 0 && sAct > 0);
      if (flipped || !G.matchesTemplate(actual, piece.points, pl.angle, pl.x, pl.y)) {
        errs.push({ code: 'FLIP_OR_MORPH', target: pl.id, pieceId: piece.id,
          message: '裁片「' + piece.name + '」(' + pl.id + ') 实际轮廓与“按允许角度旋转+平移”的模板不一致（疑似翻面或被拉扯变形），禁止' });
      }
    }
    if (errs.length) { conflicts.push.apply(conflicts, errs); continue; }

    pl.angle = G.normalizeAngle(pl.angle);
    placed.push({
      id: pl.id, pieceId: piece.id, name: piece.name, margin: piece.margin,
      angle: pl.angle, x: pl.x, y: pl.y, poly: actual
    });
  }

  // 数量
  var countById = Object.create(null);
  for (var ci = 0; ci < placed.length; ci++) countById[placed[ci].pieceId] = (countById[placed[ci].pieceId] || 0) + 1;
  for (var qm in pieceMap) {
    var pc = pieceMap[qm], got = countById[qm] || 0;
    if (got > pc.qty) {
      conflicts.push({ code: 'QTY_EXCEEDED', target: qm, required: pc.qty, actual: got,
        message: '裁片「' + pc.name + '」放置 ' + got + ' 片，超过所需数量 ' + pc.qty + ' 片' });
    }
  }

  // 布边与缺陷
  for (var k = 0; k < placed.length; k++) {
    var it = placed[k];

    // 布边：对轴对齐矩形，四方向 bbox 净距即真实最小净距（出界为负）
    var b = G.bbox(it.poly);
    var gaps = { left: b.minX, right: W - b.maxX, top: b.minY, bottom: H - b.maxY };
    var minSide = null, minGap = Infinity;
    Object.keys(gaps).forEach(function (side) {
      if (gaps[side] < minGap) { minGap = gaps[side]; minSide = side; }
    });
    if (minGap < it.margin - G.EPS) {
      conflicts.push({
        code: 'EDGE_TOO_CLOSE', target: it.id, pieceId: it.pieceId, side: minSide,
        gap: round(minGap), required: it.margin, points: edgeContactPoint(it.poly, minSide, W, H),
        message: '裁片「' + it.name + '」(' + it.id + ') 距布边[' + sideName(minSide) + '] 净距 ' + fmtGap(minGap) +
          ' cm，小于自身安全间距 ' + it.margin + ' cm'
      });
    }

    // 缺陷
    for (var di2 = 0; di2 < defects.length; di2++) {
      var def = defects[di2];
      var overlap = G.polygonsOverlap(it.poly, def.points);
      var gapD = overlap ? 0 : G.polygonDistance(it.poly, def.points);
      if (gapD < it.margin - G.EPS) {
        var pair = overlap ? null : G.closestPointsBetweenPolygons(it.poly, def.points);
        conflicts.push({
          code: 'DEFECT_TOO_CLOSE', target: it.id, defectId: def.id, pieceId: it.pieceId,
          gap: round(gapD), required: it.margin,
          points: pair ? [pair.a, pair.b] : [G.centroid(it.poly), G.centroid(def.points)],
          message: '裁片「' + it.name + '」(' + it.id + ') 距缺陷「' + def.id + '」净距 ' + fmtGap(gapD) +
            ' cm，小于自身安全间距 ' + it.margin + ' cm' + (gapD === 0 ? '（已侵入/接触缺陷区）' : '')
        });
      }
    }
  }

  // 片间：间距至少为两者安全间距的较大值；恰等允许
  for (var i2 = 0; i2 < placed.length; i2++) {
    for (var j2 = i2 + 1; j2 < placed.length; j2++) {
      var A = placed[i2], B = placed[j2];
      var overlap2 = G.polygonsOverlap(A.poly, B.poly);
      var gap2 = overlap2 ? 0 : G.polygonDistance(A.poly, B.poly);
      var req = Math.max(A.margin, B.margin);
      if (gap2 < req - G.EPS) {
        var pair2 = overlap2 ? null : G.closestPointsBetweenPolygons(A.poly, B.poly);
        conflicts.push({
          code: 'PIECE_TOO_CLOSE', targets: [A.id, B.id], pieceIds: [A.pieceId, B.pieceId],
          gap: round(gap2), required: req,
          points: pair2 ? [pair2.a, pair2.b] : [G.centroid(A.poly), G.centroid(B.poly)],
          message: '裁片「' + A.name + '」(' + A.id + ') 与「' + B.name + '」(' + B.id + ') 净距 ' + fmtGap(gap2) +
            ' cm，小于两者安全间距较大值 max(' + A.margin + ', ' + B.margin + ') = ' + req + ' cm'
        });
      }
    }
  }

  if (conflicts.length) return { ok: false, rejected: true, conflicts: conflicts };

  // 未排数量统计（供调用方展示）
  var remaining = {};
  for (var rid in pieceMap) remaining[rid] = pieceMap[rid].qty - (countById[rid] || 0);
  return { ok: true, doc: doc, placedCount: placed.length, remaining: remaining };
}

function sideName(s) { return { left: '左', right: '右', top: '上', bottom: '下' }[s]; }
function round(v) { return Math.round(v * 1000) / 1000; }
function fmtGap(v) { return v < -G.EPS ? ('越界 ' + round(-v)) : round(v); }
// 有向面积（屏幕坐标：顺时针为正）；旋转不改变符号，镜像改变符号
function signedArea(poly) {
  var s = 0;
  for (var i = 0; i < poly.length; i++) {
    var a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function edgeContactPoint(poly, side, W, H) {
  if (side === 'right') return [rightMost(poly), { x: W, y: rightMost(poly).y }];
  if (side === 'top') return [topMost(poly), { x: topMost(poly).x, y: 0 }];
  if (side === 'bottom') { var p2 = bottomMost(poly); return [p2, { x: p2.x, y: H }]; }
  var p0 = leftMost(poly);
  return [p0, { x: 0, y: p0.y }];
}
function leftMost(poly) { var p = poly[0]; poly.forEach(function (q) { if (q.x < p.x) p = q; }); return p; }
function rightMost(poly) { var p = poly[0]; poly.forEach(function (q) { if (q.x > p.x) p = q; }); return p; }
function topMost(poly) { var p = poly[0]; poly.forEach(function (q) { if (q.y < p.y) p = q; }); return p; }
function bottomMost(poly) { var p = poly[0]; poly.forEach(function (q) { if (q.y > p.y) p = q; }); return p; }

module.exports = { validateBoard: validateBoard };

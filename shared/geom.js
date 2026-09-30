/*
 * geom.js —— 前后端共用的平面几何引擎
 * 坐标系：画布/布面坐标，x 向右、y 向下（屏幕坐标），角度正数表示“屏幕顺时针”。
 * 单位：厘米（cm）。
 * 同时以 CommonJS（Node 服务端）与浏览器全局 Geom（<script> 引入）方式导出。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Geom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;          // 几何重合容差（cm）
  var ANG_EPS = 1e-6;      // 角度容差（度）
  var MATCH_EPS = 1e-5;    // 提交轮廓与“模板旋转平移”轮廓的吻合容差（cm）

  function num(v) { return typeof v === 'number' && isFinite(v); }
  function pt(p) { return p && num(p.x) && num(p.y); }

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function bbox(poly) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
  }

  function centroid(poly) {
    var x = 0, y = 0;
    for (var i = 0; i < poly.length; i++) { x += poly[i].x; y += poly[i].y; }
    return { x: x / poly.length, y: y / poly.length };
  }

  /* ---------- 多边形规整 ----------
   * 接受 [{x,y}, ...]；去掉重复闭合点；拒绝非数、点数不足 3、零长边。
   * 返回 {ok:true, points} 或 {ok:false, reason}
   */
  function cleanPolygon(raw) {
    if (!Array.isArray(raw)) return { ok: false, reason: '多边形必须是顶点数组' };
    var pts = [];
    for (var i = 0; i < raw.length; i++) {
      var q = raw[i];
      if (q == null || !num(q.x) || !num(q.y)) return { ok: false, reason: '存在非数值或非法顶点（第 ' + (i + 1) + ' 个点）' };
      pts.push({ x: q.x, y: q.y });
    }
    if (pts.length < 3) return { ok: false, reason: '至少需要 3 个顶点' };
    // 去掉与首点重合的重复闭合点
    while (pts.length > 3 && dist(pts[0], pts[pts.length - 1]) <= EPS) pts.pop();
    if (pts.length < 3) return { ok: false, reason: '去重后有效顶点不足 3 个' };
    var n = pts.length;
    for (var j = 0; j < n; j++) {
      if (dist(pts[j], pts[(j + 1) % n]) <= EPS) return { ok: false, reason: '存在重合顶点或零长度边（顶点 ' + (j + 1) + ' 与 ' + ((j + 1) % n + 1) + '）' };
    }
    return { ok: true, points: pts };
  }

  // 平移到原点：使包围盒 minX=minY=0（模板统一以包围盒左下角为原点）
  function normalizeToOrigin(poly) {
    var b = bbox(poly);
    return poly.map(function (p) { return { x: p.x - b.minX, y: p.y - b.minY }; });
  }

  /* ---------- 线段相交 ---------- */
  function orient(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  function onSegment(p, a, b) {
    return Math.abs(orient(a, b, p)) <= EPS &&
      p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS &&
      p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
  }
  // 线段是否相交（含端点接触与共线重叠）
  function segTouch(a, b, c, d) {
    var o1 = orient(a, b, c), o2 = orient(a, b, d);
    var o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (Math.abs(o1) <= EPS && onSegment(c, a, b)) return true;
    if (Math.abs(o2) <= EPS && onSegment(d, a, b)) return true;
    if (Math.abs(o3) <= EPS && onSegment(a, c, d)) return true;
    if (Math.abs(o4) <= EPS && onSegment(b, c, d)) return true;
    return (o1 > EPS && o2 < -EPS || o1 < -EPS && o2 > EPS) &&
           (o3 > EPS && o4 < -EPS || o3 < -EPS && o4 > EPS);
  }

  // 最近点：点 -> 线段
  function closestPointOnSegment(p, a, b) {
    var ab = sub(b, a);
    var len2 = dot(ab, ab);
    var t = dot(sub(p, a), ab) / len2;
    t = Math.max(0, Math.min(1, t));
    return { point: { x: a.x + ab.x * t, y: a.y + ab.y * t }, t: t };
  }
  function pointSegmentDistance(p, a, b) {
    return dist(p, closestPointOnSegment(p, a, b).point);
  }

  // 最近点：线段 -> 线段（标准 clamped 最近点算法），返回两点与距离
  function closestPointsSegmentSegment(p1, q1, p2, q2) {
    var d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
    var a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    var s, t;
    if (a <= EPS && e <= EPS) { s = 0; t = 0; }
    else if (a <= EPS) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      var c = dot(d1, r);
      if (e <= EPS) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        var b = dot(d1, d2), denom = a * e - b * b;
        if (denom !== 0) s = Math.max(0, Math.min(1, (b * f - c * e) / denom));
        else s = 0;
        t = (b * s + f) / e;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        s = Math.max(0, Math.min(1, (t * b - c) / a));
      }
    }
    var c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
    var c2 = { x: p2.x + d2.x * t, y: p2.y + d2.y * t };
    return { a: c1, b: c2, distance: dist(c1, c2) };
  }
  function segSegDistance(a, b, c, d) {
    if (segTouch(a, b, c, d)) return 0;
    return closestPointsSegmentSegment(a, b, c, d).distance;
  }

  // 点在多边形内：-1 内部，0 边界，1 外部（射线法）
  function pointInPoly(p, poly) {
    var n = poly.length, inside = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var a = poly[j], b = poly[i];
      if (pointSegmentDistance(p, a, b) <= EPS) return 0;
      if ((a.y > p.y) !== (b.y > p.y) &&
          p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? -1 : 1;
  }

  function edgesOf(poly) {
    var n = poly.length, edges = [];
    for (var i = 0; i < n; i++) edges.push([poly[i], poly[(i + 1) % n]]);
    return edges;
  }

  /* ---------- 自交检测 ----------
   * 返回 null 表示合法；否则返回 {reason, edgeA, edgeB}
   * 规则：非相邻边不得相交（端点接触也算）；相邻边若共线折返重叠也算自交。
   */
  function selfIntersection(poly) {
    var n = poly.length;
    for (var i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      for (var k = i + 1; k < n; k++) {
        var c = poly[k], d = poly[(k + 1) % n];
        var adjacent = (k === i + 1) || (i === 0 && k === n - 1);
        if (adjacent) {
          // 公共端点 = b 与 c（或 (i==0,k==n-1) 时公共端点为 a）
          var shared = (i === 0 && k === n - 1) ? a : b;
          var u1 = sub(a, shared), u2 = sub(b, shared), v1 = sub(c, shared), v2 = sub(d, shared);
          var other1 = (u1.x === 0 && u1.y === 0) ? u2 : u1;
          var other2 = (v1.x === 0 && v1.y === 0) ? v2 : v1;
          if (Math.abs(cross(other1, other2)) <= EPS && dot(other1, other2) > 0) {
            return { reason: '相邻边共线折返重叠（顶点 ' + (k + 1) + ' 处）', edgeA: i + 1, edgeB: k + 1 };
          }
        } else if (segTouch(a, b, c, d)) {
          return { reason: '非相邻边相交（边 ' + (i + 1) + ' 与边 ' + (k + 1) + '）', edgeA: i + 1, edgeB: k + 1 };
        }
      }
    }
    return null;
  }

  /* ---------- 多边形关系 ---------- */
  // 是否有面积重叠/接触（相交、端点接触、一者包含另一者均算）
  function polygonsOverlap(A, B) {
    var ea = edgesOf(A), eb = edgesOf(B);
    for (var i = 0; i < ea.length; i++)
      for (var j = 0; j < eb.length; j++)
        if (segTouch(ea[i][0], ea[i][1], eb[j][0], eb[j][1])) return true;
    if (pointInPoly(A[0], B) <= 0 || pointInPoly(B[0], A) <= 0) return true;
    return false;
  }

  // 两个多边形边界的最小距离（0 = 接触或重叠/包含）
  function polygonDistance(A, B) {
    if (polygonsOverlap(A, B)) return 0;
    var ea = edgesOf(A), eb = edgesOf(B), best = Infinity;
    for (var i = 0; i < ea.length; i++)
      for (var j = 0; j < eb.length; j++) {
        var dd = segSegDistance(ea[i][0], ea[i][1], eb[j][0], eb[j][1]);
        if (dd < best) best = dd;
      }
    return best;
  }

  // 取两个多边形之间最近点对（用于画布上画出冲突连线）
  function closestPointsBetweenPolygons(A, B) {
    var ea = edgesOf(A), eb = edgesOf(B), best = null;
    for (var i = 0; i < ea.length; i++)
      for (var j = 0; j < eb.length; j++) {
        var r = closestPointsSegmentSegment(ea[i][0], ea[i][1], eb[j][0], eb[j][1]);
        if (!best || r.distance < best.distance) best = r;
      }
    return best;
  }

  // 多边形到矩形布边 [0,W]×[0,H] 的最近点对与四个方向净距
  function distanceToRect(poly, W, H) {
    var b = bbox(poly);
    var sides = {
      left: b.minX, right: W - b.maxX, top: b.minY, bottom: H - b.maxY
    };
    var rectCorners = [
      [{ x: 0, y: 0 }, { x: 0, y: H }],
      [{ x: W, y: 0 }, { x: W, y: H }],
      [{ x: 0, y: 0 }, { x: W, y: 0 }],
      [{ x: 0, y: H }, { x: W, y: H }]
    ];
    var best = null;
    var edges = edgesOf(poly);
    for (var i = 0; i < edges.length; i++)
      for (var k = 0; k < 4; k++) {
        var r = closestPointsSegmentSegment(edges[i][0], edges[i][1], rectCorners[k][0], rectCorners[k][1]);
        if (!best || r.distance < best.distance) best = r;
      }
    return { sides: sides, closest: best };
  }

  /* ---------- 旋转 / 模板变换 ----------
   * 屏幕坐标下正角度：x' = x cosθ + y sinθ；y' = -x sinθ + y cosθ
   */
  function rotatePoints(points, deg) {
    var t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    return points.map(function (p) {
      return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
    });
  }

  // 模板（原点为包围盒左下）+ 角度 + 位置(x,y) => 布面实际轮廓
  function transformTemplate(tpl, deg, x, y) {
    var rotated = rotatePoints(tpl, deg);
    var b = bbox(rotated);
    return rotated.map(function (p) {
      return { x: p.x - b.minX + x, y: p.y - b.minY + y };
    });
  }

  // 提交轮廓是否与模板经指定旋转平移后的轮廓一致（防止翻面/任意变形）
  function matchesTemplate(actual, tpl, deg, x, y) {
    var expected = transformTemplate(tpl, deg, x, y);
    if (actual.length !== expected.length) return false;
    // 顶点顺序可能从不同起点开始（但不会反向——反向即翻面），允许循环位移
    for (var shift = 0; shift < expected.length; shift++) {
      var ok = true;
      for (var i = 0; i < expected.length; i++) {
        var p = actual[(i + shift) % expected.length];
        var q = expected[i];
        if (Math.abs(p.x - q.x) > MATCH_EPS || Math.abs(p.y - q.y) > MATCH_EPS) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  /* ---------- 角度 ---------- */
  function normalizeAngle(deg) {
    var a = deg % 360;
    if (a < 0) a += 360;
    // 规范到 [0,360)
    if (a >= 360 - ANG_EPS) a = 0;
    return a;
  }
  function angleAllowed(deg, allowed) {
    var a = normalizeAngle(deg);
    for (var i = 0; i < allowed.length; i++) {
      var b = normalizeAngle(allowed[i]);
      var d = Math.abs(a - b);
      d = Math.min(d, 360 - d);
      if (d <= ANG_EPS) return true;
    }
    return false;
  }

  return {
    EPS: EPS, ANG_EPS: ANG_EPS, MATCH_EPS: MATCH_EPS,
    num: num, pt: pt, dist: dist, add: add, sub: sub,
    bbox: bbox, centroid: centroid,
    cleanPolygon: cleanPolygon, normalizeToOrigin: normalizeToOrigin,
    segTouch: segTouch, selfIntersection: selfIntersection,
    pointInPoly: pointInPoly, pointSegmentDistance: pointSegmentDistance,
    polygonsOverlap: polygonsOverlap, polygonDistance: polygonDistance,
    closestPointsBetweenPolygons: closestPointsBetweenPolygons,
    closestPointsSegmentSegment: closestPointsSegmentSegment,
    distanceToRect: distanceToRect,
    rotatePoints: rotatePoints, transformTemplate: transformTemplate,
    matchesTemplate: matchesTemplate,
    normalizeAngle: normalizeAngle, angleAllowed: angleAllowed
  };
});

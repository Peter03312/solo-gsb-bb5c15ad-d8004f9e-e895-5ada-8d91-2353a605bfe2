/*
 * server.js —— Express 服务：静态页面 + 版图 REST API
 *
 * 接口：
 *   GET  /api/board              读取当前版图（含 revision / locked）
 *   PUT  /api/board              提交整稿 {revision, doc}：先全量校验，通过后按修订号原子落库
 *   POST /api/board/lock         锁定版图 {revision}
 *   GET  /api/cutlist?format=csv 已锁定版图的裁切清单（CSV 下载）
 *
 * 试排方案接口：
 *   GET    /api/schemes                 方案列表（名称、来源修订号、自身修订号、各款未排数量）
 *   POST   /api/schemes                 从未锁定正式版图创建命名方案 {revision, name}
 *   GET    /api/schemes/:id             读取单个方案（含 doc 快照）
 *   PUT    /api/schemes/:id             保存方案 {revision, name?, doc}（沿用全量校验+乐观修订号）
 *   DELETE /api/schemes/:id             删除方案 {revision}
 *   POST   /api/schemes/:id/promote     方案切换为正式版图 {revision}（原子、无部分切换）
 */
'use strict';
var path = require('path');
var crypto = require('crypto');
var express = require('express');
var store = require('./db.js');
var validator = require('./validator.js');

var app = express();
app.use(express.json({ limit: '5mb' }));
// JSON 解析失败统一返回 JSON（而不是 Express 默认 HTML 错误页）
app.use(function (err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_JSON', message: '请求体不是合法 JSON：' + err.message });
  }
  if (err) return res.status(400).json({ error: 'BAD_REQUEST', message: err.message });
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

app.get('/api/board', function (req, res) {
  var row = store.get();
  if (!row) return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化，请先运行 npm run init-db' });
  res.json(row);
});

app.put('/api/board', function (req, res) {
  var body = req.body || {};
  var expected = body.revision;
  var doc = body.doc;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见版图修订号 revision（非负整数）' });
  }
  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({ error: 'BAD_DOC', message: '缺少版图数据 doc' });
  }

  // 1) 几何/业务全量校验（任何一项不合格：不触碰数据库，整稿不变）
  var result = validator.validateBoard(doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '校验未通过，整张版图保持原样（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  // 2) 乐观锁原子写入
  var saved = store.save(result.doc, expected);
  if (saved.status === 'locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '版图已锁定，禁止任何改动' });
  }
  if (saved.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '修订号 ' + expected + ' 已过期，服务器当前为 ' + saved.current.revision + '，请刷新获取新稿后再提交（不会覆盖他人修改）',
      current: saved.current
    });
  }
  res.json({ ok: true, revision: saved.revision, locked: false, row: saved.row });
});

app.post('/api/board/lock', function (req, res) {
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '锁定必须携带修订号' });
  }
  var r = store.lock(expected);
  if (r.status === 'already-locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '版图已处于锁定状态', revision: r.revision, row: r.row });
  }
  if (r.status === 'stale') {
    var cur = store.get();
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '修订号已过期，请刷新后再锁定',
      current: cur
    });
  }
  res.json({ ok: true, revision: r.revision, locked: true, row: r.row });
});

/* ---------- 试排方案 ---------- */

var MAX_SCHEME_NAME = 60;

function cleanName(raw, fallback) {
  var n = typeof raw === 'string' ? raw.trim() : '';
  if (!n) n = fallback || '';
  return n.slice(0, MAX_SCHEME_NAME);
}

// 方案列表摘要：名称、来源修订号、自身修订号、各款所需/已排/未排数量
function schemeSummary(s) {
  var counts = Object.create(null);
  s.doc.pieces.forEach(function (p) { counts[p.id] = 0; });
  s.doc.placements.forEach(function (pl) {
    if (Object.prototype.hasOwnProperty.call(counts, pl.pieceId)) counts[pl.pieceId]++;
  });
  var remaining = s.doc.pieces.map(function (p) {
    return { pieceId: p.id, name: p.name, required: p.qty, placed: counts[p.id], remaining: p.qty - counts[p.id] };
  });
  return {
    id: s.id, name: s.name,
    sourceRevision: s.sourceRevision, revision: s.revision,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    remaining: remaining
  };
}

app.get('/api/schemes', function (req, res) {
  var board = store.get();
  if (!board) return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化，请先运行 npm run init-db' });
  res.json({
    board: { revision: board.revision, locked: board.locked, updatedAt: board.updatedAt },
    schemes: store.listSchemes().map(schemeSummary)
  });
});

app.post('/api/schemes', function (req, res) {
  var body = req.body || {};
  var expected = body.revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见正式版图修订号 revision（非负整数）' });
  }
  var board = store.get();
  if (!board) return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化' });
  var name = cleanName(body.name, '试排方案 ' + new Date().toISOString().replace('T', ' ').slice(0, 16));

  // 方案快照来自服务器当前正式版图（创建时未锁定，几何必然已是上次保存时校验通过的）
  var r = store.createScheme('sch-' + crypto.randomBytes(9).toString('hex'), name, board.doc, expected);
  if (r.status === 'locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '正式版图已锁定，不能再从锁定版创建试排方案' });
  }
  if (r.status === 'stale-board') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '所见修订号 ' + expected + ' 已过期，正式版图当前为 ' + r.current.revision + '，请刷新后再创建方案',
      reason: 'board-moved', current: r.current
    });
  }
  res.status(201).json({ ok: true, scheme: schemeSummary(r.scheme) });
});

app.get('/api/schemes/:id', function (req, res) {
  var s = store.getScheme(req.params.id);
  if (!s) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + req.params.id });
  res.json(s);
});

app.put('/api/schemes/:id', function (req, res) {
  var body = req.body || {};
  var expected = body.revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见方案修订号 revision（非负整数）' });
  }
  if (!body.doc || typeof body.doc !== 'object') {
    return res.status(400).json({ error: 'BAD_DOC', message: '缺少方案数据 doc' });
  }
  var existing = store.getScheme(req.params.id);
  if (!existing) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + req.params.id });
  var name = cleanName(body.name, existing.name);

  // 1) 沿用正式版图同一套几何/数量/间距全量校验；失败：冲突返回，整份方案不变
  var result = validator.validateBoard(body.doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '校验未通过，整份方案保持原样（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  // 2) 方案自身乐观修订号，过期不得覆盖他人修改
  var saved = store.saveScheme(req.params.id, name, result.doc, expected);
  if (saved.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在（可能已被删除）' });
  }
  if (saved.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，服务器当前为 ' + saved.current.revision + '，请刷新方案后再提交',
      reason: 'stale-scheme', current: saved.current
    });
  }
  res.json({ ok: true, revision: saved.revision, scheme: saved.scheme });
});

app.delete('/api/schemes/:id', function (req, res) {
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '删除必须携带所见方案修订号 revision' });
  }
  var r = store.deleteScheme(req.params.id, expected);
  if (r.status === 'not-found') return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + req.params.id });
  if (r.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，当前为 ' + r.current.revision + '，请刷新后再删除',
      reason: 'stale-scheme', current: r.current
    });
  }
  res.json({ ok: true });
});

app.post('/api/schemes/:id/promote', function (req, res) {
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见方案修订号 revision（非负整数）' });
  }
  var s = store.getScheme(req.params.id);
  if (!s) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + req.params.id });

  // 晋升前先做全量几何/数量/间距校验，失败整份方案不变、正式版图不变
  var result = validator.validateBoard(s.doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '方案校验未通过，不能切换为正式版图（共 ' + result.conflicts.length + ' 处冲突）；正式版图保持原样',
      conflicts: result.conflicts
    });
  }

  // 原子晋升：方案修订号未过期 + 正式版图仍处来源修订号 + 未锁定；不产生部分切换
  var r = store.promoteScheme(req.params.id, expected);
  if (r.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在（可能已被删除）' });
  }
  if (r.status === 'board-locked') {
    var cur0 = store.get();
    return res.status(423).json({
      error: 'BOARD_LOCKED',
      message: '正式版图已锁定（修订号 ' + r.boardRevision + '），禁止切换；未产生任何改动',
      reason: 'board-locked',
      board: { revision: cur0.revision, locked: true, doc: cur0.doc },
      schemeRevision: r.schemeRevision
    });
  }
  if (r.status === 'stale-scheme') {
    var curS = store.getScheme(req.params.id);
    var curB1 = store.get();
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，当前为 ' + r.schemeRevision + '；正式版图保持原样',
      reason: 'stale-scheme',
      board: { revision: curB1.revision, locked: curB1.locked, doc: curB1.doc },
      current: curS
    });
  }
  if (r.status === 'board-moved') {
    var curB2 = store.get();
    return res.status(409).json({
      error: 'SOURCE_REVISION_MISMATCH',
      message: '正式版图已从来源修订号 ' + r.sourceRevision + ' 推进到 ' + r.boardRevision +
        '（他人已保存/锁定），不能用该方案覆盖；未产生任何改动',
      reason: 'board-moved',
      board: { revision: curB2.revision, locked: curB2.locked, doc: curB2.doc },
      sourceRevision: r.sourceRevision,
      schemeRevision: r.schemeRevision
    });
  }
  res.json({ ok: true, revision: r.revision, locked: false, row: r.row });
});

/* ---------- 裁切清单 ---------- */
function buildCutList(row) {
  var doc = row.doc;
  var map = {};
  doc.pieces.forEach(function (p) {
    map[p.id] = { pieceId: p.id, name: p.name, required: p.qty, placed: 0, margin: p.margin, items: [] };
  });
  doc.placements.forEach(function (pl) {
    if (!map[pl.pieceId]) return;
    map[pl.pieceId].placed++;
    var xs = pl.points.map(function (p) { return p.x; });
    var ys = pl.points.map(function (p) { return p.y; });
    map[pl.pieceId].items.push({
      placementId: pl.id,
      x: Math.round(Math.min.apply(null, xs) * 1000) / 1000,
      y: Math.round(Math.min.apply(null, ys) * 1000) / 1000,
      angle: Math.round(pl.angle * 1000) / 1000
    });
  });
  var groups = Object.keys(map).map(function (id) {
    var g = map[id];
    g.remaining = g.required - g.placed;
    return g;
  });
  return {
    fabric: doc.fabric,
    revision: row.revision,
    lockedAt: row.updatedAt,
    groups: groups,
    placements: doc.placements
  };
}

function csvCell(v) {
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(list) {
  var lines = [];
  lines.push(['# 服装裁片裁切清单']);
  lines.push(['# 布幅(cm)', list.fabric.width + ' x ' + list.fabric.height]);
  lines.push(['# 修订号', list.revision, '锁定时间', list.lockedAt]);
  lines.push([]);
  lines.push(['裁片', '放置编号', '位置X(cm)', '位置Y(cm)', '角度(°)', '自身间距(cm)']);
  list.groups.forEach(function (g) {
    g.items.forEach(function (it) {
      lines.push([g.name, it.placementId, it.x, it.y, it.angle, g.margin]);
    });
  });
  lines.push([]);
  lines.push(['裁片', '所需数量', '已排数量', '未排数量']);
  list.groups.forEach(function (g) {
    lines.push([g.name, g.required, g.placed, g.remaining]);
  });
  return '﻿' + lines.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
}

app.get('/api/cutlist', function (req, res) {
  var row = store.get();
  if (!row) return res.status(404).json({ error: 'NOT_INITIALIZED' });
  if (!row.locked) return res.status(409).json({ error: 'NOT_LOCKED', message: '版图尚未锁定，锁定后才能输出正式裁切清单' });
  var list = buildCutList(row);
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cutlist-rev' + row.revision + '.csv"');
    return res.send(toCsv(list));
  }
  res.json(list);
});

var PORT = parseInt(process.env.PORT || '3000', 10);
store.init();
app.listen(PORT, function () {
  console.log('[marker] 服装裁片排版服务已启动: http://localhost:' + PORT);
  console.log('[marker] 数据库: ' + store.DB_PATH);
});

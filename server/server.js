/*
 * server.js —— Express 服务：静态页面 + 版图 REST API
 *
 * 正式版图接口（保持向后兼容）：
 *   GET  /api/board              读取当前版图（含 revision / locked）
 *   PUT  /api/board              提交整稿 {revision, doc}：先全量校验，通过后按修订号原子落库
 *   POST /api/board/lock         锁定版图 {revision}
 *   GET  /api/cutlist?format=csv 已锁定版图的裁切清单（CSV 下载）
 *
 * 命名试排方案接口（本轮新增）：
 *   GET    /api/schemes            方案列表（名称 / 来源修订号 / 方案修订号 / 各款未排数量）
 *   POST   /api/schemes            从当前【未锁定】正式版图创建命名方案（服务端快照 doc）
 *   GET    /api/schemes/:id        读取单个方案（含完整 doc）
 *   PUT    /api/schemes/:id        保存方案 {revision, doc}：沿用同一套几何/数量/间距校验
 *   PATCH  /api/schemes/:id        改名 {revision, name}
 *   DELETE /api/schemes/:id        删除方案
 *   POST   /api/schemes/:id/promote 方案切为正式版图 {revision}：三条件单事务原子校验
 */
'use strict';
var path = require('path');
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

/* ======================================================================
 * 命名试排方案
 * ==================================================================== */

function parseId(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'BAD_SCHEME_ID', message: '方案 id 必须为正整数' });
    return null;
  }
  return id;
}

// GET /api/schemes —— 列表：名称、来源修订号、方案修订号、各款未排数量
app.get('/api/schemes', function (req, res) {
  res.json({ schemes: store.listSchemes() });
});

// POST /api/schemes —— 从当前【未锁定】正式版图创建方案；服务端快照版图 doc
app.post('/api/schemes', function (req, res) {
  var body = req.body || {};
  var board = store.get();
  if (!board) return res.status(404).json({ error: 'NOT_INITIALIZED', message: '版图尚未初始化，请先运行 npm run init-db' });
  if (board.locked) {
    return res.status(423).json({
      error: 'BOARD_LOCKED',
      message: '正式版图已锁定（修订号 ' + board.revision + '），不能从锁定版图创建新试排方案',
      current: { revision: board.revision, locked: true }
    });
  }
  var name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) name = '试排方案 ' + (store.listSchemes().length + 1);
  if (name.length > 80) return res.status(400).json({ error: 'BAD_NAME', message: '方案名称不能超过 80 个字符' });

  var r = store.createScheme(name, board.doc);
  if (r.status === 'locked') {
    return res.status(423).json({ error: 'BOARD_LOCKED', message: '正式版图已锁定，不能创建试排方案', current: r.current });
  }
  res.status(201).json({ ok: true, scheme: r.scheme });
});

// GET /api/schemes/:id —— 单个方案（含完整 doc）
app.get('/api/schemes/:id', function (req, res) {
  var id = parseId(req, res);
  if (id === null) return;
  var scheme = store.getScheme(id);
  if (!scheme) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  res.json(scheme);
});

// PUT /api/schemes/:id —— 保存方案：沿用正式版图同一套全量校验；
// 422=校验失败（含 conflicts[]，整份方案不变），409=方案修订号过期
app.put('/api/schemes/:id', function (req, res) {
  var id = parseId(req, res);
  if (id === null) return;
  var body = req.body || {};
  var expected = body.revision;
  var doc = body.doc;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '必须携带所见方案修订号 revision（非负整数）' });
  }
  if (!doc || typeof doc !== 'object') {
    return res.status(400).json({ error: 'BAD_DOC', message: '缺少方案数据 doc' });
  }

  // 1) 与正式版图完全相同的几何/数量/间距全量校验（任何一项不合格：不写库，整份方案不变）
  var result = validator.validateBoard(doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '校验未通过，整份方案保持原样（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  // 2) 方案自身乐观锁写入（与正式版图是否锁定无关）
  var saved = store.saveScheme(id, result.doc, expected);
  if (saved.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  }
  if (saved.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，服务器当前为 ' + saved.current.revision +
        '，请刷新方案后再提交（不会覆盖他人修改）',
      current: saved.current
    });
  }
  res.json({ ok: true, revision: saved.revision, scheme: saved.scheme });
});

// PATCH /api/schemes/:id —— 改名（同样乐观锁，revision +1）
app.patch('/api/schemes/:id', function (req, res) {
  var id = parseId(req, res);
  if (id === null) return;
  var body = req.body || {};
  var expected = body.revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '改名必须携带所见方案修订号 revision' });
  }
  var name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'BAD_NAME', message: '方案名称不能为空' });
  if (name.length > 80) return res.status(400).json({ error: 'BAD_NAME', message: '方案名称不能超过 80 个字符' });

  var r = store.renameScheme(id, name, expected);
  if (r.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  }
  if (r.status === 'stale') {
    return res.status(409).json({
      error: 'REVISION_STALE',
      message: '方案修订号 ' + expected + ' 已过期，当前为 ' + r.current.revision + '，请刷新后再改名',
      current: r.current
    });
  }
  res.json({ ok: true, revision: r.revision, scheme: r.scheme });
});

// DELETE /api/schemes/:id
app.delete('/api/schemes/:id', function (req, res) {
  var id = parseId(req, res);
  if (id === null) return;
  var r = store.deleteScheme(id);
  if (r.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  }
  res.json({ ok: true, id: id });
});

// POST /api/schemes/:id/promote —— 方案切为正式版图
// 三条件单事务：方案 revision 未过期 + 正式版图仍处于来源修订号 + 正式版图未锁定
// 条件不满足返回当前版本与原因，不产生部分切换
app.post('/api/schemes/:id/promote', function (req, res) {
  var id = parseId(req, res);
  if (id === null) return;
  var expected = (req.body || {}).revision;
  if (typeof expected !== 'number' || !Number.isInteger(expected)) {
    return res.status(400).json({ error: 'BAD_REVISION', message: '晋升必须携带所见方案修订号 revision' });
  }

  // 晋升前再复核一次几何/数量/间距：失败不产生任何变更，返回冲突
  var scheme = store.getScheme(id);
  if (!scheme) return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  var result = validator.validateBoard(scheme.doc);
  if (!result.ok) {
    return res.status(422).json({
      error: 'VALIDATION_FAILED',
      message: '方案校验未通过，不能切为正式版图（共 ' + result.conflicts.length + ' 处冲突）',
      conflicts: result.conflicts
    });
  }

  var r = store.promoteScheme(id, expected);
  if (r.status === 'not-found') {
    return res.status(404).json({ error: 'SCHEME_NOT_FOUND', message: '试排方案不存在：' + id });
  }
  if (r.status === 'scheme-stale') {
    return res.status(409).json({
      error: 'SCHEME_REVISION_STALE',
      reason: '方案修订号 ' + expected + ' 已过期，当前为 ' + r.schemeRevision,
      message: '方案修订号已过期，请刷新方案后重试（不会产生部分切换）',
      scheme: store.getScheme(id)
    });
  }
  if (r.status === 'board-locked') {
    return res.status(423).json({
      error: 'BOARD_LOCKED',
      reason: '正式版图已锁定（当前修订号 ' + r.board.revision + '），不能被方案替换',
      message: '正式版图已锁定，无法切换；正式版图与方案均保持原样',
      board: r.board, sourceRevision: r.sourceRevision
    });
  }
  if (r.status === 'board-moved') {
    return res.status(409).json({
      error: 'SOURCE_REVISION_MOVED',
      reason: '正式版图当前修订号 ' + r.board.revision + '，已不是方案来源修订号 ' + r.sourceRevision,
      message: '正式版图在方案创建后已被他人修改（来源修订号 ' + r.sourceRevision +
        ' → 当前 ' + r.board.revision + '），拒绝覆盖；正式版图与方案均保持原样',
      board: r.board, sourceRevision: r.sourceRevision
    });
  }
  // status === 'ok'：正式版图 revision +1，其他方案保持原样
  res.json({
    ok: true, revision: r.revision, locked: false, row: r.row,
    promotedFrom: { schemeId: id, schemeRevision: expected }
  });
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

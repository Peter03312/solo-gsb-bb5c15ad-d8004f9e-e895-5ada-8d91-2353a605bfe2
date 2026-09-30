/*
 * db.js —— SQLite 持久化（better-sqlite3，同步 API）
 * 正式版图表 board：id / revision（乐观修订号）/ locked / doc(JSON) / updated_at
 * 命名试排方案 schemes：id / name / source_revision（来源版图修订号）/
 *                       revision（方案自身修订号）/ doc(JSON) / 时间戳
 */
'use strict';
var path = require('path');
var fs = require('fs');
var Database = require('better-sqlite3');

var DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'marker.db');
var BOARD_ID = 1;

var db;
function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS board (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      revision   INTEGER NOT NULL DEFAULT 0,
      locked     INTEGER NOT NULL DEFAULT 0,
      doc        TEXT    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 试排方案：从某一版未锁定正式版图复制而来；source_revision 记录来源修订号，
  // revision 是方案自身修订号（每次保存/改名 +1），均用于乐观并发。
  db.exec(`
    CREATE TABLE IF NOT EXISTS schemes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT    NOT NULL,
      source_revision INTEGER NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1,
      doc             TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedDoc() {
  return {
    fabric: { width: 150, height: 100, unit: 'cm' },
    defects: [
      {
        id: 'defect-1',
        name: '破洞 A',
        points: [
          { x: 95, y: 20 }, { x: 112, y: 16 }, { x: 118, y: 30 },
          { x: 108, y: 42 }, { x: 94, y: 36 }
        ]
      }
    ],
    pieces: [
      {
        id: 'front', name: '前身片', qty: 2, margin: 1.5,
        allowedAngles: [0, 180],
        points: [
          { x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 40 },
          { x: 17, y: 40 }, { x: 16, y: 35 }, { x: 15, y: 40 }, { x: 0, y: 40 }
        ]
      },
      {
        id: 'back', name: '后身片', qty: 2, margin: 1.5,
        allowedAngles: [0, 90, 180, 270],
        points: [
          { x: 0, y: 0 }, { x: 32, y: 0 }, { x: 32, y: 42 }, { x: 0, y: 42 }
        ]
      },
      {
        id: 'sleeve', name: '袖子', qty: 4, margin: 1.0,
        allowedAngles: [0, 90, 180, 270],
        points: [
          { x: 0, y: 6 }, { x: 14, y: 0 }, { x: 18, y: 0 },
          { x: 32, y: 6 }, { x: 24, y: 22 }, { x: 8, y: 22 }
        ]
      }
    ],
    placements: []
  };
}

function init() {
  open();
  var row = db.prepare('SELECT COUNT(*) AS n FROM board WHERE id = ?').get(BOARD_ID);
  if (row.n === 0) {
    db.prepare('INSERT INTO board (id, revision, locked, doc) VALUES (?, 0, 0, ?)')
      .run(BOARD_ID, JSON.stringify(seedDoc(), null, 2));
    console.log('[db] 已初始化版图样例数据 ->', DB_PATH);
  }
  return get();
}

function get() {
  open();
  var row = db.prepare('SELECT revision, locked, doc, updated_at FROM board WHERE id = ?').get(BOARD_ID);
  if (!row) return null;
  return { revision: row.revision, locked: !!row.locked, updatedAt: row.updated_at, doc: JSON.parse(row.doc) };
}

/*
 * 原子保存：expectedRevision 必须等于当前 revision；锁定后拒绝写入。
 * 校验在调用方（事务外）完成，本函数仍包一层事务保证“失败整稿不变”。
 * 返回 {status:'ok', revision, row} | {status:'locked'} | {status:'stale', current}
 */
function save(doc, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (row.locked) return { status: 'locked' };
    if (row.revision !== expectedRevision) {
      return { status: 'stale', current: { revision: row.revision, locked: false, doc: JSON.parse(row.doc) } };
    }
    var next = row.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(doc), next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, row: get() };
  if (res.status === 'stale') {
    var c = get();
    return { status: 'stale', current: c };
  }
  return res;
}

/*
 * 锁定：同样携带修订号；锁定不改变几何数据，revision +1。
 * 已锁定返回 {status:'already-locked', revision}。
 */
function lock(expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision, locked FROM board WHERE id = ?').get(BOARD_ID);
    if (row.locked) return { status: 'already-locked', revision: row.revision };
    if (row.revision !== expectedRevision) return { status: 'stale' };
    var next = row.revision + 1;
    db.prepare("UPDATE board SET locked = 1, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  res.row = get();
  return res;
}

/* ========================================================================
 * 命名试排方案（schemes）
 *
 * 并发约定：
 *   - 方案保存/改名必须携带方案自身 revision（过期 -> stale，不覆盖他人修改）；
 *   - 方案创建时快照当时正式版图 doc，记录 source_revision（仅可从“未锁定”版图创建）；
 *   - 晋升（方案切为正式版图）在单个事务内同时检查：
 *       1) 方案 revision 未过期；
 *       2) 正式版图仍处于来源修订号 source_revision；
 *       3) 正式版图未锁定；
 *     任一不满足整事务回滚，不产生部分切换；
 *     成功后正式版图 revision += 1 并采用方案 doc，locked=0，其余方案保持原样。
 * ===================================================================== */

function rowToScheme(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    sourceRevision: row.source_revision,
    revision: row.revision,
    doc: JSON.parse(row.doc),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// 各款未排数量（列表展示用）：[{pieceId,name,required,placed,remaining}]
function summarizeDoc(doc) {
  var counts = Object.create(null);
  (doc.placements || []).forEach(function (pl) {
    counts[pl.pieceId] = (counts[pl.pieceId] || 0) + 1;
  });
  return (doc.pieces || []).map(function (p) {
    var placed = counts[p.id] || 0;
    return { pieceId: p.id, name: p.name, required: p.qty, placed: placed, remaining: p.qty - placed };
  });
}

function listSchemes() {
  open();
  var rows = db.prepare(
    'SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM schemes ORDER BY id'
  ).all();
  return rows.map(function (r) {
    return {
      id: r.id, name: r.name,
      sourceRevision: r.source_revision, revision: r.revision,
      createdAt: r.created_at, updatedAt: r.updated_at,
      groups: summarizeDoc(JSON.parse(r.doc))
    };
  });
}

function getScheme(id) {
  open();
  var row = db.prepare(
    'SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM schemes WHERE id = ?'
  ).get(id);
  return rowToScheme(row);
}

/*
 * 创建方案：快照当前正式版图（要求未锁定）。
 * 返回 {status:'ok', scheme} | {status:'locked', current} | {status:'board-missing'}
 */
function createScheme(name, doc) {
  open();
  var tx = db.transaction(function () {
    var board = db.prepare('SELECT revision, locked FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'board-missing' };
    if (board.locked) {
      return {
        status: 'locked',
        current: { revision: board.revision, locked: true }
      };
    }
    var info = db.prepare(
      "INSERT INTO schemes (name, source_revision, revision, doc) VALUES (?, ?, 1, ?)"
    ).run(name, board.revision, JSON.stringify(doc));
    return { status: 'ok', id: info.lastInsertRowid };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', scheme: getScheme(res.id) };
  if (res.status === 'locked') {
    var b = get();
    return { status: 'locked', current: { revision: b.revision, locked: true } };
  }
  return res;
}

/*
 * 保存方案：校验在调用方完成（同正式版图，复用 validator）。
 * 返回
 *   {status:'ok', revision, scheme}
 *   {status:'stale', current}            方案修订号过期
 *   {status:'not-found'}
 */
function saveScheme(id, doc, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision FROM schemes WHERE id = ?').get(id);
    if (!row) return { status: 'not-found' };
    if (row.revision !== expectedRevision) return { status: 'stale' };
    var next = row.revision + 1;
    db.prepare("UPDATE schemes SET doc = ?, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(doc), next, id);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, scheme: getScheme(id) };
  if (res.status === 'stale') return { status: 'stale', current: getScheme(id) };
  return res;
}

/*
 * 改名：同样携带方案修订号；改名也使方案 revision +1（避免覆盖并发改名）。
 * 返回 {status:'ok', revision, scheme} | {status:'stale', current} | {status:'not-found'}
 */
function renameScheme(id, name, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision FROM schemes WHERE id = ?').get(id);
    if (!row) return { status: 'not-found' };
    if (row.revision !== expectedRevision) return { status: 'stale' };
    var next = row.revision + 1;
    db.prepare("UPDATE schemes SET name = ?, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, next, id);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, scheme: getScheme(id) };
  if (res.status === 'stale') return { status: 'stale', current: getScheme(id) };
  return res;
}

/*
 * 删除方案：不影响正式版图与其他方案。返回 {status:'ok'} | {status:'not-found'}
 */
function deleteScheme(id) {
  open();
  var info = db.prepare('DELETE FROM schemes WHERE id = ?').run(id);
  return { status: info.changes > 0 ? 'ok' : 'not-found' };
}

/*
 * 晋升：方案切为正式版图（单事务，绝不部分切换）。
 * 前置：方案 revision === expectedRevision；
 *       board.revision === scheme.source_revision；
 *       board.locked === 0。
 * 成功：board.doc = scheme.doc，board.revision += 1（保持解锁）；
 *       方案表一行不改（其他方案自然保持原样）。
 * 返回：
 *   {status:'ok', revision, row}
 *   {status:'scheme-stale', schemeRevision}
 *   {status:'board-moved', board:{revision,locked}, sourceRevision}
 *   {status:'board-locked', board:{revision,locked}, sourceRevision}
 *   {status:'not-found'}
 */
function promoteScheme(id, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var scheme = db.prepare('SELECT source_revision, revision, doc FROM schemes WHERE id = ?').get(id);
    if (!scheme) return { status: 'not-found' };
    var board = db.prepare('SELECT revision, locked FROM board WHERE id = ?').get(BOARD_ID);
    if (!board) return { status: 'board-missing' };
    if (scheme.revision !== expectedRevision) {
      return { status: 'scheme-stale', schemeRevision: scheme.revision };
    }
    if (board.locked) {
      return {
        status: 'board-locked',
        board: { revision: board.revision, locked: true },
        sourceRevision: scheme.source_revision
      };
    }
    if (board.revision !== scheme.source_revision) {
      return {
        status: 'board-moved',
        board: { revision: board.revision, locked: false },
        sourceRevision: scheme.source_revision
      };
    }
    var next = board.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(scheme.doc, next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, row: get() };
  return res;
}

module.exports = {
  init: init, get: get, save: save, lock: lock,
  listSchemes: listSchemes, getScheme: getScheme,
  createScheme: createScheme, saveScheme: saveScheme,
  renameScheme: renameScheme, deleteScheme: deleteScheme,
  promoteScheme: promoteScheme,
  DB_PATH: DB_PATH
};

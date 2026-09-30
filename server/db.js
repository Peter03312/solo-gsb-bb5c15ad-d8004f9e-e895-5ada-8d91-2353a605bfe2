/*
 * db.js —— SQLite 持久化（better-sqlite3，同步 API）
 * 单版图表 board：id / revision（乐观修订号）/ locked / doc(JSON) / updated_at
 * 试排方案表 schemes：id / name / source_revision（来源正式版图修订号）/
 *                     revision（方案自身修订号）/ doc(JSON 快照)
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS schemes (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1,
      doc             TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

/* ================= 试排方案 ================= */

function schemeRow(r) {
  return {
    id: r.id,
    name: r.name,
    sourceRevision: r.source_revision,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doc: JSON.parse(r.doc)
  };
}

function listSchemes() {
  open();
  return db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM schemes ORDER BY created_at, rowid').all()
    .map(schemeRow);
}

function getScheme(id) {
  open();
  var r = db.prepare('SELECT id, name, source_revision, revision, doc, created_at, updated_at FROM schemes WHERE id = ?').get(id);
  return r ? schemeRow(r) : null;
}

/*
 * 从当前正式版图创建命名试排方案（快照）。
 * 仅允许在正式版图未锁定时创建；sourceRevision 必须等于当前 revision。
 * 返回 {status:'ok', scheme} | {status:'locked'} | {status:'stale-board', current}
 */
function createScheme(id, name, doc, expectedSourceRevision) {
  open();
  var tx = db.transaction(function () {
    var row = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (row.locked) return { status: 'locked' };
    if (row.revision !== expectedSourceRevision) {
      return { status: 'stale-board', current: { revision: row.revision, locked: false, doc: JSON.parse(row.doc) } };
    }
    db.prepare("INSERT INTO schemes (id, name, source_revision, revision, doc) VALUES (?, ?, ?, 1, ?)")
      .run(id, name, row.revision, JSON.stringify(doc));
    return { status: 'ok' };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', scheme: getScheme(id) };
  if (res.status === 'stale-board') return { status: 'stale-board', current: get() };
  return res;
}

/*
 * 保存方案：expectedRevision 必须等于方案自身当前 revision；整稿校验在调用方完成。
 * 方案与正式版图是否锁定无关——锁定的正式版图上仍可继续试排。
 * 返回 {status:'ok', revision, scheme} | {status:'not-found'} | {status:'stale', current}
 */
function saveScheme(id, name, doc, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var r = db.prepare('SELECT revision FROM schemes WHERE id = ?').get(id);
    if (!r) return { status: 'not-found' };
    if (r.revision !== expectedRevision) return { status: 'stale' };
    var next = r.revision + 1;
    db.prepare("UPDATE schemes SET name = ?, doc = ?, revision = ?, updated_at = datetime('now') WHERE id = ?")
      .run(name, JSON.stringify(doc), next, id);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') return { status: 'ok', revision: res.revision, scheme: getScheme(id) };
  if (res.status === 'stale') return { status: 'stale', current: getScheme(id) };
  return res;
}

/*
 * 删除方案：携带方案修订号，过期返回 stale（避免误删他人刚改过的方案）。
 * 返回 {status:'ok'} | {status:'not-found'} | {status:'stale', current}
 */
function deleteScheme(id, expectedRevision) {
  open();
  var tx = db.transaction(function () {
    var r = db.prepare('SELECT revision FROM schemes WHERE id = ?').get(id);
    if (!r) return { status: 'not-found' };
    if (r.revision !== expectedRevision) return { status: 'stale' };
    db.prepare('DELETE FROM schemes WHERE id = ?').run(id);
    return { status: 'ok' };
  });
  var res = tx();
  if (res.status === 'stale') return { status: 'stale', current: getScheme(id) };
  return res;
}

/*
 * 将试排方案切换为正式版图（晋升）。同一事务内依次确认：
 *   1) 方案存在；
 *   2) 正式版图未锁定；
 *   3) 方案修订号未过期（== schemeRevision）；
 *   4) 正式版图仍停留在方案来源修订号（revision == sourceRevision，未被他人推进）。
 * 全部满足：board.doc 覆盖为方案 doc、locked=0、board.revision +1；其他方案保持原样。
 * 任一不满足：不产生任何写入，返回当前版本与原因。
 * 几何/数量/间距全量校验在调用方（事务外）完成，失败返回 422 且不到达本函数。
 */
function promoteScheme(id, expectedSchemeRevision) {
  open();
  var tx = db.transaction(function () {
    var s = db.prepare('SELECT revision, source_revision, doc FROM schemes WHERE id = ?').get(id);
    if (!s) return { status: 'not-found' };
    var b = db.prepare('SELECT revision, locked, doc FROM board WHERE id = ?').get(BOARD_ID);
    if (b.locked) return { status: 'board-locked', boardRevision: b.revision, schemeRevision: s.revision };
    if (s.revision !== expectedSchemeRevision) {
      return { status: 'stale-scheme', boardRevision: b.revision, schemeRevision: s.revision };
    }
    if (b.revision !== s.source_revision) {
      return { status: 'board-moved', boardRevision: b.revision, sourceRevision: s.source_revision, schemeRevision: s.revision };
    }
    var next = b.revision + 1;
    db.prepare("UPDATE board SET doc = ?, revision = ?, locked = 0, updated_at = datetime('now') WHERE id = ?")
      .run(s.doc, next, BOARD_ID);
    return { status: 'ok', revision: next };
  });
  var res = tx();
  if (res.status === 'ok') res.row = get();
  return res;
}

module.exports = {
  init: init, get: get, save: save, lock: lock, DB_PATH: DB_PATH,
  listSchemes: listSchemes, getScheme: getScheme,
  createScheme: createScheme, saveScheme: saveScheme, deleteScheme: deleteScheme,
  promoteScheme: promoteScheme
};

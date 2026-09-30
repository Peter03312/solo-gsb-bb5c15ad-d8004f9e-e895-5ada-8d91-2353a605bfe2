/*
 * db.js —— SQLite 持久化（better-sqlite3，同步 API）
 * 单版图表 board：id / revision（乐观修订号）/ locked / doc(JSON) / updated_at
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

module.exports = { init: init, get: get, save: save, lock: lock, DB_PATH: DB_PATH };

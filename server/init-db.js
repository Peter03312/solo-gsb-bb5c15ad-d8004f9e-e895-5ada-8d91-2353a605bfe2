#!/usr/bin/env node
/* 初始化/重建 SQLite 数据库：npm run init-db */
'use strict';
var db = require('./db.js');
var row = db.init();
console.log('[init-db] 完成：revision=%d locked=%s pieces=%d placements=%d',
  row.revision, row.locked, row.doc.pieces.length, row.doc.placements.length);

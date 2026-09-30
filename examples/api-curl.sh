#!/usr/bin/env bash
# ============================================================================
# examples/api-curl.sh —— 命名试排方案 HTTP API 调用示例（curl，可直接运行）
#
# 前置：服务已启动（npm start，默认 http://localhost:3000）
# 用法：BASE=http://localhost:3000 bash examples/api-curl.sh
#
# 流程覆盖：
#   1. 读取正式版图           2. 创建命名方案（快照来源修订号）
#   3. 列出方案（含各款未排） 4. 保存方案（几何/数量/间距校验 + 方案修订号）
#   5. 校验失败 422 演示      6. 过期修订号 409 演示
#   7. 改名                   8. 晋升为正式版图（三条件）
#   9. 正式版图离开来源修订号后晋升被拒（409 SOURCE_REVISION_MOVED）
#  10. 删除方案
#
# 依赖：bash、curl，以及 node（仅用于从 JSON 中提取字段；也可改用 jq）
#
# 注意：本脚本会【写入并修改】正式版图数据（创建/保存/晋升/删除示例方案，
#       并把一片演示裁片晋升进正式版图），建议对一次性的临时库运行：
#         DB_PATH=/tmp/demo.db PORT=3000 node server/server.js &
#         BASE=http://localhost:3000 bash examples/api-curl.sh
# ============================================================================
set -euo pipefail
BASE="${BASE:-http://localhost:3000}"
# 仓库根目录（本脚本位于 <root>/examples/ 下），用于引用同一份几何引擎
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=process.argv[1].split(".");let v=JSON.parse(s);for(const k of f)v=v[k];process.stdout.write(String(v))})' "$1"; }
req() { # method path [json-body]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -sS -X "$m" "$BASE$p" -H 'content-type: application/json' -d "$b" -w '\n[HTTP %{http_code}]\n'
  else
    curl -sS -X "$m" "$BASE$p" -w '\n[HTTP %{http_code}]\n'
  fi
}

echo "=== 0) 健康检查：读取正式版图 ==="
BOARD_JSON="$(curl -sS "$BASE/api/board")"
echo "$BOARD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("正式版图 revision =",j.revision," locked =",j.locked)})'
BOARD_REV="$(echo "$BOARD_JSON" | jget revision)"

echo; echo "=== 1) 从当前【未锁定】正式版图创建命名方案 ==="
echo "    POST /api/schemes {\"name\":\"试排-示例A\"}"
CREATED="$(curl -sS -X POST "$BASE/api/schemes" -H 'content-type: application/json' -d '{"name":"试排-示例A"}')"
echo "$CREATED"
SID="$(echo "$CREATED" | jget scheme.id)"
SRC_REV="$(echo "$CREATED" | jget scheme.sourceRevision)"
SREV="$(echo "$CREATED" | jget scheme.revision)"
echo "    -> 方案 id=$SID，来源修订号=$SRC_REV，方案自身修订号=$SREV"

echo; echo "=== 2) 方案列表：名称 / 来源修订号 / 方案修订号 / 各款未排数量 ==="
req GET /api/schemes

echo; echo "=== 3) 读取方案完整 doc（含 fabric/defects/pieces/placements） ==="
curl -sS "$BASE/api/schemes/$SID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("方案",j.name,"布幅",j.doc.fabric.width+"x"+j.doc.fabric.height,"款式",j.doc.pieces.length,"放置",j.doc.placements.length)})'

echo; echo "=== 4) 保存方案：用 node 基于模板几何生成一片合法放置，PUT 携带方案修订号 ==="
SAVE_BODY="$(curl -sS "$BASE/api/schemes/$SID" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const G=require(process.argv[1]+"/shared/geom.js");
  const j=JSON.parse(s);
  const p=j.doc.pieces[0];
  j.doc.placements.push({id:"pl-demo-1",pieceId:p.id,angle:p.allowedAngles[0],x:3,y:3,
    points:G.transformTemplate(p.points,p.allowedAngles[0],3,3)});
  process.stdout.write(JSON.stringify({revision:j.revision,doc:j.doc}));
})' "$ROOT")"
echo "$SAVE_BODY" > /tmp/scheme-save.json
curl -sS -X PUT "$BASE/api/schemes/$SID" -H 'content-type: application/json' -d @/tmp/scheme-save.json \
  -w '\n[HTTP %{http_code}]\n'
SREV=$((SREV+1))
echo "    （保存成功后方案修订号应为 $SREV）"

echo; echo "=== 5) 校验失败演示：把裁片放到布面外 -> 422 VALIDATION_FAILED，整份方案不变 ==="
BAD_BODY="$(echo "$SAVE_BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const G=require(process.argv[1]+"/shared/geom.js");
  const b=JSON.parse(s);
  const p=b.doc.pieces[1];
  b.doc.placements.push({id:"pl-bad",pieceId:p.id,angle:0,x:9999,y:9999,
    points:G.transformTemplate(p.points,0,9999,9999)});
  process.stdout.write(JSON.stringify({revision:Number(process.argv[2]),doc:b.doc}));
})' "$ROOT" "$SREV")"
echo "$BAD_BODY" | curl -sS -X PUT "$BASE/api/schemes/$SID" -H 'content-type: application/json' -d @- \
  -w '\n[HTTP %{http_code}]\n' | head -c 600; echo

echo; echo "=== 6) 过期修订号演示：仍用第 1 版修订号保存 -> 409 REVISION_STALE，不覆盖 ==="
echo "$SAVE_BODY" | curl -sS -X PUT "$BASE/api/schemes/$SID" -H 'content-type: application/json' -d @- \
  -w '\n[HTTP %{http_code}]\n'

echo; echo "=== 7) 改名 PATCH（同样携带修订号，成功后方案修订号 +1） ==="
req PATCH "/api/schemes/$SID" "{\"revision\":$SREV,\"name\":\"试排-示例A-改名\"}"
SREV=$((SREV+1))

echo; echo "=== 8) 晋升为正式版图（三条件：方案修订号未过期 / 正式版仍在来源修订号 / 未锁定） ==="
echo "    此时正式版图 revision=$BOARD_REV，方案来源=$SRC_REV；二者相等且未锁定则成功："
req POST "/api/schemes/$SID/promote" "{\"revision\":$SREV}"

echo; echo "=== 9) 演示 SOURCE_REVISION_MOVED ==="
echo "    9a) 正式版晋升后为修订号 $((BOARD_REV+1))，再创建方案 C（来源即该新修订号）："
SID3="$(curl -sS -X POST "$BASE/api/schemes" -H 'content-type: application/json' -d '{"name":"试排-示例C"}' | jget scheme.id)"
echo "        方案 C id=$SID3"
echo "    9b) 其他人随后又保存了一次正式版图（PUT /api/board），正式版修订号再 +1："
NEXT_BOARD="$(curl -sS "$BASE/api/board" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(JSON.stringify({revision:j.revision,doc:j.doc}))})')"
echo "$NEXT_BOARD" | curl -sS -X PUT "$BASE/api/board" -H 'content-type: application/json' -d @- \
  -o /dev/null -w '        PUT /api/board -> [HTTP %{http_code}]\n'
echo "    9c) 此时再晋升方案 C：正式版已不在其来源修订号 -> 409 SOURCE_REVISION_MOVED，不部分切换："
req POST "/api/schemes/$SID3/promote" '{"revision":1}'

echo; echo "=== 10) 删除示例方案（不影响正式版图与其他方案） ==="
req DELETE "/api/schemes/$SID"
req DELETE "/api/schemes/$SID3"

echo; echo "完成。正式版图当前状态："
req GET /api/board

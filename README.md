# 🧵 服装裁片排版编辑器（Marker Editor）

本机完成版图编辑的 Web 应用：输入**布幅尺寸、缺陷多边形、各款裁片（多边形 / 所需数量 / 允许旋转角度 / 安全间距）**，在画布上拖放排料；保存时服务端按**旋转平移后的实际轮廓**全量复核数量、布边、缺陷与片间间距，任一不合格整张版图不变并标出冲突对象与原因。支持**乐观修订号**防多人覆盖、**锁定**后禁改，并输出含每片位置/角度与未排数量的**可下载裁切清单（CSV）**。

排版人员还可从**未锁定的正式版图**创建多份**命名试排方案**，分别调整布面、缺陷、款式与裁片摆放；方案保存沿用同一套全量校验与自身修订号，确认满意后可原子地**切换为正式版图**（晋升）。

- 后端：Node.js + Express + better-sqlite3（SQLite 单文件，同步事务）
- 前端：原生 HTML/CSS + Canvas 2D，无构建步骤
- 几何：`shared/geom.js` 前后端同一份代码（旋转、自交检测、多边形距离、防翻面模板比对）

## 规则（与需求逐条对应）

| 规则 | 实现 |
|---|---|
| 裁片不能翻面 | 提交的实际轮廓必须等于模板按允许角度旋转+平移的结果；并校验有向面积符号（镜像必拒） |
| 距布边/缺陷 | 每片净距 **≥ 自身安全间距**，恰等允许（`gap >= margin`） |
| 两片之间 | 净距 **≥ max(甲间距, 乙间距)**，恰等允许 |
| 数量 | 每款已排数不得超过所需数量；清单输出未排数量（未排满允许锁定，清单明示） |
| 非法输入 | 自交多边形、布幅/数量非正、角度非数值、负间距等一律 422 拒绝并说明原因 |
| 原子保存 | 校验在写库前进行；失败不触碰数据库，**整张版图保持原样**；写库用 SQLite 事务 |
| 多人并发 | 每次保存/锁定必须携带所见 `revision`；过期返回 409，不覆盖新稿 |
| 锁定 | `locked=1` 后任何写操作返回 423；仅可查看与下载清单 |
| 输出 | 锁定后页面显示每片 `编号/位置(X,Y)/角度` 与所需/已排/未排数量，提供 CSV 下载 |

### 试排方案（本轮新增）

| 规则 | 实现 |
|---|---|
| 创建 | 仅能从**未锁定**正式版图创建；服务端以当时正式版图 doc 生成快照，记录 `sourceRevision`（来源修订号），方案自身 `revision` 从 1 开始 |
| 多份命名 | 同一份正式版图可派生任意数量命名方案，互不影响、互不锁定 |
| 保存 | `PUT /api/schemes/:id` 沿用正式版图同一套几何/数量/间距全量校验；422 返回冲突且**整份方案不变**；携带方案自身 `revision`，过期返回 409 不覆盖他人修改；正式版图锁定后方案仍可继续试排 |
| 列表 | `GET /api/schemes` 返回方案名称、来源修订号、自身修订号、更新时间与各款所需/已排/**未排数量**，并附正式版图当前修订号/锁定状态 |
| 切换为正式版图 | `POST /api/schemes/:id/promote` 在**单个 SQLite 事务**内依次确认：方案存在 → 正式版图未锁定 → 方案修订号未过期 → 正式版图仍停留在来源修订号；全部满足才覆盖正式版图 doc、`revision+1`、解锁置 0；**其他方案保持原样** |
| 无部分切换 | 晋升前置条件任一不满足：不写任何数据，返回 409/423 并附正式版图当前版本、方案当前修订号、来源修订号与原因（`stale-scheme` / `board-moved` / `board-locked`） |
| 兼容性 | 原 `/api/board` 读取/保存/锁定与 `/api/cutlist` 接口不变；启动方式（`npm start` / Docker）不变，旧数据库首次启动自动加建 `schemes` 表 |

## 一键启动（Docker，含依赖安装与初始化）

```bash
docker compose up --build
```

容器启动时自动完成：安装依赖 → 首次运行自动建表并写入一份示例版图（布幅 150×100cm、1 个缺陷、3 款裁片）。

- 网页地址：**http://localhost:3000**
- 端口：容器内 `3000`，宿主机默认映射 `3000`；可用环境变量改宿主机端口：
  ```bash
  HOST_PORT=8080 docker compose up --build   # -> http://localhost:8080
  ```
- 数据持久化在 compose 命名卷 `marker-data`（容器内 `/data/marker.db`）。
- 停止：`docker compose down`（加 `-v` 会连数据卷一并删除）。

## 本机直接运行（不用 Docker）

要求 Node.js ≥ 18（开发环境为 Node 20）。

```bash
npm install          # 安装依赖（better-sqlite3 需 python3/make/g++，一般有预编译包）
npm run init-db      # 初始化 SQLite（写入 data/marker.db 与示例数据；重复执行不覆盖）
npm start            # 启动服务
```

打开 **http://localhost:3000**。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `./data/marker.db` | SQLite 数据库文件路径（Docker 内为 `/data/marker.db`） |

复位为初始示例：删除数据库后重启即可（Docker：`docker compose down -v && docker compose up`；本机：`rm -rf data && npm run init-db`）。

## 使用说明

1. **① 布面设置**
   - 顶部输入布幅宽/高（cm，必须为正）。
   - 「✎ 绘制缺陷」：在画布上单击逐点画缺陷多边形，双击/回车闭合；右侧可删除。
   - 款式库：填名称、所需数量、安全间距、允许角度（如 `0,90,180,270`），「新增」快速建矩形片，或「✎ 绘制裁片轮廓」画任意不自交多边形。
2. **② 排版编辑**
   - 款式卡片点「＋ 放置」加入布面（达到所需数量自动置灰）。
   - 鼠标拖曳移动；选中后用角度按钮 / R（右转）/ Q（左转）旋转——**只能在允许角度之间切换**；Delete 删除。
   - 滚轮缩放、空格/中键拖动画布；可勾选「显示间距圈」辅助排料。
   - 顶部「保存版图」：服务端全量校验。失败时右侧弹出冲突清单，画布上红色虚线标出冲突裁片与最近点连线（净距/要求值），点冲突项自动定位；**已保存的版图不变**。
   - 修订号过期时会提示并可选择载入他人新稿，旧稿不会覆盖新稿。
3. **③ 试排方案**（本轮新增）
   - 顶栏「🧪 新建试排」或本页「＋ 从当前正式版图创建方案」：输入名称，即从未锁定的正式版图当前修订号复制一份可编辑快照并自动打开。
   - 方案内的编辑操作与正式版图完全一致（布面、缺陷、款式、放置、旋转、删除）；顶部青绿色横幅显示**方案名 / 方案修订号 / 来源修订号**。
   - 「保存方案」同样走服务端全量校验：冲突时弹出冲突清单、画布标红，**整份方案不变**；方案修订号过期会提示载入他人新稿。
   - 列表每项显示名称、方案修订号、来源修订号与各款未排数量；正式版图已推进到更新修订号的方案会标注「来源已过期」（仍可打开继续试排，但无法直接晋升）。
   - 「⬆ 切换为正式版图」：确认后服务端原子晋升——成功则正式版图修订号递增并载入新稿；条件不满足时弹窗给出当前版本与原因，**不产生部分切换**。
   - 「↩ 返回正式版图」回到正式版图（有未保存改动会先确认）；「删除」需携带方案修订号，不影响正式版图与其他方案。
4. **④ 裁切清单**
   - 确认无误后在正式版图页点顶部「锁定版图」（同样携带修订号，过期需先刷新）。
   - 锁定后禁止一切改动；该页列出每片位置与角度、各款未排数量，并可「⬇ 下载 CSV 裁切清单」。试排方案中此页仅提示先晋升再锁定。

## HTTP API

### 正式版图（原有，保持兼容）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/board` | 当前版图 `{revision, locked, doc, updatedAt}` |
| PUT | `/api/board` | 提交 `{revision, doc}`；422=校验失败（含 `conflicts[]`，整稿不变），409=修订号过期，423=已锁定 |
| POST | `/api/board/lock` | `{revision}` 锁定；409=过期，423=已锁定 |
| GET | `/api/cutlist` / `?format=csv` | 仅锁定后可用，JSON 或下载 CSV |

### 试排方案（本轮新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/schemes` | 方案列表 + 正式版图状态：`{board:{revision,locked}, schemes:[{id,name,sourceRevision,revision,remaining[]}]}` |
| POST | `/api/schemes` | 从当前正式版图创建 `{revision, name}`：201=创建成功；400=参数错误；409=`revision` 过期（`board-moved`）；423=正式版图已锁定 |
| GET | `/api/schemes/:id` | 单个方案完整数据（含 `doc` 快照、来源/自身修订号）；404=不存在 |
| PUT | `/api/schemes/:id` | 保存方案 `{revision, name?, doc}`：200=成功（方案修订号 +1）；422=校验失败（`conflicts[]`，整份方案不变）；409=方案修订号过期（`reason:"stale-scheme"`，附 `current`）；404=方案已删除 |
| DELETE | `/api/schemes/:id` | 删除方案，body 带 `{revision}`；409=修订号过期；404=不存在 |
| POST | `/api/schemes/:id/promote` | 切换为正式版图，body 带 `{revision}`（方案修订号）。成功 200=`{revision, row}`（正式版图新修订号）；422=方案本身校验不过；409=`stale-scheme`（方案过期）或 `board-moved`（正式版图已离开来源修订号）；423=`board-locked`；404=方案不存在。失败响应统一附 `board`（正式版图当前版本）、`schemeRevision`、`sourceRevision` 与 `reason` |

`remaining[]` 每项：`{pieceId, name, required, placed, remaining}`。所有几何/数量/间距规则与正式版图保存完全一致（同一份 `shared/geom.js` + `server/validator.js`）。

冲突对象在响应中带定位信息（`target` / `targets` / `defectId` / `side`、实测 `gap` 与要求 `required`、最近点 `points`），前端据此高亮。

### 调用示例（curl）

```bash
BASE=http://localhost:3000

# 1) 从修订号 0 的未锁定正式版图创建命名试排方案
curl -s -X POST $BASE/api/schemes \
  -H 'content-type: application/json' \
  -d '{"revision":0,"name":"紧排版 A"}'
# -> {"ok":true,"scheme":{"id":"sch-xxxx","name":"紧排版 A","sourceRevision":0,"revision":1,"remaining":[...]}}

# 2) 查看方案列表（名称 / 来源修订号 / 各款未排数量）
curl -s $BASE/api/schemes

# 3) 取方案全文，在 doc 上调整布面/缺陷/款式/placements 后整稿保存（携带方案修订号）
SID=sch-xxxx
curl -s $BASE/api/schemes/$SID > scheme.json
# …编辑 scheme.json 中 doc…
curl -s -X PUT $BASE/api/schemes/$SID \
  -H 'content-type: application/json' \
  -d "{\"revision\":1,\"doc\":$(node -e "process.stdout.write(JSON.stringify(require('./scheme.json').doc))")}"
# 成功 -> {"ok":true,"revision":2,"scheme":{...}}
# 校验失败 -> 422 {"error":"VALIDATION_FAILED","conflicts":[...]}（整份方案不变）
# 过期     -> 409 {"reason":"stale-scheme","current":{...当前方案...}}

# 4) 切换为正式版图（携带方案修订号；服务端原子检查全部前置条件）
curl -s -X POST $BASE/api/schemes/$SID/promote \
  -H 'content-type: application/json' -d '{"revision":2}'
# 成功 -> {"ok":true,"revision":1,"row":{...正式版图新稿...}}
# 正式版图已被他人推进 -> 409 {"reason":"board-moved","board":{"revision":7,...},"sourceRevision":0,"schemeRevision":2}
# 已锁定 -> 423 {"reason":"board-locked","board":{...},"schemeRevision":2}

# 5) 删除方案（携带方案修订号，防误删他人新稿）
curl -s -X DELETE $BASE/api/schemes/$SID -H 'content-type: application/json' -d '{"revision":2}'
```

Node 18+ 也可直接用内置 `fetch` 调用，字段与上面完全相同。

## 目录结构

```
shared/geom.js       前后端共用几何引擎（自交/距离/旋转/防翻面）
server/
  server.js          Express 入口与 REST API（版图 + 试排方案）、CSV 清单
  validator.js       保存时全量校验（结构 + 布边/缺陷/片间/数量/角度/翻面；正式版图与方案共用）
  db.js              SQLite：board 单行版图表（revision/locked 乐观锁事务）+ schemes 试排方案表（来源修订号/自身修订号、晋升事务）
  init-db.js         初始化脚本
public/              前端（index.html / styles.css / app.js 画布编辑与方案管理）
Dockerfile           镜像（含依赖安装）
docker-compose.yml   一键启动 + 数据卷 + 健康检查
```

## 坐标与单位

布面坐标单位为 **cm**，原点在布面**左下角**，x 向右、y 向上（画布按屏幕方向向下渲染）。每片放置的 `x,y` 为其旋转后包围盒左下角；`angle` 为屏幕顺时针角度（°），取自该款允许角度白名单。

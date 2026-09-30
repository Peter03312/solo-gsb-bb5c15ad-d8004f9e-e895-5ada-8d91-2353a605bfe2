# 🧵 服装裁片排版编辑器（Marker Editor）

本机完成版图编辑的 Web 应用：输入**布幅尺寸、缺陷多边形、各款裁片（多边形 / 所需数量 / 允许旋转角度 / 安全间距）**，在画布上拖放排料；保存时服务端按**旋转平移后的实际轮廓**全量复核数量、布边、缺陷与片间间距，任一不合格整张版图不变并标出冲突对象与原因。支持**乐观修订号**防多人覆盖、**锁定**后禁改，并输出含每片位置/角度与未排数量的**可下载裁切清单（CSV）**。

排版人员还可从**未锁定的正式版图**创建多份**命名试排方案**，分别调整布面、缺陷、款式与裁片摆放；方案记录**来源版图修订号**与**方案自身修订号**，保存时沿用同一套校验与乐观锁；确认满意后可在三条件满足时**一键切为正式版图**（正式版修订号递增，其余方案保持原样）。

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
| 试排方案 | 仅可从**未锁定**正式版图创建；服务端快照整稿并记录 `sourceRevision`，方案自身修订号从 1 起 |
| 方案保存 | `PUT /api/schemes/:id` 携带方案自身 `revision`；沿用同一套几何/数量/间距校验，422 时**整份方案不变**，409 表示方案修订号过期，不覆盖他人修改 |
| 方案列表 | 显示名称、来源修订号、方案修订号与**各款未排数量** |
| 方案切正式版 | 单事务同时校验：①方案 `revision` 未过期 ②正式版图仍处于 `sourceRevision` ③正式版图未锁定；成功后正式版图 `revision+1`（不锁定），其他方案保持原样；任一不满足返回当前版本与原因，**不产生部分切换** |
| 相互独立 | 方案保存/改名/删除不影响正式版图；正式版图锁定后不能新建/晋升方案，但**已存在方案仍可查看与保存** |
| 向后兼容 | 原有版图读取、保存、锁定与裁切清单接口、字段、启动方式均保持不变；旧数据库启动时自动新增 `schemes` 表 |

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
3. **③ 裁切清单**
   - 确认无误后点顶部「锁定版图」（同样携带修订号，过期需先刷新）。
   - 锁定后禁止一切改动；该页列出每片位置与角度、各款未排数量，并可「⬇ 下载 CSV 裁切清单」。
4. **🧪 试排方案（本轮新增）**
   - 点顶部「🧪 试排方案」标签进入方案管理页：顶部显示正式版图当前修订号与锁定状态；列表显示每份方案的**名称、来源修订号、方案修订号、各款未排数量**。
   - 「＋ 从当前正式版图新建方案」：仅在正式版图**未锁定**时可用；服务器把当前整稿复制为方案并记录来源修订号，方案自身修订号从 1 开始。
   - 在方案卡片点「打开编辑」即进入与正式版图完全相同的画布编辑器（顶栏出现 🧪 徽标与来源修订号）；布面、缺陷、款式、裁片摆放都可独立调整，「保存方案」执行同一套服务端全量校验——失败同样弹冲突清单且整份方案不变；方案修订号过期时提示并可载入他人新稿。
   - 「改名」「删除」在方案卡片上就地完成，均不影响正式版图与其他方案。
   - 「⬆ 切为正式版图」前会确认三项前提：**方案修订号未过期、正式版图仍停留在来源修订号、正式版图未锁定**。成功后正式版图修订号递增、内容换成该方案（保持解锁），其他方案原样保留；条件不满足时弹窗给出当前版本与原因，不产生部分切换。正式版图已变动（或已锁定）的方案，按钮会自动置灰并提示原因。
   - 「↩ 返回正式版图编辑」随时切回正式版图上下文。

## HTTP API

### 正式版图（原有，保持兼容）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/board` | 当前版图 `{revision, locked, doc, updatedAt}` |
| PUT | `/api/board` | 提交 `{revision, doc}`；422=校验失败（含 `conflicts[]`，整稿不变），409=修订号过期，423=已锁定 |
| POST | `/api/board/lock` | `{revision}` 锁定；409=过期，423=已锁定 |
| GET | `/api/cutlist` / `?format=csv` | 仅锁定后可用，JSON 或下载 CSV |

冲突对象在响应中带定位信息（`target` / `targets` / `defectId` / `side`、实测 `gap` 与要求 `required`、最近点 `points`），前端据此高亮。

### 命名试排方案（本轮新增）

所有响应均为 JSON。`doc` 结构与正式版图完全相同（`{fabric, defects, pieces, placements}`），方案接口复用同一套服务端校验。

| 方法 | 路径 | 请求体 / 说明 | 主要状态码 |
|---|---|---|---|
| GET | `/api/schemes` | 方案列表：`{schemes:[{id,name,sourceRevision,revision,createdAt,updatedAt,groups:[{pieceId,name,required,placed,remaining}]}]}` | 200 |
| POST | `/api/schemes` | `{name?}`：从当前**未锁定**正式版图快照创建；省略名称自动命名；返回 `{ok,scheme}`（方案 `revision=1`，`sourceRevision=正式版当前 revision`） | 201 / 423 正式版已锁定 |
| GET | `/api/schemes/:id` | 单个方案（含完整 `doc`） | 200 / 404 / 400 |
| PUT | `/api/schemes/:id` | `{revision, doc}`：全量校验后按**方案自身修订号**原子保存，成功 `revision+1` | 200 / **422 校验失败（整份方案不变，含 `conflicts[]`）** / **409 方案修订号过期（含 `current`）** / 404 |
| PATCH | `/api/schemes/:id` | `{revision, name}`：改名，成功 `revision+1` | 200 / 409 / 400 / 404 |
| DELETE | `/api/schemes/:id` | 删除方案（不影响正式版图与其他方案） | 200 / 404 |
| POST | `/api/schemes/:id/promote` | `{revision}`：方案切为正式版图 | 200 / 见下 |

`POST /api/schemes/:id/promote` 在**单个 SQLite 事务**内校验三项前提，任一不满足即整体回滚（不产生部分切换）：

| 条件 | 不满足时 | 响应 |
|---|---|---|
| 方案 `revision` 未过期 | 409 | `{error:"SCHEME_REVISION_STALE", scheme:{…当前版本…}}` |
| 正式版图未锁定 | 423 | `{error:"BOARD_LOCKED", board:{revision,locked}, sourceRevision}` |
| 正式版图仍处于 `sourceRevision` | 409 | `{error:"SOURCE_REVISION_MOVED", board:{revision,locked}, sourceRevision}` |
| 方案几何/数量/间距仍合法（晋升前防御性复核） | 422 | `{error:"VALIDATION_FAILED", conflicts:[…]}` |

成功响应：`{ok:true, revision:<正式版图新修订号>, locked:false, row:{…正式版图…}, promotedFrom:{schemeId, schemeRevision}}`。正式版图修订号 +1、内容替换为方案 `doc` 并保持解锁；`schemes` 表不做任何改动（其他方案自然保持原样）。

> 说明：方案创建于正式版图未锁定时；正式版图之后锁定不会影响已存在方案的读取与保存，只是禁止再新建方案或把方案晋升上去。

### 调用示例

可直接运行的端到端示例（创建 → 保存 → 校验失败/过期演示 → 改名 → 晋升 → 来源漂移拒绝 → 删除）：

```bash
# 建议先起一个一次性临时库，避免示例改动真实数据
DB_PATH=/tmp/demo.db PORT=3000 node server/server.js &
BASE=http://localhost:3000 bash examples/api-curl.sh
```

几个最小 `curl`：

```bash
# 1) 创建方案（正式版图当前必须未锁定）
curl -s -X POST localhost:3000/api/schemes \
  -H 'content-type: application/json' -d '{"name":"夜班试排 A"}'

# 2) 列表：名称 / 来源修订号 / 方案修订号 / 各款未排数量
curl -s localhost:3000/api/schemes

# 3) 保存方案（务必携带方案自身 revision；doc 同正式版图结构）
curl -s -X PUT localhost:3000/api/schemes/1 \
  -H 'content-type: application/json' \
  -d '{"revision":1,"doc":{ ...与 /api/board 的 doc 相同... }}'

# 4) 切为正式版图（携带方案自身 revision）
curl -s -X POST localhost:3000/api/schemes/1/promote \
  -H 'content-type: application/json' -d '{"revision":3}'
```

## 目录结构

```
shared/geom.js       前后端共用几何引擎（自交/距离/旋转/防翻面）
server/
  server.js          Express 入口与 REST API、CSV 清单、试排方案路由
  validator.js       保存时全量校验（正式版图与方案共用：结构 + 布边/缺陷/片间/数量/角度/翻面）
  db.js              SQLite：board 单行版图表 + schemes 方案表，revision/locked/sourceRevision 乐观锁事务
  init-db.js         初始化脚本
public/              前端（index.html / styles.css / app.js 画布编辑 + 方案管理页）
examples/
  api-curl.sh        试排方案 HTTP API 的可运行 curl 调用示例
Dockerfile           镜像（含依赖安装）
docker-compose.yml   一键启动 + 数据卷 + 健康检查
```

数据库升级：旧版本只有 `board` 表；新版启动时以 `CREATE TABLE IF NOT EXISTS` 自动建立 `schemes` 表，**不改动既有版图数据**，启动方式（`npm start` / `docker compose up`）保持不变。

## 坐标与单位

布面坐标单位为 **cm**，原点在布面**左下角**，x 向右、y 向上（画布按屏幕方向向下渲染）。每片放置的 `x,y` 为其旋转后包围盒左下角；`angle` 为屏幕顺时针角度（°），取自该款允许角度白名单。

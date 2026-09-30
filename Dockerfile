# 服装裁片排版编辑器 —— 镜像
# better-sqlite3 为原生模块：优先使用预编译包，若无则本地编译（保留 python3/make/g++）
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 先拷依赖清单，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# 拷贝源码
COPY . .

# 数据目录（可被命名卷覆盖）；首次启动时 server 会自动建表并写入样例版图
RUN mkdir -p /data
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/marker.db

EXPOSE 3000

# 健康检查：用 node 自带能力请求 API（slim 镜像无 curl）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/board').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 启动即“安装依赖后的初始化 + 服务”：db.init 自动建表/种子
CMD ["node", "server/server.js"]

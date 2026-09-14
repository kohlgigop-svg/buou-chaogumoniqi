# Dockerfile —— 多阶段构建（规格 §17）。
#
# 产出镜像 = 生产依赖 + server/dist + shared/dist + web/dist，由同一个 Fastify
# 进程同源托管 API 与前端（无 CORS、无 nginx、无反向代理）。
#
# ⚠️ builder 与 runner 必须**同为 Node 22**（这一条是硬要求，不是优化）：
#   `better-sqlite3` 是原生模块，ABI 随 Node 大版本变化。
#   **实证勘误**：prebuilt 二进制**不是**多份并存、也**不会**"按目标 Node 自动挑选" ——
#   `prebuild-install` 是按**安装时**运行的 Node 大版本**只下载一份**。
#   本机实测：Node 24 下 `npm ci` 拉到的二进制带 `node_register_module_v137`，
#   在 Node 22（ABI 127）下加载直接失败：
#     `The module … was compiled against a different Node.js version using
#      NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 127.`
#   所以两阶段都钉 `node:22-bookworm-slim`，且 runner **不再** `npm install`
#   （直接搬 builder 的 node_modules）—— 从根上锁死一致性。
#   推论：**绝不可以把宿主机的 node_modules 拷进镜像**（这也是 .dockerignore 排除它的原因之一）。
#   注意这与本机开发环境不同（本机测试用系统 Node 24 / ABI 137，见 server/README.md）。
#
# glibc vs musl：用 `bookworm-slim`（Debian / glibc）而不是 `alpine`（musl），
#   因为 better-sqlite3 / @node-rs/argon2 的 prebuilt 二进制都是按 glibc 发布的，
#   换 musl 就得退化成源码编译（需要 python3/make/g++，镜像体积与构建时间都显著上升）。

# ---------- Stage 1: builder ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# 只先拷依赖清单：依赖没变时这一层的缓存可复用，改业务代码不会重装依赖。
# 注意 workspaces 的三个子包清单都必须拷进来，否则 `npm ci` 无法还原 workspace 拓扑。
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY web/package.json ./web/

# `npm ci` 严格按 lockfile 安装（不解析、不升级），devDependencies 也要装 —— 构建需要 tsc / vite。
#
# ⚠️ 依赖安装是本 Dockerfile 最慢、也最容易失败的一步（本机实测 9 分钟以上；
#   Linux 下还要拉 better-sqlite3 / @node-rs/argon2 / esbuild 的 linux-x64 二进制）。
#   网络抖动会让单次失败直接毁掉整次部署，故显式加大重试与超时：
#   - `fetch-retries=5` + `fetch-retry-maxtimeout=120000`：默认 2 次重试/60s 超时偏紧；
#   - `fetch-timeout=600000`：大二进制（better-sqlite3 ~2MB、esbuild ~10MB）在慢链路上易超时。
#   构建层缓存（COPY 依赖清单在前、源码在后）保证依赖没变时不再重跑这一层。
#
# 关于 npm 11 的 `allow-scripts` 警告：它**不会**跳过 install 脚本（实测 `npm rebuild` 后
#   better-sqlite3 的 `.node` 二进制被正常重建），只是提示可在 CI 中显式审批。
#   故无需加 `--ignore-scripts` 或审批配置；加 `ignore-scripts=true` 反而会让原生模块缺失。
RUN npm ci \
      --fetch-retries=5 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000

# 拷源码与配置（node_modules / dist / data / *.db 已在 .dockerignore 里排除，
# 否则宿主机的 dist 会盖掉下面的构建输出、宿主机 node_modules 会污染镜像 ABI）。
COPY . .

# 顺序敏感：shared 先出 dist（server 的生产 import 走 Node 原生解析，不能加载 .ts），
# 然后 server（tsc + copy-assets.mjs 把 *.sql 迁移拷进 dist —— tsc 不处理非 .ts 文件），
# 最后 web（vite build → web/dist）。
RUN npm run build

# 裁掉 devDependencies：runner 只搬生产依赖。
# ⚠️ `npm prune --omit=dev` 会**保留 workspaces 的内部符号链接**（shared/server/web 互链），
# 故 shared 的 dist 仍能被 `@pt/shared` 正常解析。
RUN npm prune --omit=dev

# ---------- Stage 2: runner ----------
FROM node:22-bookworm-slim AS runner

ENV NODE_ENV=production
# 数据目录固定在 /data（挂持久卷；规格 §18 第 9 条：重启后数据不丢）。
ENV DATABASE_PATH=/data/game.db
ENV DATA_DIR=/data
ENV PORT=8080

WORKDIR /app

# node:22 镜像自带 uid/gid 1000 的 `node` 用户，直接用非 root 运行。
# 先建 /data 并归 node 所有，否则容器以 node 身份起不来（WAL 要在库文件同目录写 -wal/-shm）。
RUN mkdir -p /data && chown -R node:node /data

# 从 builder 搬生产依赖 + 三份构建产物。
# 只搬这些：源码、devDependencies、测试、宿主机的本地数据一概不进镜像。
COPY --from=builder --chown=node:node /app/node_modules        ./node_modules
COPY --from=builder --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=builder --chown=node:node /app/shared/dist         ./shared/dist
COPY --from=builder --chown=node:node /app/server/package.json ./server/package.json
COPY --from=builder --chown=node:node /app/server/dist         ./server/dist
COPY --from=builder --chown=node:node /app/web/dist            ./web/dist

# ⚠️ 必须重建 workspace 符号链接，而且相对层级是 `../../`（不是 `../`）。
#
# 背景：`npm ci` 在 workspaces 下会建 `node_modules/@pt/shared -> <仓库根>/shared`，
# 且是**绝对路径**软链。绝对路径在 Docker 里能存活（/app 两阶段一致），但一旦
# 镜像被搬动（导 tar、换 WORKDIR、多平台构建缓存）就会指向不存在的位置。
# 更关键的是：**软链断掉时 Node 不会报错，而是继续向上层目录查找** ——
# 实测 `@pt/shared` 会一路找到宿主机的 `E:\布偶\paper-trader\shared\src\index.ts`，
# 于是 `exports.default` 形同虚设，Node 试图加载 .ts 源码，报出
# `does not provide an export named '...'` 这种**完全指不到根因**的错误。
#
# 所以这里显式重建为**相对**软链，让镜像自洽、可搬运。
#
# 层级别写错：软链存在于 `/app/node_modules/@pt/` 目录内，
# 要到 `/app/shared` 需要先退出 `@pt` 再退出 `node_modules` —— 即 `../../shared`。
# （写成 `../shared` 会解析到 `/app/node_modules/shared`，不存在 → 触发上面那个静默向上查找的坑。）
RUN mkdir -p /app/node_modules/@pt \
 && ln -sfn ../../shared /app/node_modules/@pt/shared \
 && ln -sfn ../../server /app/node_modules/@pt/server \
 && ln -sfn ../../web    /app/node_modules/@pt/web \
 && chown -h node:node /app/node_modules/@pt/shared /app/node_modules/@pt/server /app/node_modules/@pt/web

USER node

EXPOSE 8080

# 健康检查打 /healthz（无鉴权，返回 {ok:true,...}）。
# 用 node 内置 fetch 而不是 curl/wget：slim 镜像里没有 curl，装一个只为探活不值当。
# start-period 给足：首次启动要跑数据库迁移 + 分块补跑（超过一个交易日时会按天分块推进）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接 node 起进程（不要 npm start）：让 PID 1 就是 node，SIGTERM 能直接送达，
# 走 index.ts 里注册的优雅退出（engine.stop → app.close → db.close）。
CMD ["node", "server/dist/index.js"]

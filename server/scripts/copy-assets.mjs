// scripts/copy-assets.mjs —— 把非 .ts 资源（SQL 迁移）拷进 dist。
//
// 为什么需要这一步：`tsc` 只输出 .js，而 `openDb` 在运行时用
// `readdirSync(dist/db/migrations)` 读迁移文件 —— 不拷贝就会
// `ENOENT: scandir .../dist/db/migrations` 启动即崩（实测）。
//
// 用 Node 脚本而不是 shell `cp -r`：Windows 本机与 Linux 镜像里行为一致，
// 不依赖构建机装了哪些 coreutils。
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src', 'db', 'migrations');
const outDir = join(here, '..', 'dist', 'db', 'migrations');

if (!existsSync(srcDir)) {
  console.error(`[copy-assets] source not found: ${srcDir}`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
cpSync(srcDir, outDir, { recursive: true });
console.log(`[copy-assets] migrations -> ${outDir}`);

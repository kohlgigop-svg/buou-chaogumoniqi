import { defineConfig } from 'vitest/config';
// pool: 'forks' —— better-sqlite3 原生模块在 worker_threads 下退出时偶发 0xC0000005（Windows），
// 进程隔离是 vitest 对原生插件的官方建议；仅影响测试进程模型，不改任何断言。
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'forks' } });

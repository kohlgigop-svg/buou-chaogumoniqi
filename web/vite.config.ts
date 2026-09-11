import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期把 /api 与 /ws 代理到本地 Fastify（同源假象，Cookie 直接生效，无需 CORS）。
// 生产期由 Fastify @fastify/static 同源托管 dist/，故 build 产物用相对根路径即可。
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  test: {
    // 用 projects 拆分两种环境（environmentMatchGlobs 已废弃）：
    //   纯函数测试跑 node（更快）；组件测试 *.test.tsx 需要 DOM，跑 jsdom。
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          globals: true,
          setupFiles: ['./test/setup.ts'],
          include: ['test/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./test/setup.ts'],
          include: ['test/**/*.test.tsx'],
        },
      },
    ],
  },
});

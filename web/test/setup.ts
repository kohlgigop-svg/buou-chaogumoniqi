// test/setup.ts —— vitest 全局前置：注册 jest-dom 匹配器 + 补齐 jsdom 缺失的浏览器 API。
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom 不实现 ResizeObserver，而 lightweight-charts（K 线）在挂载时**必须**用到它。
// 缺了它会直接抛 ReferenceError，把整个页面组件的渲染带崩（不只是图表不显示）。
// 提供最小可用的空实现：图表在测试里不需要真实布局尺寸。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  } as unknown as typeof ResizeObserver;
}

// jsdom 也不实现 canvas 2D/WebGL 上下文，lightweight-charts 绘制时会调用。
// 返回一个宽松的假上下文即可让它走完挂载流程（测试不校验像素）。
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    canvas: document.createElement('canvas'),
    clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn(),
    beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), clip: vi.fn(),
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), scale: vi.fn(), rotate: vi.fn(),
    setTransform: vi.fn(), resetTransform: vi.fn(),
    fillText: vi.fn(), strokeText: vi.fn(), measureText: () => ({ width: 0 }),
    drawImage: vi.fn(), putImageData: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    createPattern: () => null,
    setLineDash: vi.fn(), getLineDash: () => [],
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// matchMedia 同样是 fancy-canvas（lightweight-charts 依赖）在监听 DPR 变化时要用的。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

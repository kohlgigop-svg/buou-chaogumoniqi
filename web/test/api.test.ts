import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, ApiError, setOnUnauthorized, api } from '../src/api.js';

// 服务端错误信封恒为 { code, message }（api/app.ts setErrorHandler）。
// 客户端必须把它还原成 ApiError，而不是让 UI 去解析状态码。
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

/** 捕获异常并断言为 ApiError，避免在每处写 `as` 断言。 */
async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setOnUnauthorized(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('2xx 返回解析后的 JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ user: { id: 1, username: 'alice' } }));
    const r = await request<{ user: { id: number; username: string } }>('/api/me');
    expect(r.user.username).toBe('alice');
  });

  it('始终带 credentials: same-origin，保证会话 Cookie 生效', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await request('/api/me');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('same-origin');
  });

  it('GET 不加 content-type（无请求体）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await request('/api/me');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
  });

  it('POST 带 JSON 请求体与 content-type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await request('/api/orders', { method: 'POST', body: { code: '600000' } });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ code: '600000' }));
  });

  it('204 无内容 → 返回 undefined 而非解析失败', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(request('/api/orders/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('ApiError', () => {
  it('4xx 抛 ApiError，code / status / message 正确', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'INSUFFICIENT_CASH', message: 'not enough cash' }, 400));
    const err = await expectApiError(request('/api/orders', { method: 'POST', body: {} }));
    expect(err.code).toBe('INSUFFICIENT_CASH');
    expect(err.status).toBe(400);
    expect(err.message).toBe('not enough cash');
  });

  it('5xx 同样抛 ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'INTERNAL', message: 'internal error' }, 500));
    const err = await expectApiError(request('/api/me'));
    expect(err.code).toBe('INTERNAL');
    expect(err.status).toBe(500);
  });

  it('错误体非 JSON（如网关 HTML）→ 回落到通用 code，不抛解析异常', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
    const err = await expectApiError(request('/api/me'));
    expect(err.status).toBe(502);
    expect(err.code).toBe('HTTP_502');
  });
});

describe('onUnauthorized', () => {
  it('401 触发回调（会话失效 → 跳登录）', async () => {
    const spy = vi.fn();
    setOnUnauthorized(spy);
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'UNAUTHORIZED', message: 'not logged in' }, 401));
    await request('/api/me').catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('4xx（非 401）不触发回调', async () => {
    const spy = vi.fn();
    setOnUnauthorized(spy);
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'BAD_QTY', message: 'bad qty' }, 400));
    await request('/api/orders', { method: 'POST', body: {} }).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('setOnUnauthorized(null) 可注销回调', async () => {
    const spy = vi.fn();
    setOnUnauthorized(spy);
    setOnUnauthorized(null);
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'UNAUTHORIZED', message: 'x' }, 401));
    await request('/api/me').catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('api 便捷方法', () => {
  it('api.get 透传 query 参数', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await api.get('/api/ledger', { limit: 20, before: 100 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe('/api/ledger?limit=20&before=100');
  });

  it('api.get 忽略 undefined 的 query 参数', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await api.get('/api/ledger', { limit: undefined, before: 100 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe('/api/ledger?before=100');
  });

  it('api.post 走 POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await api.post('/api/auth/login', { username: 'a', password: 'b' });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  it('api.del 走 DELETE', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.del('/api/orders/5');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('DELETE');
  });
});

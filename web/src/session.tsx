// session.tsx —— 登录态 Context。
//
// 为什么用 Context 而不是全局变量：测试需要脱离网络直接构造「已登录/访客/管理员」，
// 组件也不必各自去请求 /api/me。生产由 SessionProvider 包住整个应用，
// 启动时探测一次 GET /me。
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { authApi, setOnUnauthorized, type AuthUser } from './api.js';

export type Session =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authed'; user: AuthUser };

export interface SessionApi {
  status: Session['status'];
  /**
   * 当前用户。仅当 `status === 'authed'` 时非空 —— 用判别联合让 TS 收窄，
   * 避免调用方在已判断 status 后还要再写一次 null 检查。
   */
  user: AuthUser | null;
  /** 登录/注册成功后写入会话；之后无需再请求 /me。 */
  setUser: (u: AuthUser) => void;
  /** 主动登出（调用服务端 + 清本地）。 */
  logout: () => Promise<void>;
}

/** 判别辅助：收窄后 `user` 必非空。 */
export function isAuthed(s: SessionApi): s is SessionApi & { status: 'authed'; user: AuthUser } {
  return s.status === 'authed' && s.user !== null;
}

const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (ctx === null) throw new Error('useSession must be used within <SessionProvider>');
  return ctx;
}

export interface SessionProviderProps {
  children: ReactNode;
  /** 测试注入口：跳过启动探测，直接给定初始态。 */
  initial?: Session;
}

export function SessionProvider({ children, initial }: SessionProviderProps): React.JSX.Element {
  const [session, setSession] = useState<Session>(initial ?? { status: 'loading' });

  useEffect(() => {
    if (initial !== undefined) return;      // 测试注入态不探测
    let alive = true;
    setOnUnauthorized(() => { if (alive) setSession({ status: 'anonymous' }); });
    authApi.me()
      .then(me => { if (alive) setSession({ status: 'authed', user: me.user }); })
      .catch(() => { if (alive) setSession({ status: 'anonymous' }); });
    return () => { alive = false; setOnUnauthorized(null); };
  }, [initial]);

  const value: SessionApi = {
    status: session.status,
    user: session.status === 'authed' ? session.user : null,
    setUser: (u: AuthUser) => setSession({ status: 'authed', user: u }),
    logout: async () => {
      try { await authApi.logout(); } catch { /* 网络失败也要清本地态 */ }
      setSession({ status: 'anonymous' });
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

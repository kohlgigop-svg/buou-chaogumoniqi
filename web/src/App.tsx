// App.tsx —— 路由挂载点。会话由 SessionProvider 提供（缺省走启动探测 GET /me）。
//
// Provider 顺序：SessionProvider 在外（RealtimeProvider 要读登录态决定是否建 WS 连接）。
import { useRoutes } from 'react-router-dom';
import { SessionProvider } from './session.js';
import { RealtimeProvider } from './lib/realtime.js';
import { routes } from './routes.js';

export default function App({ initialSession }: { initialSession?: Parameters<typeof SessionProvider>[0]['initial'] }) {
  return (
    <SessionProvider {...(initialSession !== undefined ? { initial: initialSession } : {})}>
      <RealtimeProvider>
        <RouterOutlet />
      </RealtimeProvider>
    </SessionProvider>
  );
}

function RouterOutlet(): React.JSX.Element | null {
  return useRoutes(routes);
}

// pages/Login.tsx —— 登录页。
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { authApi, ApiError } from '../api.js';
import { errorText } from '../errors.js';
import { useSession } from '../session.js';

export default function Login(): React.JSX.Element {
  const { setUser } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authApi.login(username.trim(), password);
      setUser(r.user);
      navigate(from, { replace: true });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? errorText(e2.code) : '网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1 className="auth__brand">大布偶证券交易所</h1>
      <p className="auth__sub">模拟炒股 · 无真实资金</p>
      <form className="auth__form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field__label">用户名</span>
          <input className="field__input" value={username} autoComplete="username"
            onChange={e => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">密码</span>
          <input className="field__input" type="password" value={password}
            autoComplete="current-password" onChange={e => setPassword(e.target.value)} />
        </label>
        {err !== null ? <div className="auth__error" role="alert">{err}</div> : null}
        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
      <p className="auth__foot">
        还没有账号？<Link to="/register">立即注册</Link>
      </p>
    </div>
  );
}

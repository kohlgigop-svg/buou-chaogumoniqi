// pages/Register.tsx —— 注册页。校验规则与 @pt/shared 的 RegisterSchema 保持一致，
// 前端先挡一道给出即时反馈，服务端仍会再校验（不信任前端）。
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authApi, ApiError } from '../api.js';
import { errorText } from '../errors.js';
import { useSession } from '../session.js';

const USERNAME_RE = /^[\w\u4e00-\u9fa5]+$/;

export default function Register(): React.JSX.Element {
  const { setUser } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): string | null {
    const u = username.trim();
    if (u.length < 2 || u.length > 16) return '用户名长度需在 2–16 个字符之间';
    if (!USERNAME_RE.test(u)) return '用户名只能包含中英文、数字与下划线';
    if (password.length < 8 || password.length > 72) return '密码长度需在 8–72 个字符之间';
    return null;
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    const local = validate();
    if (local !== null) { setErr(local); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await authApi.register(username.trim(), password);
      setUser(r.user);
      navigate('/', { replace: true });
    } catch (e2) {
      setErr(e2 instanceof ApiError ? errorText(e2.code) : '网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1 className="auth__brand">创建账号</h1>
      <p className="auth__sub">初始资金 ¥100,000.00 · 虚拟盘</p>
      <form className="auth__form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field__label">用户名</span>
          <input className="field__input" value={username} autoComplete="username"
            onChange={e => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">密码</span>
          <input className="field__input" type="password" value={password}
            autoComplete="new-password" onChange={e => setPassword(e.target.value)} />
        </label>
        {err !== null ? <div className="auth__error" role="alert">{err}</div> : null}
        <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
          {busy ? '注册中…' : '注册'}
        </button>
      </form>
      <p className="auth__foot">
        已有账号？<Link to="/login">去登录</Link>
      </p>
    </div>
  );
}

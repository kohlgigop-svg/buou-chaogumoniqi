// pages/Profile.tsx —— 资料：账户概览 + 改密码 + 退出登录。
//
// 改密码走后端 `POST /api/auth/password`，服务端会**踢掉除当前会话外的所有 session**
// （见 `api/auth.ts`），故成功提示必须说清这一点 —— 否则用户会以为其它设备还能用。
//
// ⚠️ 密码强度先在前端拦一道：服务端 zod 只校验格式，前端拦下可以省一次
// 失败请求，但**不能替代**服务端的校验（两边都要有）。
import { useEffect, useState } from 'react';
import { authApi, type MeView } from '../api.js';
import { fmtMoney, fmtPct } from '../format.js';
import Card, { KeyValue } from '../components/Card.js';
import { Spinner } from '../components/Spinner.js';
import ErrorBox from '../components/ErrorBox.js';
import { errorText } from '../errors.js';
import { useSession } from '../session.js';

/** 与服务端 `ChangePasswordSchema` 对齐的最小长度。 */
const MIN_PASSWORD = 8;

export default function Profile(): React.JSX.Element {
  const session = useSession();
  const [me, setMe] = useState<MeView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    authApi.me()
      .then(r => { if (alive) setMe(r); })
      .catch(e => { if (alive) setErr(e); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="profile">
      {msg !== null ? (
        <div className={`order__result order__result--${msg.tone}`} role="status">{msg.text}</div>
      ) : null}

      <Card title="账户概览">
        {err !== null ? (
          <ErrorBox error={err} />
        ) : me === null ? (
          <Spinner />
        ) : (
          <div className="profile__grid">
            <KeyValue label="用户名" value={me.user.username} />
            <KeyValue label="信誉分" value={me.user.credit} />
            <KeyValue label="总资产" value={fmtMoney(me.valuation.totalAssets)} />
            <KeyValue
              label="累计收益率"
              value={fmtPct(me.valuation.returnPct)}
              tone={me.valuation.returnPct > 0 ? 'up' : me.valuation.returnPct < 0 ? 'down' : 'flat'}
            />
            <KeyValue label="可用资金" value={fmtMoney(me.valuation.cashAvailable)} />
            <KeyValue label="冻结资金" value={fmtMoney(me.valuation.cashFrozen)} />
            <KeyValue label="持仓市值" value={fmtMoney(me.valuation.positionsValue)} />
            <KeyValue label="未偿贷款" value={fmtMoney(me.valuation.loansOutstanding)} />
            <KeyValue label="破产次数" value={me.user.bankruptCount} />
          </div>
        )}
      </Card>

      <PasswordForm onResult={setMsg} />

      <Card title="会话">
        <button
          type="button"
          className="btn btn--block"
          data-testid="logout"
          onClick={() => void session.logout()}
        >
          退出登录
        </button>
      </Card>
    </div>
  );
}

/** 改密码表单。`onResult` 把结果交给父级统一展示（与借款/还款同一套路）。 */
function PasswordForm({ onResult }: {
  onResult: (m: { tone: 'ok' | 'err'; text: string }) => void;
}): React.JSX.Element {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    onResult({ tone: 'ok', text: '' });   // 清掉旧提示（父级用 tone 无所谓，下面立刻覆盖）
    if (newPw.length < MIN_PASSWORD) {
      setLocalErr(`新密码至少 ${MIN_PASSWORD} 位`);
      return;
    }
    if (newPw !== confirm) {
      setLocalErr('两次输入的新密码不一致');
      return;
    }
    if (oldPw === '') {
      setLocalErr('请输入当前密码');
      return;
    }
    setLocalErr(null);
    setBusy(true);
    try {
      await authApi.changePassword(oldPw, newPw);
      setOldPw(''); setNewPw(''); setConfirm('');
      onResult({ tone: 'ok', text: `密码已修改，其它设备上的会话已被踢出。` });
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : '';
      onResult({ tone: 'err', text: errorText(code) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="修改密码">
      <div className="pwform" data-testid="pw-form">
        <label className="pwform__field">
          <span className="pwform__label">当前密码</span>
          <input
            className="order__input" type="password" autoComplete="current-password"
            data-testid="pw-old" value={oldPw}
            onChange={e => setOldPw(e.target.value)}
          />
        </label>
        <label className="pwform__field">
          <span className="pwform__label">新密码</span>
          <input
            className="order__input" type="password" autoComplete="new-password"
            data-testid="pw-new" value={newPw}
            onChange={e => setNewPw(e.target.value)}
          />
        </label>
        <label className="pwform__field">
          <span className="pwform__label">确认新密码</span>
          <input
            className="order__input" type="password" autoComplete="new-password"
            data-testid="pw-confirm" value={confirm}
            onChange={e => setConfirm(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn--block btn--primary"
          data-testid="pw-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? '提交中…' : '修改密码'}
        </button>
        {localErr !== null ? (
          <div className="pwform__err" role="alert">{localErr}</div>
        ) : null}
      </div>
    </Card>
  );
}

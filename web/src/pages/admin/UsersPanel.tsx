// pages/admin/UsersPanel.tsx —— 用户表：搜索 / 信誉分 / 破产次数 / 封禁状态 + 重置密码 + 封禁解封。
//
// 两个写操作都**必须二次确认**（重置密码会踢掉该用户全部会话、封禁会立刻断开其连接），
// 且确认弹窗要说清后果，而不只是重复按钮名。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, type AdminUserRow, type ApiError } from '../../api.js';
import { fmtMoney, fmtPct } from '../../format.js';
import { filterUsers, userStatusLabel, initialOf } from '../adminLogic.js';
import { Confirm, Toast } from '../../components/Confirm.js';
import { Spinner, Empty } from '../../components/Spinner.js';
import ErrorBox from '../../components/ErrorBox.js';
import { creditTier } from '../homeLogic.js';

/** 待确认的动作（null = 无弹窗）。 */
type Pending =
  | { kind: 'ban'; user: AdminUserRow }
  | { kind: 'unban'; user: AdminUserRow };

export default function UsersPanel(): React.JSX.Element {
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [pwdFor, setPwdFor] = useState<AdminUserRow | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const r = await adminApi.users();
      // 防御性取字段：响应缺 `users`（网关截断、旧版服务端、代理返回错误体）时，
      // 直接 `setUsers(undefined)` 会让 `filterUsers` 抛错并卸载整棵 React 树 ——
      // 管理后台白屏比"显示空表"严重得多，故这里退化为空数组。
      setUsers(Array.isArray(r.users) ? r.users : []);
    } catch (e) { setErr(e); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(
    () => (users === null ? [] : filterUsers(users, query)),
    [users, query],
  );

  const runAction = async (): Promise<void> => {
    if (pending === null) return;
    const { kind, user } = pending;
    setPending(null);
    try {
      if (kind === 'ban') await adminApi.ban(user.id);
      else await adminApi.unban(user.id);
      setToast({ msg: `已${kind === 'ban' ? '封禁' : '解封'} ${user.username}`, tone: 'ok' });
      await load();
    } catch (e) {
      setToast({ msg: (e as ApiError).message, tone: 'error' });
    }
  };

  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (users === null) return <Spinner />;

  return (
    <div className="apanel">
      <input
        className="input" type="search" placeholder="搜索用户名"
        data-testid="admin-user-search"
        value={query} onChange={e => setQuery(e.target.value)}
      />

      {shown.length === 0 ? (
        <Empty text={query.trim() === '' ? '暂无用户' : `没有匹配「${query.trim()}」的用户`} />
      ) : (
        <div className="paged__scroll">
          <table className="paged__table" data-testid="admin-users">
            <thead>
              <tr>
                <th>用户</th><th className="num">信誉分</th><th className="num">破产</th>
                <th>状态</th><th className="num">总资产</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(u => (
                <tr key={u.id}>
                  <td>
                    <span className="auser">
                      <span className="auser__avatar" aria-hidden="true">{initialOf(u.username)}</span>
                      <span className="auser__name">{u.username}</span>
                      {/* 注意 `u.isAdmin` 是 0/1 整数（服务端未转换，见 api.ts 注释），
                          故用 `=== 1` 而不是真值判断，避免将来类型放宽后误判。 */}
                      {u.isAdmin === 1 ? <span className="chip chip--sm">管理员</span> : null}
                    </span>
                  </td>
                  <td className={`num ${creditTier(u.credit)}`}>{u.credit}</td>
                  <td className="num" data-testid={`user-bankrupt-${u.id}`}>{u.bankruptCount}</td>
                  <td data-testid={`user-status-${u.id}`}>
                    {/* tone-danger（红・语义色）= 封禁；正常态用中性灰，避免满屏红绿。
                        不用 tone-up —— 那是「涨」的方向色。 */}
                    <span className={u.status === 'banned' ? 'tone-danger' : 'tone-flat'}>
                      {userStatusLabel(u.status)}
                    </span>
                  </td>
                  <td className="num">{fmtMoney(u.valuation.totalAssets)}</td>
                  <td>
                    <div className="arow-actions">
                      <button type="button" className="btn btn--sm"
                        data-testid={`reset-pwd-${u.id}`}
                        onClick={() => setPwdFor(u)}>重置密码</button>
                      <button type="button"
                        className={`btn btn--sm ${u.status === 'banned' ? '' : 'btn--danger'}`}
                        data-testid={`ban-${u.id}`}
                        onClick={() => setPending({ kind: u.status === 'banned' ? 'unban' : 'ban', user: u })}>
                        {u.status === 'banned' ? '解封' : '封禁'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending !== null ? (
        <Confirm
          title={`${pending.kind === 'ban' ? '封禁' : '解封'}用户 ${pending.user.username}？`}
          danger={pending.kind === 'ban'}
          confirmText={pending.kind === 'ban' ? '确认封禁' : '确认解封'}
          body={pending.kind === 'ban' ? (
            <>
              <p>该用户<b>所有会话将立即失效</b>（含正在进行的操作），且无法再登录。</p>
              <p className="dialog__hint">其持仓、流水与负债都会保留，解封后恢复原状。</p>
            </>
          ) : (
            <p>恢复 {pending.user.username} 的登录与交易权限。</p>
          )}
          onConfirm={() => void runAction()}
          onCancel={() => setPending(null)}
        />
      ) : null}

      {pwdFor !== null ? (
        <ResetPasswordDialog
          user={pwdFor}
          onDone={(msg, tone) => { setToast({ msg, tone }); void load(); }}
          onClose={() => setPwdFor(null)}
        />
      ) : null}

      {toast !== null ? (
        <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />
      ) : null}
    </div>
  );
}

// ---------- 重置密码弹窗 ----------

const MIN_PWD = 8;

function ResetPasswordDialog({
  user, onDone, onClose,
}: {
  user: AdminUserRow;
  onDone: (msg: string, tone: 'ok' | 'error') => void;
  onClose: () => void;
}): React.JSX.Element {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    // 与服务端 `ResetPwdSchema`（min 8, max 72）保持一致；本地先拦避免白跑一趟。
    if (pwd.length < MIN_PWD) { setError(`新密码至少 ${MIN_PWD} 位`); return; }
    if (pwd.length > 72) { setError('新密码最多 72 位'); return; }
    setError(null); setBusy(true);
    try {
      await adminApi.resetPassword(user.id, pwd);
      // 服务端会 `DELETE FROM sessions WHERE user_id = ?` —— 其全部会话立刻失效。
      onDone(`已重置 ${user.username} 的密码，该用户所有会话已被踢出`, 'ok');
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="重置密码"
        data-testid="reset-pwd-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog__title">重置 {user.username} 的密码</div>
        <div className="dialog__body">
          <p>设置后该用户<b>所有会话将立即失效</b>，需要用新密码重新登录。</p>
          <input
            className="input" type="password" placeholder={`新密码（至少 ${MIN_PWD} 位）`}
            data-testid="reset-pwd-input" autoComplete="new-password"
            value={pwd} onChange={e => setPwd(e.target.value)}
          />
          {error !== null
            ? <div className="form__error" data-testid="reset-pwd-error">{error}</div>
            : null}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn btn--primary" data-testid="reset-pwd-submit"
            disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '确认重置'}
          </button>
        </div>
      </div>
    </div>
  );
}

void fmtPct;

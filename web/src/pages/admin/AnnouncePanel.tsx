// pages/admin/AnnouncePanel.tsx —— 公告发布 + 当前公告列表。
import { useCallback, useEffect, useState } from 'react';
import { adminApi, marketApi, type ApiError } from '../../api.js';
import { Toast } from '../../components/Confirm.js';
import { Spinner } from '../../components/Spinner.js';

const MAX_LEN = 500;

interface Announcement { id: number; day: number; content: string; createdAt: number }

export default function AnnouncePanel(): React.JSX.Element {
  const [content, setContent] = useState('');
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const r = await marketApi.announcements();
      // `r.items ?? []`：公告列表是**次要信息**，响应缺字段不该让整个后台白屏
      // （`items.length` 对 undefined 求值会抛，React 会把整棵树卸载掉）。
      setItems(Array.isArray(r.items) ? r.items : []);
    } catch { setItems([]); }   // 列表失败不影响发布功能
  }, []);

  useEffect(() => { void load(); }, [load]);

  const submit = async (): Promise<void> => {
    const text = content.trim();
    if (text === '') {
      setToast({ msg: '公告内容不能为空', tone: 'error' });
      return;
    }
    setBusy(true);
    try {
      await adminApi.announce(text);
      setContent('');            // 成功后清空，避免误发第二次
      setToast({ msg: '公告已发布', tone: 'ok' });
      await load();
    } catch (e) {
      setToast({ msg: (e as ApiError).message, tone: 'error' });
    } finally { setBusy(false); }
  };

  const over = content.length > MAX_LEN;

  return (
    <div className="apanel" data-testid="admin-announce">
      <label className="form__label" htmlFor="ann-input">公告内容</label>
      <textarea
        id="ann-input" className={`input textarea ${over ? 'is-invalid' : ''}`}
        rows={3} placeholder="给全体玩家的通知（发布后立即出现在资讯页）"
        data-testid="admin-announce-input"
        value={content} onChange={e => setContent(e.target.value)}
      />
      <div className="form__row">
        <span className={`form__hint num ${over ? 'tone-danger' : ''}`}>
          {content.length} / {MAX_LEN}
        </span>
        <button type="button" className="btn btn--primary"
          data-testid="admin-announce-submit" disabled={busy || over}
          onClick={() => void submit()}>
          {busy ? '发布中…' : '发布公告'}
        </button>
      </div>

      <h3 className="apanel__sub">已发布</h3>
      {items === null ? <Spinner /> : items.length === 0 ? (
        <div className="empty">暂无公告</div>
      ) : (
        <ul className="annlist" data-testid="admin-announce-list">
          {items.map(a => (
            <li key={a.id} className="annlist__item">
              <span className="annlist__day">第 {a.day} 日</span>
              <span className="annlist__text">{a.content}</span>
            </li>
          ))}
        </ul>
      )}

      {toast !== null
        ? <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />
        : null}
    </div>
  );
}

// pages/admin/ConfigPanel.tsx —— 配置热改：当前值一览 + 写入单个 override。
//
// 设计取舍：
//   ① 前端做白名单校验**不是为了安全**（前端永远不是安全边界，服务端 400 `CONFIG_KEY` 才是），
//      而是为了不让用户白等一次往返才被告知"这个键不能改"。
//   ② 值的类型必须让用户看见。`1` 与 `"1"` 在 JSON 里是两种东西，
//      写错会让下游比较静默失配，所以提交前显式回显"将写入什么类型的什么值"。
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminConfigView, type ApiError } from '../../api.js';
import { errorText } from '../../errors.js';
import {
  checkConfigKey, parseConfigValue, describeValue, CONFIG_WHITELIST_PREFIXES,
} from '../adminLogic.js';
import { Toast } from '../../components/Confirm.js';
import { Spinner } from '../../components/Spinner.js';
import ErrorBox from '../../components/ErrorBox.js';

export default function ConfigPanel(): React.JSX.Element {
  const [view, setView] = useState<AdminConfigView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [key, setKey] = useState('');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const r = await adminApi.config();
      // 防御性取字段：缺 `config` 会让 `Object.keys` 抛错并卸载整棵树。
      // 宁可显示"暂无配置"，也不要白屏 —— 值班时能看到一个空面板远好过看到一片空白。
      setView({
        config: (r.config ?? {}) as Record<string, unknown>,
        overrides: Array.isArray(r.overrides) ? r.overrides : [],
      });
    } catch (e) { setErr(e); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const parsed = parseConfigValue(raw);

  const submit = async (): Promise<void> => {
    const ck = checkConfigKey(key);
    if (!ck.ok) {
      // 本地拦截：一次网络往返都不发。服务端仍会独立校验一遍。
      setError(ck.reason ?? '配置键不合法');
      return;
    }
    if (!parsed.ok) {
      setError(parsed.reason ?? '配置值不合法');
      return;
    }
    setError(null);
    setBusy(true);
    const sentKey = key.trim();
    try {
      await adminApi.putConfig(sentKey, parsed.value);
      // 回显**发送的键**而不是响应里的 `key`：服务端回显缺字段时会写成"undefined = 1"，
      // 那行提示就成了误导。发送值才是用户此刻真正关心的。
      setToast({ msg: `已写入 ${sentKey} = ${describeValue(parsed.value)}`, tone: 'ok' });
      setRaw('');
      await load();      // 刷新当前值，让 override 立刻可见
    } catch (e) {
      const e2 = e as ApiError;
      // 服务端 CONFIG_KEY → errors.ts 中文文案；其它码回落原始信息。
      setError(errorText(e2.code) || e2.message);
    } finally { setBusy(false); }
  };

  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (view === null) return <Spinner />;

  const sections = Object.keys(view.config).sort();

  return (
    <div className="apanel" data-testid="admin-config">
      <section className="apanel__card">
        <h3 className="apanel__sub">当前生效配置</h3>
        <p className="apanel__hint">
          白名单：仅 <code>{CONFIG_WHITELIST_PREFIXES.join(' / ')}</code> 开头的键可热改。
          <code>auth.*</code>、<code>engine.*</code> 等需重启进程 —— 前端会先拦住，不浪费一次往返。
        </p>
        <div className="cfg">
          {sections.map(sec => (
            <div key={sec} className="cfg__sec">
              <div className="cfg__sec-name">{sec}</div>
              <ul className="cfg__list">
                {Object.entries(view.config[sec] as Record<string, unknown>).map(([k, v]) => (
                  <li key={k} className="cfg__item">
                    <span className="cfg__key">{sec}.{k}</span>
                    <span className="cfg__val num">{describeValue(v)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="apanel__card">
        <h3 className="apanel__sub">热改一个键</h3>
        <div className="cfg__form">
          <input
            className="input" placeholder="配置键，如 work.shiftsPerDay"
            aria-label="配置键"
            data-testid="config-key"
            value={key} onChange={e => { setKey(e.target.value); setError(null); }}
          />
          <input
            className="input num" placeholder='值（JSON 优先），如 1 或 "1" 或 {"a":1}'
            aria-label="配置值"
            data-testid="config-value"
            value={raw} onChange={e => { setRaw(e.target.value); setError(null); }}
          />
          <button type="button" className="btn btn--primary" data-testid="config-submit"
            disabled={busy} onClick={() => void submit()}>
            {busy ? '写入中…' : '写入'}
          </button>
        </div>

        {/* 让用户看见"我们理解成了什么"：数字 / 字符串 / JSON 三态差异很大。 */}
        {raw.trim() !== '' && parsed.ok ? (
          <p className="cfg__preview">
            将写入 <span className="cfg__preview-kind">
              {parsed.kind === 'json' ? 'JSON 值' : '字符串'}
            </span>
            {' '}<code>{describeValue(parsed.value)}</code>
          </p>
        ) : null}

        {error !== null
          ? <div className="form__error" data-testid="config-error">{error}</div>
          : null}
      </section>

      {view.overrides.length > 0 ? (
        <section className="apanel__card">
          <h3 className="apanel__sub">已写入的 override</h3>
          <ul className="cfg__list">
            {view.overrides.map(o => (
              <li key={o.key} className="cfg__item">
                <span className="cfg__key">{o.key}</span>
                <span className="cfg__val num">{o.value}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {toast !== null
        ? <Toast message={toast.msg} tone={toast.tone} onClose={() => setToast(null)} />
        : null}
    </div>
  );
}

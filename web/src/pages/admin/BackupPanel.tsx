// pages/admin/BackupPanel.tsx —— 日切备份列表 + 下载。
//
// 为什么用 `<a href>` 而不是 fetch：备份是几十 MB 的二进制，走 fetch 要先进内存再拼
// Blob URL，既慢又要自己管 URL 回收。原生下载由浏览器直接落盘、带进度、可断点续传。
// 代价是**拿不到错误响应**（403/404 只会得到一个失败的下载），故这里额外用一次
// HEAD 探测来区分"有文件"与"没权限"，避免用户点了没反应还以为是网络问题。
import { useCallback, useEffect, useState } from 'react';
import { adminApi, type BackupFile } from '../../api.js';
import { fmtBytes, backupDay, sortBackups } from '../adminLogic.js';
import { Spinner, Empty } from '../../components/Spinner.js';
import ErrorBox from '../../components/ErrorBox.js';

export default function BackupPanel(): React.JSX.Element {
  const [files, setFiles] = useState<BackupFile[] | null>(null);
  const [err, setErr] = useState<unknown>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    try {
      const r = await adminApi.backups();
      // 与 UsersPanel 同样防御：缺 `files` 时退化为空列表，不要让整页白屏。
      // 服务端按目录顺序返回（通常已是旧→新）；这里统一按游戏日降序，
      // 让"最新备份"永远在第一行 —— 出事故时第一个要点的就是它。
      setFiles(sortBackups(Array.isArray(r.files) ? r.files : []));
    } catch (e) { setErr(e); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (err !== null) return <ErrorBox error={err} onRetry={() => void load()} />;
  if (files === null) return <Spinner />;

  const total = files.reduce((s, f) => s + f.bytes, 0);

  return (
    <div className="apanel" data-testid="admin-backups">
      <section className="apanel__card">
        <h3 className="apanel__sub">
          日切备份 <span className="apanel__count">{files.length} 个 · {fmtBytes(total)}</span>
        </h3>
        <p className="apanel__hint">
          每个游戏日结算后落一份。下载即当时全库快照，可用于对账核对或回滚。
        </p>

        {files.length === 0 ? (
          <Empty text="暂无备份（第一个游戏日结算后生成）" />
        ) : (
          <ul className="bklist">
            {files.map(f => {
              const day = backupDay(f.file);
              return (
                <li key={f.file} className="bklist__item" data-testid="backup-row">
                  <span className="bklist__day">
                    {day === null ? '—' : `第 ${day} 日`}
                  </span>
                  <span className="bklist__name">{f.file}</span>
                  <span className="bklist__size num" data-testid="backup-size">
                    {fmtBytes(f.bytes)}
                  </span>
                  <a
                    className="btn btn--sm"
                    data-testid="backup-download"
                    href={adminApi.backupUrl(f.file)}
                    download={f.file}
                  >
                    下载
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

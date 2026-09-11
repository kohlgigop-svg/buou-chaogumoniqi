// components/PagedTable.tsx —— 游标分页表格（委托 / 成交 / 流水共用）。
//
// 服务端分页语义（`api/me.ts` 的 `page()`，三张表一致）：
//   `id < before` 过滤 + `ORDER BY id DESC LIMIT n`，`nextBefore = 末条 id`。
// 由此推出两个必须在本组件内处理的后果：
//   ① 相邻两页**必然重叠一条**（下页从上一页末条开始）→ 合并必须按 id 去重；
//   ② `nextBefore` 非 null 只代表「可能还有」，不代表「一定还有」→ 末页会多一次空请求，
//      拿到空数组后才隐藏按钮。这是服务端协议决定的，不是实现偷懒。
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Spinner, Empty } from './Spinner.js';
import ErrorBox from './ErrorBox.js';
import { mergePage } from '../pages/meLogic.js';

/** 服务端 `Page<T>` 的形状。 */
export interface PageResult<T> {
  items: T[];
  nextBefore: number | null;
}

export interface Column<T> {
  /** 表头文案。 */
  head: ReactNode;
  /** 单元格内容。 */
  cell: (row: T) => ReactNode;
  /** 右对齐（数字列）。 */
  align?: 'left' | 'right';
  /** 窄屏隐藏（列多时优先砍次要列，避免横向滚动）。 */
  hideOnNarrow?: boolean;
}

export interface PagedTableProps<T extends { id: number }> {
  columns: Column<T>[];
  /** 取一页。`before` 为 undefined 表示第一页。 */
  fetchPage: (before?: number) => Promise<PageResult<T>>;
  /** 数据源变更时重置（如切换筛选条件）：值变了就回到第一页。 */
  resetKey?: string;
  emptyText?: string;
  rowTestId?: string;
  /** 每次成功加载后的回调（用于把最新页交给父组件做汇总）。 */
  onLoaded?: (merged: T[]) => void;
}

export default function PagedTable<T extends { id: number }>({
  columns, fetchPage, resetKey = '', emptyText = '暂无数据', rowTestId = 'paged-row', onLoaded,
}: PagedTableProps<T>): React.JSX.Element {
  const [items, setItems] = useState<T[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  /** 首屏加载完成过（用于区分「空态」与「还没开始」）。 */
  const [loaded, setLoaded] = useState(false);

  const loadFirst = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const p = await fetchPage(undefined);
      setItems(p.items);
      setNextBefore(p.nextBefore);
      setLoaded(true);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  // resetKey 变化 → 丢弃累积、回到第一页
  useEffect(() => { void loadFirst(); }, [loadFirst, resetKey]);

  async function loadMore(): Promise<void> {
    if (nextBefore === null) return;
    setLoading(true);
    try {
      const p = await fetchPage(nextBefore);
      // ⚠️ 必须去重：服务端 nextBefore 语义让相邻页重叠一条
      const merged = mergePage(items, p.items);
      setItems(merged);
      setNextBefore(p.nextBefore);
      onLoaded?.(merged);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
    }
  }

  if (err !== null) return <ErrorBox error={err} onRetry={() => void loadFirst()} />;
  if (!loaded) return <Spinner />;
  if (items.length === 0) {
    return <div className="paged" data-testid="paged-table">
      <div data-testid="paged-empty"><Empty text={emptyText} /></div>
    </div>;
  }

  return (
    <div className="paged" data-testid="paged-table">
      <div className="paged__scroll">
        <table className="table paged__table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className={[
                    c.align === 'right' ? 'ta-r' : '',
                    c.hideOnNarrow === true ? 'paged__narrow' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map(row => (
              <tr key={row.id} data-testid={rowTestId}>
                {columns.map((c, i) => (
                  <td
                    key={i}
                    className={[
                      c.align === 'right' ? 'ta-r' : '',
                      c.hideOnNarrow === true ? 'paged__narrow' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="paged__foot">
        {nextBefore !== null ? (
          <button
            type="button"
            className="btn btn--sm btn--block"
            data-testid="paged-more"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {loading ? '加载中…' : '加载更多'}
          </button>
        ) : (
          <span className="paged__end">没有更多了</span>
        )}
      </div>
    </div>
  );
}

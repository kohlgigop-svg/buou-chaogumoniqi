// pages/Orders.tsx —— 我的委托（可切换状态筛选）。
//
// 数据源：`GET /api/orders?limit&before&status`
// `status` ∈ open|done|cancelled|expired（服务端 zod 枚举，传其它值会 400 VALIDATION）。
import { useCallback, useState } from 'react';
import { tradeApi, type OrderRow } from '../api.js';
import { fmtMoney, fmtQty } from '../format.js';
import Card from '../components/Card.js';
import PagedTable, { type Column } from '../components/PagedTable.js';
import {
  orderStatusLabel, orderStatusTone, orderSideLabel, directionTone,
  orderTypeLabel, unfilledQty, cancellable,
} from './meLogic.js';

type Filter = 'all' | 'open' | 'done' | 'cancelled' | 'expired';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未成交' },
  { key: 'done', label: '已成交' },
  { key: 'cancelled', label: '已撤销' },
  { key: 'expired', label: '已过期' },
];

export default function Orders(): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  // ⚠️ `fetchPage` 必须是稳定引用，否则 PagedTable 的 useCallback 会每次重算、
  // useEffect 反复触发 → 无限请求。`useCallback` 依赖 filter/reload 是刻意的。
  const fetchPage = useCallback(
    (before?: number) => tradeApi.orders(
      filter === 'all'
        ? (before === undefined ? { limit: 20 } : { limit: 20, before })
        : (before === undefined ? { limit: 20, status: filter } : { limit: 20, before, status: filter }),
    ),
    [filter],
  );

  async function cancel(id: number): Promise<void> {
    setCancelling(id);
    try {
      await tradeApi.cancel(id);
      setReload(n => n + 1);      // 触发 resetKey 变化 → 回到第一页重取
    } catch { /* 失败由 ErrorBox 在下轮加载里体现；此处静默 */ }
    finally { setCancelling(null); }
  }

  const columns: Column<OrderRow>[] = [
    { head: '标的', cell: r => <span className="num">{r.code}</span> },
    {
      head: '方向',
      cell: r => (
        <span className={`tone-${directionTone(r.side)}`}>{orderSideLabel(r.side)}</span>
      ),
    },
    { head: '类型', cell: r => orderTypeLabel(r.type), hideOnNarrow: true },
    {
      head: '委托价',
      align: 'right',
      cell: r => <span className="num">{r.price === null ? '市价' : fmtMoney(r.price)}</span>,
    },
    {
      head: '数量',
      align: 'right',
      cell: r => (
        <span className="num">
          {fmtQty(unfilledQty(r.qty, r.filled))}
          <span className="table__sub">/ {fmtQty(r.qty)}</span>
        </span>
      ),
    },
    {
      head: '状态',
      cell: r => (
        <span className={`badge badge--${orderStatusTone(r.status)}`}>
          {orderStatusLabel(r.status)}
        </span>
      ),
    },
    {
      head: '操作',
      cell: r => (cancellable(r.status) ? (
        <button
          type="button"
          className="btn btn--sm"
          data-testid="cancel-order"
          disabled={cancelling === r.id}
          onClick={() => void cancel(r.id)}
        >
          {cancelling === r.id ? '撤销中…' : '撤销'}
        </button>
      ) : null),
    },
  ];

  return (
    <Card title="我的委托" flush>
      <div className="filters">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            className={`chip ${filter === f.key ? 'is-active' : ''}`}
            data-testid={`filter-${f.key}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <PagedTable
        columns={columns}
        fetchPage={fetchPage}
        resetKey={`${filter}-${reload}`}
        emptyText="暂无委托记录"
        rowTestId="order-row"
      />
    </Card>
  );
}

// pages/Trades.tsx —— 历史成交。
//
// 数据源：`GET /api/trades?limit&before`
// ⚠️ 费用列名是 `commission` / `stamp` / `transfer`（见 `db/migrations/001_init.sql`），
// **不是** `stamp_tax` / `transfer_fee`。写错会静默渲染 `undefined`。
import { useCallback } from 'react';
import { tradeApi, type TradeRow } from '../api.js';
import { fmtMoney, fmtQty } from '../format.js';
import Card from '../components/Card.js';
import PagedTable, { type Column } from '../components/PagedTable.js';
import { orderSideLabel, directionTone } from './meLogic.js';

export default function Trades(): React.JSX.Element {
  const fetchPage = useCallback(
    (before?: number) => tradeApi.trades(before === undefined ? { limit: 20 } : { limit: 20, before }),
    [],
  );

  const columns: Column<TradeRow>[] = [
    { head: '第 N 日', cell: r => <span className="num">第 {r.day} 日</span> },
    { head: '标的', cell: r => <span className="num">{r.code}</span> },
    {
      head: '方向',
      cell: r => <span className={`tone-${directionTone(r.side)}`}>{orderSideLabel(r.side)}</span>,
    },
    { head: '成交价', align: 'right', cell: r => <span className="num">{fmtMoney(r.price)}</span> },
    { head: '数量', align: 'right', cell: r => <span className="num">{fmtQty(r.qty)}</span> },
    {
      head: '成交额',
      align: 'right',
      cell: r => <span className="num">{fmtMoney(r.price * r.qty)}</span>,
    },
    {
      head: '佣金',
      align: 'right',
      hideOnNarrow: true,
      cell: r => <span className="num">{fmtMoney(r.commission)}</span>,
    },
    {
      head: '印花税',
      align: 'right',
      hideOnNarrow: true,
      cell: r => <span className="num">{fmtMoney(r.stamp)}</span>,
    },
    {
      head: '过户费',
      align: 'right',
      hideOnNarrow: true,
      cell: r => <span className="num">{fmtMoney(r.transfer)}</span>,
    },
  ];

  return (
    <Card title="历史成交" flush>
      <PagedTable
        columns={columns}
        fetchPage={fetchPage}
        emptyText="暂无成交记录"
        rowTestId="trade-row"
      />
      <p className="page-hint">
        买入无印花税；卖出印花税 0.05%、佣金万 2.5（最低 ¥5.00）、过户费万 0.1。
      </p>
    </Card>
  );
}

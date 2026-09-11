// pages/Ledger.tsx —— 资金流水。
//
// 数据源：`GET /api/ledger?limit&before`
//
// ⚠️ 三个口径必须记住（写错会给出误导性信息）：
// - `ledger` 是**双桶**（`bucket: 'A'` 可用 / `'F'` 冻结）。一笔挂单冻结会同时写
//   `F:+N` 与 `A:−N`，只显示 A 桶会让用户以为「钱消失了」。故表格**显示桶标记**。
// - `balance_after` 是**该桶余额**，**不是总资产**。列头写清「桶余额」以免误读。
// - 没有 `memo` 列；关联信息在 `ref_type` + `ref_id`。
import { useCallback } from 'react';
import { tradeApi, type LedgerRow } from '../api.js';
import { fmtMoney, fmtSignedMoney } from '../format.js';
import Card from '../components/Card.js';
import PagedTable, { type Column } from '../components/PagedTable.js';
import { ledgerKindLabel, directionTone } from './meLogic.js';

const BUCKET_LABEL: Record<string, string> = { A: '可用', F: '冻结' };

export default function Ledger(): React.JSX.Element {
  const fetchPage = useCallback(
    (before?: number) => tradeApi.ledger(before === undefined ? { limit: 20 } : { limit: 20, before }),
    [],
  );

  const columns: Column<LedgerRow>[] = [
    { head: '第 N 日', cell: r => <span className="num">第 {r.day} 日</span> },
    {
      head: '桶',
      cell: r => (
        <span className="badge badge--flat">{BUCKET_LABEL[r.bucket] ?? r.bucket}</span>
      ),
    },
    { head: '类型', cell: r => ledgerKindLabel(r.kind) },
    {
      head: '金额',
      align: 'right',
      cell: r => (
        <span className={`num tone-${directionTone('', r.amount)}`}>
          {fmtSignedMoney(r.amount)}
        </span>
      ),
    },
    {
      head: '桶余额',
      align: 'right',
      cell: r => <span className="num muted">{fmtMoney(r.balance_after)}</span>,
    },
  ];

  return (
    <Card title="资金流水" flush>
      <PagedTable
        columns={columns}
        fetchPage={fetchPage}
        emptyText="暂无流水记录"
        rowTestId="ledger-row"
      />
      <p className="page-hint">
        金额为正是入账、为负是出账。「桶余额」是该桶（可用/冻结）的余额，
        <strong>不是总资产</strong> —— 挂单冻结会同时记一笔可用减少与一笔冻结增加。
      </p>
    </Card>
  );
}

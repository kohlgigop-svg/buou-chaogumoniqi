// components/Spinner.tsx —— 加载占位与空态。
export function Spinner({ text = '加载中…' }: { text?: string }): React.JSX.Element {
  return <div className="spinner">{text}</div>;
}

export function Empty({ text = '暂无数据' }: { text?: string }): React.JSX.Element {
  return <div className="empty">{text}</div>;
}

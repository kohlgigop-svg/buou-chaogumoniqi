// components/SearchBox.tsx —— 受控搜索输入框（纯展示，过滤逻辑在调用方）。
export interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export default function SearchBox({ value, onChange, placeholder = '搜索代码 / 名称 / 板块' }: SearchBoxProps): React.JSX.Element {
  return (
    <div className="search">
      <input
        className="search__input"
        type="search"
        inputMode="search"
        value={value}
        placeholder={placeholder}
        aria-label="搜索股票"
        data-testid="search-input"
        onChange={e => onChange(e.target.value)}
      />
      {value !== '' ? (
        <button type="button" className="search__clear" aria-label="清空搜索" onClick={() => onChange('')}>
          ✕
        </button>
      ) : null}
    </div>
  );
}

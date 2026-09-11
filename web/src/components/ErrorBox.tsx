// components/ErrorBox.tsx —— 统一的错误展示。
//
// 关键：把服务端 code 交给 errorText 翻成中文，绝不直接把英文 code 抛给用户。
import { ApiError } from '../api.js';
import { errorText } from '../errors.js';

export interface ErrorBoxProps {
  error: unknown;
  onRetry?: () => void;
}

export default function ErrorBox({ error, onRetry }: ErrorBoxProps): React.JSX.Element {
  let text: string;
  if (error instanceof ApiError) text = errorText(error.code);
  else if (error instanceof Error) text = error.message;
  else text = '操作失败，请稍后重试';
  return (
    <div className="errorbox" role="alert">
      <span className="errorbox__text">{text}</span>
      {onRetry !== undefined ? (
        <button type="button" className="btn btn--sm" onClick={onRetry}>重试</button>
      ) : null}
    </div>
  );
}

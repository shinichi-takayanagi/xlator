type SessionErrorToastProps = {
  apiConfigured: boolean | null;
  message: string;
  onDismiss: () => void;
};

export function SessionErrorToast({
  apiConfigured,
  message,
  onDismiss,
}: SessionErrorToastProps) {
  if (!message) return null;

  return (
    <div className="error-toast" role="alert">
      <strong>接続できませんでした</strong>
      <span>{message}</span>
      {apiConfigured === false && <code>OPENAI_API_KEY</code>}
      <button onClick={onDismiss} aria-label="エラーを閉じる">×</button>
    </div>
  );
}

import { useT } from "../i18n.js";

/**
 * The PIN pad (Pin): big digits, dots for what's typed, never the digits
 * themselves. The screen submits by itself when the PIN is complete.
 */
export function Keypad({
  digits,
  value,
  onChange,
  disabled,
}: {
  digits: 4 | 6;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const press = (d: string) => {
    if (disabled || value.length >= digits) return;
    onChange(value + d);
  };
  return (
    <div className="keypad">
      <div className="dots" aria-hidden="true">
        {Array.from({ length: digits }, (_, i) => (
          <span key={i} className={i < value.length ? "dot filled" : "dot"} />
        ))}
      </div>
      <div className="keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0"].map((d, i) =>
          d === "" ? (
            <span key={i} />
          ) : (
            <button
              key={d}
              type="button"
              className="key"
              disabled={disabled}
              onClick={() => press(d)}
            >
              {d}
            </button>
          ),
        )}
        <button
          type="button"
          className="key"
          aria-label={t("keypad.delete")}
          disabled={disabled || value.length === 0}
          onClick={() => onChange(value.slice(0, -1))}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}

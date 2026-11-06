import * as React from "react";

const MASK = "••••••••••••••••";

/**
 * Password field for a write-only secret. A stored secret shows as a mask; focusing the field
 * clears it for a replacement, and leaving it empty shows the mask again. `value` is the replacement only.
 */
export function SecretInput({ stored, value, onChange, placeholder }: { stored: boolean; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [editing, setEditing] = React.useState(false);
  const masked = stored && !editing && !value;
  return (
    <input
      type="password"
      autoComplete="off"
      value={masked ? MASK : value}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

import React, { useEffect, useState } from "react";

type Common = { value: string[]; onChange: (items: string[]) => void };
type Props =
  | (Common & { lines?: false } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">)
  | (Common & { lines: true } & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">);

/**
 * Edits a list as comma-separated text, or one item per line with `lines`. The field keeps the text as typed,
 * so a trailing separator or an empty last line stays while the list it reports leaves out empty items.
 */
export function ListInput(props: Props) {
  const { value, onChange, lines, ...rest } = props;
  const join = (items: string[]) => items.join(lines ? "\n" : ", ");
  const parse = (text: string) => text.split(lines ? "\n" : ",").map((t) => t.trim()).filter(Boolean);
  const [text, setText] = useState(() => join(value));
  // Adopt a list changed elsewhere (a reload, a rewrite), but not the echo of what is being typed.
  useEffect(() => {
    if (join(parse(text)) !== join(value)) setText(join(value));
  }, [value]);
  const change = (t: string) => {
    setText(t);
    const items = parse(t);
    if (join(items) !== join(value)) onChange(items);
  };
  return lines ? (
    <textarea {...(rest as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} value={text} onChange={(e) => change(e.target.value)} />
  ) : (
    <input {...(rest as React.InputHTMLAttributes<HTMLInputElement>)} value={text} onChange={(e) => change(e.target.value)} />
  );
}

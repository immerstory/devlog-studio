import React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * A row of tabs that switches a view or a mode. Navigation between steps uses the "line" variant;
 * small mode switches use the default pill list. Actions are always Buttons, never tabs.
 */
export function SegTabs<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: React.ReactNode }>;
  variant?: "default" | "line";
  className?: string;
}) {
  return (
    <Tabs value={props.value} onValueChange={(v) => props.onChange(v as T)} className={props.className}>
      <TabsList variant={props.variant ?? "default"}>
        {props.items.map((item) => (
          <TabsTrigger key={item.value} value={item.value}>
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

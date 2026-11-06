import * as React from "react";
import { cn } from "cn";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One group of settings: a card with a title, an optional description and an optional header action. */
export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cn("settings-section", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      {children ? <CardContent className="settings-body">{children}</CardContent> : null}
    </Card>
  );
}

/** One entry of a list inside a section, such as a source or a connection. */
export function SettingsItem({ children }: { children: React.ReactNode }) {
  return <div className="settings-item">{children}</div>;
}

/** Page frame: heading, sections and a save bar that stays at the bottom of the window. */
export function SettingsPage({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="settings-page">
      <div className="settings-heading">
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {children}
      {footer ? <div className="settings-savebar">{footer}</div> : null}
    </div>
  );
}

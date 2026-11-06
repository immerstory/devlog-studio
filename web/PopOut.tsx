import React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function PopOutButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-xs" title="Pop out" aria-label="Pop out" onClick={onClick}>
      <HugeiconsIcon icon={ArrowExpand01Icon} strokeWidth={2} />
    </Button>
  );
}

/** A wide dialog around an editor. Closing it keeps the editor's unsaved text, because the caller holds the draft. */
export function PopOutDialog({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="editor-dialog max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-5xl"
        {...(description ? {} : { "aria-describedby": undefined })}
        // Focus the dialog itself: the default selects the first field's text, and the next key press would replace it.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.target as HTMLElement).focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

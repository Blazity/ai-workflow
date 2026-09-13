// apps/dashboard/components/cockpit/mobile/mobile-sheet.tsx
"use client";

import { Modal } from "@/components/ui/modal";

export function MobileSheet({
  open,
  onClose,
  title,
  children,
  /** Tailwind max-height class for the sheet body; defaults to ~75vh. */
  heightClass = "max-h-[75vh]",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  heightClass?: string;
}) {
  return (
    <Modal
      className={heightClass}
      open={open}
      onClose={onClose}
      title={title ?? "Menu"}
      variant="sheet"
      frameClassName="lg:hidden"
      showCloseButton
    >
      <div className="overscroll-contain">{children}</div>
    </Modal>
  );
}

import * as Dialog from "@radix-ui/react-dialog";
import {
  type ComponentPropsWithoutRef,
  type ComponentRef,
  forwardRef
} from "react";

type HostDeckDialogContentProps = ComponentPropsWithoutRef<
  typeof Dialog.Content
>;

export const HostDeckDialogContent = forwardRef<
  ComponentRef<typeof Dialog.Content>,
  HostDeckDialogContentProps
>(function HostDeckDialogContent(
  { onCloseAutoFocus, ...props },
  forwardedRef
) {
  return (
    <Dialog.Content
      {...props}
      ref={forwardedRef}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event);
        restoreHostDeckPointerOwnership();
      }}
    />
  );
});

function restoreHostDeckPointerOwnership(): void {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (
    body.style.pointerEvents !== "none" ||
    document.querySelector('[role="dialog"][data-state="open"]') !== null
  ) {
    return;
  }
  body.style.removeProperty("pointer-events");
}

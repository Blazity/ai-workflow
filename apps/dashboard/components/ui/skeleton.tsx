import type { CSSProperties, HTMLAttributes } from "react";

export type SkeletonVariant = "line" | "block" | "circle";

export interface SkeletonProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  variant?: SkeletonVariant;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
}

const variantClasses: Record<SkeletonVariant, string> = {
  line: "h-3 w-full rounded-sm",
  block: "h-20 w-full rounded-sm",
  circle: "size-8 rounded-full",
};

export function Skeleton({
  variant = "block",
  className,
  style,
  width,
  height,
  ...props
}: SkeletonProps) {
  return (
    <span
      {...props}
      aria-hidden="true"
      data-variant={variant}
      className={[
        "relative inline-block overflow-hidden bg-neutral-200/60",
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ ...style, width, height }}
    >
      <span className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-panel/60 to-transparent animate-ck-shimmer motion-reduce:animate-none" />
    </span>
  );
}

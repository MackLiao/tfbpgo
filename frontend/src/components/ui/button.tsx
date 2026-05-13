import * as React from "react";
import { cn } from "@/lib/cn";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "sm" | "md";
};

export const Button = React.forwardRef<HTMLButtonElement, Props>(
  ({ className, size = "md", type, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "rounded-md border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "px-2 py-0.5 text-xs",
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

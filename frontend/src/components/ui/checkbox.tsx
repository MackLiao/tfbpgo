import * as React from "react";
import { cn } from "@/lib/cn";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

export const Checkbox = React.forwardRef<HTMLInputElement, Props>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    className={cn("h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500", className)}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";

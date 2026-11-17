import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";
import { cva } from "class-variance-authority";
import * as Slot from "@radix-ui/react-slot";

//#region ../../apps/conversation-ui/src/components/ui/badge.tsx
const badgeVariants = cva("inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3", {
	variants: { variant: {
		default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
		secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
		destructive: "border-destructive bg-destructive-surface text-destructive focus-visible:ring-destructive/40 [a&]:hover:bg-destructive-surface/80",
		outline: "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
		ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
		link: "text-primary underline-offset-4 [a&]:hover:underline"
	} },
	defaultVariants: { variant: "default" }
});
function Badge({ className, variant = "default", asChild = false, ...props }) {
	return /* @__PURE__ */ jsx(asChild ? Slot.Root : "span", {
		"data-slot": "badge",
		"data-variant": variant,
		className: cn(badgeVariants({ variant }), className),
		...props
	});
}

//#endregion
export { Badge, badgeVariants };
//# sourceMappingURL=badge.mjs.map
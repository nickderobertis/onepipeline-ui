import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";
import { cva } from "class-variance-authority";

//#region ../../apps/conversation-ui/src/components/ui/alert.tsx
const alertVariants = cva("relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current", {
	variants: { variant: {
		default: "bg-card text-card-foreground",
		destructive: "border-destructive bg-destructive-surface text-destructive *:data-[slot=alert-description]:text-destructive [&>svg]:text-current"
	} },
	defaultVariants: { variant: "default" }
});
function Alert({ className, variant, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "alert",
		role: "alert",
		className: cn(alertVariants({ variant }), className),
		...props
	});
}
function AlertTitle({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "alert-title",
		className: cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className),
		...props
	});
}
function AlertDescription({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "alert-description",
		className: cn("col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed", className),
		...props
	});
}

//#endregion
export { Alert, AlertDescription, AlertTitle };
//# sourceMappingURL=alert.mjs.map
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert.mjs";
import { Button } from "../../../components/ui/button.mjs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible.mjs";
import { RefreshIcon } from "../../../components/ui/icons.mjs";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/error-state.tsx
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "The local bridge returned an unexpected error.";
}
function errorDetail(error) {
	if (typeof error !== "object" || error === null || !("detail" in error)) return null;
	return typeof error.detail === "string" ? error.detail : null;
}
function ErrorState({ error, onRetry }) {
	const detail = errorDetail(error);
	return /* @__PURE__ */ jsxs(Alert, {
		"aria-labelledby": "error-title",
		className: "max-w-xl border-t-3 border-t-destructive bg-card p-7 shadow-xl",
		role: "alert",
		variant: "destructive",
		children: [
			/* @__PURE__ */ jsx("p", {
				className: "text-[10px] font-bold uppercase tracking-[.13em] text-primary",
				children: "Local connection"
			}),
			/* @__PURE__ */ jsx(AlertTitle, {
				className: "mt-2 text-2xl text-foreground",
				id: "error-title",
				children: "Couldn't load conversations"
			}),
			/* @__PURE__ */ jsx(AlertDescription, {
				className: "leading-relaxed text-muted-foreground",
				children: errorMessage(error)
			}),
			detail ? /* @__PURE__ */ jsxs(Collapsible, {
				className: "my-4",
				children: [/* @__PURE__ */ jsx(CollapsibleTrigger, {
					className: "text-xs text-muted-foreground",
					children: "Technical detail"
				}), /* @__PURE__ */ jsx(CollapsibleContent, { children: /* @__PURE__ */ jsx("pre", {
					className: "mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-[10px]",
					children: detail
				}) })]
			}) : null,
			/* @__PURE__ */ jsxs(Button, {
				onClick: onRetry,
				type: "button",
				variant: "secondary",
				children: [/* @__PURE__ */ jsx(RefreshIcon, {}), " Retry"]
			})
		]
	});
}

//#endregion
export { ErrorState };
//# sourceMappingURL=error-state.mjs.map
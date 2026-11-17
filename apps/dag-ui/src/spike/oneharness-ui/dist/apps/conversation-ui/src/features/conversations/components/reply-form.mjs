"use client";

import { Button } from "../../../components/ui/button.mjs";
import { Label } from "../../../components/ui/label.mjs";
import { Textarea } from "../../../components/ui/textarea.mjs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.mjs";
import { useReplyForm } from "../hooks/use-reply-form.mjs";
import { Send } from "lucide-react";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/reply-form.tsx
function ReplyForm({ error, onSubmit, pending }) {
	const { message, setMessage, submit, validationError } = useReplyForm(onSubmit);
	return /* @__PURE__ */ jsxs("form", {
		className: "mx-auto max-w-[850px]",
		onSubmit: submit,
		children: [
			/* @__PURE__ */ jsx(Label, {
				htmlFor: "oneharness-reply",
				children: "Continue this session"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-end gap-2.5 rounded-xl border border-input bg-popover p-2 shadow-[0_18px_60px_rgb(0_0_0/.25)] focus-within:border-primary",
				children: [/* @__PURE__ */ jsx(Textarea, {
					"aria-describedby": "reply-help reply-error",
					"aria-invalid": validationError !== null || error !== null,
					className: "max-h-45 min-h-12 resize-y border-0 bg-transparent p-2.5 shadow-none focus-visible:ring-0",
					disabled: pending,
					id: "oneharness-reply",
					onChange: (event) => setMessage(event.target.value),
					onKeyDown: (event) => {
						if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					},
					placeholder: "Ask a follow-up…",
					rows: 2,
					value: message
				}), /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
					asChild: true,
					children: /* @__PURE__ */ jsx(Button, {
						"aria-label": "Send reply",
						className: "size-10 shrink-0 rounded-[10px]",
						disabled: pending,
						size: "icon",
						type: "submit",
						children: /* @__PURE__ */ jsx(Send, {})
					})
				}), /* @__PURE__ */ jsx(TooltipContent, { children: "Send reply" })] })]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-h-4 justify-between px-1 pt-1.5 text-[9px] text-subtle",
				children: [/* @__PURE__ */ jsx("span", {
					id: "reply-help",
					children: "Ctrl/⌘ Enter to send · continues the exact native session"
				}), /* @__PURE__ */ jsx("span", {
					"aria-live": "polite",
					children: pending ? "Continuing session…" : ""
				})]
			}),
			/* @__PURE__ */ jsx("p", {
				className: "text-sm font-medium text-destructive",
				id: "reply-error",
				role: "alert",
				children: validationError ?? error?.message
			})
		]
	});
}

//#endregion
export { ReplyForm };
//# sourceMappingURL=reply-form.mjs.map
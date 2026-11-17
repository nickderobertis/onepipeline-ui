import { cn } from "../../../components/utils.mjs";
import { Avatar, AvatarFallback, AvatarImage } from "../../../components/ui/avatar.mjs";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/message.tsx
function Message({ className, from, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		className: cn(from === "user" ? "flex justify-end" : "grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3.5", className),
		"data-message-author": from,
		...props
	});
}
function MessageContent({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		className: cn("min-w-0", className),
		...props
	});
}
function MessageAvatar({ children, src }) {
	return /* @__PURE__ */ jsxs(Avatar, {
		"aria-hidden": "true",
		className: "size-8 rounded-[9px]",
		children: [src ? /* @__PURE__ */ jsx(AvatarImage, {
			alt: "",
			src
		}) : null, /* @__PURE__ */ jsx(AvatarFallback, {
			className: "bg-primary text-[9px] font-extrabold text-primary-foreground",
			children
		})]
	});
}

//#endregion
export { Message, MessageAvatar, MessageContent };
//# sourceMappingURL=message.mjs.map
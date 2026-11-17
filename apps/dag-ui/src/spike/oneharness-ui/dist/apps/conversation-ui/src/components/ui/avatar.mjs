"use client";

import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";
import * as AvatarPrimitive from "@radix-ui/react-avatar";

//#region ../../apps/conversation-ui/src/components/ui/avatar.tsx
function Avatar({ className, size = "default", ...props }) {
	return /* @__PURE__ */ jsx(AvatarPrimitive.Root, {
		"data-slot": "avatar",
		"data-size": size,
		className: cn("group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6", className),
		...props
	});
}
function AvatarFallback({ className, ...props }) {
	return /* @__PURE__ */ jsx(AvatarPrimitive.Fallback, {
		"data-slot": "avatar-fallback",
		className: cn("flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs", className),
		...props
	});
}
function AvatarImage({ className, ...props }) {
	return /* @__PURE__ */ jsx("img", {
		className: cn("aspect-square size-full object-cover", className),
		"data-slot": "avatar-image",
		...props
	});
}

//#endregion
export { Avatar, AvatarFallback, AvatarImage };
//# sourceMappingURL=avatar.mjs.map
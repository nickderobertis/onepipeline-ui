"use client";

import { cn } from "../utils.mjs";
import { jsx, jsxs } from "react/jsx-runtime";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

//#region ../../apps/conversation-ui/src/components/ui/scroll-area.tsx
function ScrollArea({ className, children, ...props }) {
	return /* @__PURE__ */ jsxs(ScrollAreaPrimitive.Root, {
		"data-slot": "scroll-area",
		className: cn("relative", className),
		...props,
		children: [
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Viewport, {
				"data-slot": "scroll-area-viewport",
				className: "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
				children
			}),
			/* @__PURE__ */ jsx(ScrollBar, {}),
			/* @__PURE__ */ jsx(ScrollAreaPrimitive.Corner, {})
		]
	});
}
function ScrollBar({ className, orientation = "vertical", ...props }) {
	return /* @__PURE__ */ jsx(ScrollAreaPrimitive.ScrollAreaScrollbar, {
		"data-slot": "scroll-area-scrollbar",
		orientation,
		className: cn("flex touch-none p-px transition-colors select-none", orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent", orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent", className),
		...props,
		children: /* @__PURE__ */ jsx(ScrollAreaPrimitive.ScrollAreaThumb, {
			"data-slot": "scroll-area-thumb",
			className: "relative flex-1 rounded-full bg-border"
		})
	});
}

//#endregion
export { ScrollArea, ScrollBar };
//# sourceMappingURL=scroll-area.mjs.map
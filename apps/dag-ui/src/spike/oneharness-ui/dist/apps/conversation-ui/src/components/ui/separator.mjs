"use client";

import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";
import * as SeparatorPrimitive from "@radix-ui/react-separator";

//#region ../../apps/conversation-ui/src/components/ui/separator.tsx
function Separator({ className, orientation = "horizontal", decorative = true, ...props }) {
	return /* @__PURE__ */ jsx(SeparatorPrimitive.Root, {
		"data-slot": "separator",
		decorative,
		orientation,
		className: cn("shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px", className),
		...props
	});
}

//#endregion
export { Separator };
//# sourceMappingURL=separator.mjs.map
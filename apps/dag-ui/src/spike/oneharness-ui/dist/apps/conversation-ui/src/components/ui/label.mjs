"use client";

import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";
import * as LabelPrimitive from "@radix-ui/react-label";

//#region ../../apps/conversation-ui/src/components/ui/label.tsx
function Label({ className, ...props }) {
	return /* @__PURE__ */ jsx(LabelPrimitive.Root, {
		"data-slot": "label",
		className: cn("flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50", className),
		...props
	});
}

//#endregion
export { Label };
//# sourceMappingURL=label.mjs.map
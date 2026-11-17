"use client";

import { jsx } from "react/jsx-runtime";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

//#region ../../apps/conversation-ui/src/components/ui/collapsible.tsx
function Collapsible({ ...props }) {
	return /* @__PURE__ */ jsx(CollapsiblePrimitive.Root, {
		"data-slot": "collapsible",
		...props
	});
}
function CollapsibleTrigger({ ...props }) {
	return /* @__PURE__ */ jsx(CollapsiblePrimitive.CollapsibleTrigger, {
		"data-slot": "collapsible-trigger",
		...props
	});
}
function CollapsibleContent({ ...props }) {
	return /* @__PURE__ */ jsx(CollapsiblePrimitive.CollapsibleContent, {
		"data-slot": "collapsible-content",
		...props
	});
}

//#endregion
export { Collapsible, CollapsibleContent, CollapsibleTrigger };
//# sourceMappingURL=collapsible.mjs.map
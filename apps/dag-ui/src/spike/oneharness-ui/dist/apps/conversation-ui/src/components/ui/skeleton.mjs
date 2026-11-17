import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/components/ui/skeleton.tsx
function Skeleton({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "skeleton",
		className: cn("animate-pulse rounded-md bg-accent", className),
		...props
	});
}

//#endregion
export { Skeleton };
//# sourceMappingURL=skeleton.mjs.map
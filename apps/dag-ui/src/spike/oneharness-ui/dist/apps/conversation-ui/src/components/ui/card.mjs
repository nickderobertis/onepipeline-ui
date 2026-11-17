import { cn } from "../utils.mjs";
import { jsx } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/components/ui/card.tsx
function Card({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "card",
		className: cn("flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm", className),
		...props
	});
}
function CardContent({ className, ...props }) {
	return /* @__PURE__ */ jsx("div", {
		"data-slot": "card-content",
		className: cn("px-6", className),
		...props
	});
}

//#endregion
export { Card, CardContent };
//# sourceMappingURL=card.mjs.map
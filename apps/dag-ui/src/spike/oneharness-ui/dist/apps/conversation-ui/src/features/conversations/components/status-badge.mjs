import { cn } from "../../../components/utils.mjs";
import { Badge } from "../../../components/ui/badge.mjs";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/status-badge.tsx
const labels = {
	completed: "Completed",
	failed: "Failed",
	running: "Running",
	stopped: "Stopped"
};
function StatusBadge({ state }) {
	const tone = Object.hasOwn(labels, state) ? state : "unknown";
	return /* @__PURE__ */ jsxs(Badge, {
		className: cn("gap-1.5 uppercase tracking-[.03em]", {
			"border-destructive bg-destructive-surface text-destructive": tone === "failed",
			"border-info bg-info-surface text-info": tone === "running",
			"border-success bg-success-surface text-success": tone === "completed",
			"border-warning bg-warning-surface text-warning": tone === "stopped"
		}),
		variant: "outline",
		children: [/* @__PURE__ */ jsx("span", {
			"aria-hidden": "true",
			className: cn("size-1.5 rounded-full bg-current", tone === "running" && "animate-pulse")
		}), labels[state] ?? state]
	});
}

//#endregion
export { StatusBadge };
//# sourceMappingURL=status-badge.mjs.map
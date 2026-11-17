import { jsx } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/components/ui/icons.tsx
function Icon({ children, ...props }) {
	return /* @__PURE__ */ jsx("svg", {
		"aria-hidden": "true",
		fill: "none",
		height: "18",
		viewBox: "0 0 24 24",
		width: "18",
		...props,
		children
	});
}
function RefreshIcon(props) {
	return /* @__PURE__ */ jsx(Icon, {
		...props,
		children: /* @__PURE__ */ jsx("path", {
			d: "M19 8a7.5 7.5 0 1 0 .2 7.5M19 4v4h-4",
			stroke: "currentColor",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			strokeWidth: "1.8"
		})
	});
}

//#endregion
export { RefreshIcon };
//# sourceMappingURL=icons.mjs.map
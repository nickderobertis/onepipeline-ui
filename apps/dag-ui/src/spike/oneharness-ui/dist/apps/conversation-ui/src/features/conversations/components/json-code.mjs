import { cn } from "../../../components/utils.mjs";
import { jsx } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/json-code.tsx
const jsonTokenPattern = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g;
function parseJsonText(source) {
	try {
		return JSON.parse(source);
	} catch {
		return;
	}
}
function toJsonText(value, indent = 2) {
	try {
		return JSON.stringify(value, null, indent) ?? String(value);
	} catch {
		return String(value);
	}
}
/** One-line JSON for dense summaries such as a collapsed tool row. */
function compactJsonText(value) {
	return toJsonText(value, 0);
}
function tokenClass(value, isKey) {
	if (value.startsWith("\"")) return isKey ? "hljs-attr" : "hljs-string";
	return value === "true" || value === "false" || value === "null" ? "hljs-literal" : "hljs-number";
}
function tokens(source) {
	const nodes = [];
	let plainFrom = 0;
	for (const match of source.matchAll(jsonTokenPattern)) {
		const value = match[0];
		const start = match.index;
		if (start > plainFrom) nodes.push(source.slice(plainFrom, start));
		plainFrom = start + value.length;
		const isKey = /^\s*:/.test(source.slice(plainFrom));
		nodes.push(/* @__PURE__ */ jsx("span", {
			className: tokenClass(value, isKey),
			children: value
		}, `${start}-${value.length}`));
	}
	if (plainFrom < source.length) nodes.push(source.slice(plainFrom));
	return nodes;
}
function JsonCode({ className, label, value }) {
	return /* @__PURE__ */ jsx("pre", {
		"aria-label": label,
		className: cn("message-json", className),
		children: /* @__PURE__ */ jsx("code", { children: tokens(toJsonText(value)) })
	});
}

//#endregion
export { JsonCode, compactJsonText, parseJsonText };
//# sourceMappingURL=json-code.mjs.map
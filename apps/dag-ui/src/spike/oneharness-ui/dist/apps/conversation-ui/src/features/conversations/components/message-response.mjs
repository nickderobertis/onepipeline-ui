import { JsonCode, parseJsonText } from "./json-code.mjs";
import { jsx } from "react/jsx-runtime";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";

//#region ../../apps/conversation-ui/src/features/conversations/components/message-response.tsx
const allowedMarkdownElements = [
	"a",
	"blockquote",
	"br",
	"code",
	"del",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"li",
	"ol",
	"p",
	"pre",
	"span",
	"strong",
	"table",
	"tbody",
	"td",
	"th",
	"thead",
	"tr",
	"ul"
];
function MessageResponse({ children, label }) {
	const json = parseJsonText(children);
	if (json !== void 0) return /* @__PURE__ */ jsx(JsonCode, {
		className: "whitespace-pre",
		label: `${label} formatted JSON`,
		value: json
	});
	return /* @__PURE__ */ jsx("div", {
		className: "message-markdown",
		children: /* @__PURE__ */ jsx(Markdown, {
			allowedElements: [...allowedMarkdownElements],
			rehypePlugins: [rehypeHighlight],
			skipHtml: true,
			children
		})
	});
}

//#endregion
export { MessageResponse };
//# sourceMappingURL=message-response.mjs.map
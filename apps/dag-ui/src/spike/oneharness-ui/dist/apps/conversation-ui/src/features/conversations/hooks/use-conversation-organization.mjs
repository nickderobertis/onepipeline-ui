import { useMemo, useState } from "react";

//#region ../../apps/conversation-ui/src/features/conversations/hooks/use-conversation-organization.ts
const conversationGroupingOptions = [
	{
		label: "Recent",
		value: "none"
	},
	{
		label: "Label",
		value: "label"
	},
	{
		label: "Project",
		value: "project"
	}
];
function useConversationOrganization(conversations) {
	const [grouping, setGrouping] = useState("none");
	const [filter, setFilter] = useState("all");
	return {
		choices: useMemo(() => {
			const values = /* @__PURE__ */ new Set();
			for (const conversation of conversations) {
				const labels = conversation.labels ?? [];
				if (grouping === "project") values.add(conversation.project || "Project not recorded");
				if (grouping === "label") {
					for (const label of labels) values.add(label);
					if (labels.length === 0) values.add("Unlabeled");
				}
			}
			return [...values].sort((a, b) => a.localeCompare(b));
		}, [conversations, grouping]),
		filter,
		grouped: useMemo(() => {
			const result = /* @__PURE__ */ new Map();
			for (const conversation of conversations) {
				const labels = conversation.labels ?? [];
				const groups = grouping === "project" ? [conversation.project || "Project not recorded"] : grouping === "label" ? labels.length > 0 ? labels : ["Unlabeled"] : ["History"];
				for (const group of groups) {
					if (filter !== "all" && group !== filter) continue;
					result.set(group, [...result.get(group) ?? [], conversation]);
				}
			}
			return result;
		}, [
			conversations,
			filter,
			grouping
		]),
		grouping,
		setFilter,
		setGrouping
	};
}

//#endregion
export { conversationGroupingOptions, useConversationOrganization };
//# sourceMappingURL=use-conversation-organization.mjs.map
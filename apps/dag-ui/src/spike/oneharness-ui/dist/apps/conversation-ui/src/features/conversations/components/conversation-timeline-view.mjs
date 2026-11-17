"use client";

import { Timeline } from "../../../components/timeline.mjs";
import { pairToolEvents } from "../tool-invocations.mjs";
import { conversationTimeline } from "../conversation-timeline.mjs";
import { useState } from "react";
import { jsx } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/conversation-timeline-view.tsx
function ConversationTimeline({ cursor, focus, expanded, onExpandedChange, onSelectTurn, selectedTurnId, turns }) {
	const [internalExpanded, setInternalExpanded] = useState(false);
	const renderedExpanded = expanded ?? internalExpanded;
	const timeline = conversationTimeline({ turns });
	const focusedTurn = turns.find((turn) => turn.id === focus?.turnId);
	const focusedTool = focusedTurn && focus ? pairToolEvents(focusedTurn.tools).find((invocation) => focus.toolCallId !== void 0 ? invocation.toolCallId === focus.toolCallId : focus.eventIndex !== void 0 && invocation.eventIndices.includes(focus.eventIndex)) : void 0;
	const focusedItem = focus ? timeline.items.find((item) => item.turnId === focus.turnId && item.id === (focusedTool ? `${focus.turnId}-${focusedTool.id}` : focus.turnId)) : void 0;
	return /* @__PURE__ */ jsx(Timeline, {
		...cursor === void 0 ? {} : { cursor },
		expanded: focus ? true : renderedExpanded,
		onExpandedChange: (value) => {
			if (expanded === void 0) setInternalExpanded(value);
			onExpandedChange?.(value);
		},
		getFailureExcerpt: (item) => item.payload.turn.failureKind,
		items: timeline.items,
		label: "Conversation timeline",
		lanes: timeline.lanes,
		markers: timeline.markers,
		onSelect: (entry) => onSelectTurn(entry.payload.turn.id),
		...focusedItem ? { selectedId: focusedItem.id } : selectedTurnId ? { selectedId: selectedTurnId } : {}
	});
}

//#endregion
export { ConversationTimeline };
//# sourceMappingURL=conversation-timeline-view.mjs.map
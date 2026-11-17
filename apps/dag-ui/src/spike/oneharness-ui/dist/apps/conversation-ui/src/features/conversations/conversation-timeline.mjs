import { pairToolEvents } from "./tool-invocations.mjs";

//#region ../../apps/conversation-ui/src/features/conversations/conversation-timeline.ts
/** Rendered in this order when expanded; lanes without recorded items are omitted. */
const conversationLanes = [
	{
		id: "turns",
		label: "Turns"
	},
	{
		id: "phases",
		label: "Phases"
	},
	{
		id: "tools",
		label: "Tools"
	}
];
function instant(value) {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function reported(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function conversationTimeline(conversation) {
	const items = [];
	const markers = [];
	for (const turn of conversation.turns) {
		const start = instant(turn.startedAt) ?? instant(turn.timestamp);
		if (start === null) continue;
		const duration = reported(turn.durationMs);
		const finished = instant(turn.finishedAt);
		items.push({
			...duration !== void 0 ? { duration } : finished !== null ? { end: finished } : {},
			turnId: turn.id,
			id: turn.id,
			kind: "turn",
			label: `${turn.harness} turn`,
			laneId: "turns",
			payload: {
				turn,
				type: "turn"
			},
			start,
			status: turn.status
		});
		const phases = [["model", turn.modelMs], ["tools", turn.toolMs]];
		let phaseStart = start;
		for (const [kind, value] of phases) {
			const phaseDuration = reported(value);
			if (phaseDuration === void 0) continue;
			items.push({
				duration: phaseDuration,
				id: `${turn.id}-phase-${kind}`,
				kind: `${kind} phase`,
				label: `${kind === "model" ? "Model" : "Tool"} time`,
				laneId: "phases",
				parent: turn.id,
				payload: {
					turn,
					type: "phase"
				},
				start: phaseStart,
				status: turn.status
			});
			phaseStart += phaseDuration;
		}
		const firstToken = reported(turn.timeToFirstTokenMs);
		if (firstToken !== void 0) markers.push({
			at: start + firstToken,
			id: `${turn.id}-first-token`,
			label: "First token",
			payload: {
				turn,
				type: "milestone"
			},
			status: turn.status
		});
		for (const invocation of pairToolEvents(turn.tools)) {
			const invocationStart = instant(invocation.startedAt) ?? start;
			const invocationDuration = reported(invocation.durationMs);
			const invocationEnd = instant(invocation.finishedAt);
			items.push({
				...invocationDuration !== void 0 ? { duration: invocationDuration } : invocationEnd !== null ? { end: invocationEnd } : {},
				turnId: turn.id,
				...invocation.toolCallId === null ? {} : { toolCallId: invocation.toolCallId },
				eventIndex: Number(invocation.id.slice(5)),
				id: `${turn.id}-${invocation.id}`,
				kind: invocation.kind,
				label: invocation.name,
				laneId: "tools",
				parent: turn.id,
				payload: {
					turn,
					type: "tool"
				},
				start: invocationStart,
				status: invocation.status
			});
		}
	}
	const origin = instant(conversation.startedAt);
	return {
		items,
		lanes: conversationLanes.filter((lane) => items.some((item) => item.laneId === lane.id)),
		markers,
		...origin === null ? {} : { origin }
	};
}

//#endregion
export { conversationTimeline };
//# sourceMappingURL=conversation-timeline.mjs.map
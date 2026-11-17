//#region ../../apps/conversation-ui/src/features/conversations/tool-invocations.ts
const toolResultKind = "tool_result";
function firstReported(...candidates) {
	for (const candidate of candidates) if (candidate !== void 0 && candidate !== null) return candidate;
	return null;
}
function unpairedCall(pairs) {
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		const pair = pairs[index];
		if (pair?.call && !pair.result) return pair;
	}
}
function toInvocation({ call, result }) {
	const anchor = call ?? result;
	const kind = anchor?.kind ?? toolResultKind;
	return {
		eventIndices: [call?.index, result?.index].filter((index) => index !== void 0),
		durationMs: firstReported(call?.durationMs, result?.durationMs),
		finishedAt: firstReported(call?.finishedAt, result?.finishedAt),
		id: `tool-${anchor?.index ?? 0}`,
		input: call?.input ?? result?.input,
		kind,
		name: firstReported(call?.name, result?.name) ?? kind,
		output: firstReported(result?.output, call?.output),
		startedAt: firstReported(call?.startedAt, result?.startedAt),
		status: firstReported(call?.status, result?.status),
		timingSource: firstReported(call?.timingSource, result?.timingSource),
		toolCallId: firstReported(call?.toolCallId, result?.toolCallId)
	};
}
/**
* Groups a turn's raw action events into one invocation per tool call. Results correlate by
* `toolCallId` when the harness reports one and otherwise attach to the nearest preceding
* unanswered call. An event that pairs with nothing stays its own invocation rather than
* disappearing.
*/
function pairToolEvents(events) {
	const pairs = [];
	const openCalls = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (event.kind === toolResultKind) {
			const correlated = event.toolCallId ? openCalls.get(event.toolCallId) : unpairedCall(pairs);
			if (correlated && !correlated.result) {
				correlated.result = event;
				if (correlated.call?.toolCallId) openCalls.delete(correlated.call.toolCallId);
				continue;
			}
			pairs.push({
				call: null,
				result: event
			});
			continue;
		}
		const pair = {
			call: event,
			result: null
		};
		pairs.push(pair);
		if (event.toolCallId) openCalls.set(event.toolCallId, pair);
	}
	return pairs.map(toInvocation);
}

//#endregion
export { pairToolEvents };
//# sourceMappingURL=tool-invocations.mjs.map
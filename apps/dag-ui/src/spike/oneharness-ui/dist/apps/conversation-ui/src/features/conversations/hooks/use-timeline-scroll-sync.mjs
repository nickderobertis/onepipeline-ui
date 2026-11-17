"use client";

import { useCallback, useEffect, useRef, useState } from "react";

//#region ../../apps/conversation-ui/src/features/conversations/hooks/use-timeline-scroll-sync.ts
function useTimelineScrollSync(entries) {
	const container = useRef(null);
	const elements = useRef(/* @__PURE__ */ new Map());
	const [cursor, setCursor] = useState();
	const times = useRef(/* @__PURE__ */ new Map());
	times.current = new Map(entries.map((entry) => [entry.id, entry.time]));
	const updateCursor = useCallback(() => {
		const root = container.current;
		if (!root) return;
		const readingLine = root.getBoundingClientRect().top + Math.min(root.clientHeight * .25, 160);
		const registered = entries.map((entry) => ({
			element: elements.current.get(entry.id),
			...entry
		})).filter((entry) => Boolean(entry.element));
		if (registered.length === 0) return;
		const first = registered[0];
		if (!first) return;
		let active = first;
		for (const entry of registered) if (entry.element.getBoundingClientRect().top <= readingLine) active = entry;
		else break;
		setCursor(active.time);
	}, [entries]);
	const containerRef = useCallback((element) => {
		container.current?.removeEventListener("scroll", updateCursor);
		container.current = element;
		element?.addEventListener("scroll", updateCursor, { passive: true });
		updateCursor();
	}, [updateCursor]);
	useEffect(() => {
		updateCursor();
		const root = container.current;
		return () => root?.removeEventListener("scroll", updateCursor);
	}, [updateCursor]);
	return {
		containerRef,
		cursor,
		register: useCallback((id, element) => {
			if (element) elements.current.set(id, element);
			else elements.current.delete(id);
		}, []),
		scrollTo: useCallback((id) => {
			elements.current.get(id)?.scrollIntoView({
				behavior: "smooth",
				block: "start"
			});
			const time = times.current.get(id);
			if (time !== void 0) setCursor(time);
		}, [])
	};
}

//#endregion
export { useTimelineScrollSync };
//# sourceMappingURL=use-timeline-scroll-sync.mjs.map
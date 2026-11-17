"use client";

import { useCallback, useEffect, useRef } from "react";

//#region ../../apps/conversation-ui/src/features/conversations/hooks/use-infinite-scroll.ts
function useInfiniteScroll({ automatic, hasMore, loadedCount, loading, onLoadMore }) {
	const rootRef = useRef(null);
	const sentinelRef = useRef(null);
	const requestInFlight = useRef(false);
	const latest = useRef({
		automatic,
		hasMore,
		loadedCount,
		loading,
		onLoadMore
	});
	latest.current = {
		automatic,
		hasMore,
		loadedCount,
		loading,
		onLoadMore
	};
	const loadMore = useCallback(() => {
		const state = latest.current;
		if (!state.hasMore || state.loading || requestInFlight.current) return;
		requestInFlight.current = true;
		state.onLoadMore().finally(() => {
			requestInFlight.current = false;
		});
	}, []);
	useEffect(() => {
		if (!loading) requestInFlight.current = false;
		const root = rootRef.current;
		const sentinel = sentinelRef.current;
		if (!automatic || !hasMore || loading || !root || !sentinel) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry?.isIntersecting && latest.current.automatic && latest.current.loadedCount === loadedCount) loadMore();
		}, {
			root,
			rootMargin: "0px 0px 180px"
		});
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [
		automatic,
		hasMore,
		loadMore,
		loadedCount,
		loading
	]);
	return {
		loadMore,
		rootRef,
		sentinelRef
	};
}

//#endregion
export { useInfiniteScroll };
//# sourceMappingURL=use-infinite-scroll.mjs.map
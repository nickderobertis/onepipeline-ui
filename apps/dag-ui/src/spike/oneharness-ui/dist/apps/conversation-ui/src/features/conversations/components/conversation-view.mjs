"use client";

import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert.mjs";
import { Button } from "../../../components/ui/button.mjs";
import { useInfiniteScroll } from "../hooks/use-infinite-scroll.mjs";
import { StatusBadge } from "./status-badge.mjs";
import { ConversationTimeline } from "./conversation-timeline-view.mjs";
import { useTimelineScrollSync } from "../hooks/use-timeline-scroll-sync.mjs";
import { ReplyForm } from "./reply-form.mjs";
import { TurnCard } from "./turn-card.mjs";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/conversation-view.tsx
function ConversationTitle({ name }) {
	const title = useRef(null);
	useEffect(() => title.current?.focus(), []);
	return /* @__PURE__ */ jsx("h1", {
		className: "my-1 text-xl font-semibold tracking-[-.025em] focus:outline-none",
		ref: title,
		tabIndex: -1,
		children: name
	});
}
function LiveIndicator() {
	return /* @__PURE__ */ jsxs("p", {
		"aria-label": "Live updates on",
		className: "m-0 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.13em] text-primary",
		role: "status",
		children: [/* @__PURE__ */ jsx("span", {
			"aria-hidden": "true",
			className: "size-1.5 animate-pulse rounded-full bg-primary"
		}), "Live"]
	});
}
function ConversationView({ conversation, continueError, focus, hasMoreTurns, live = false, loadMoreTurnsError, loadingMoreTurns, onContinue, onBack, onLoadMoreTurns, pending, totalTurnCount }) {
	const state = pending ? "running" : conversation.state;
	const infiniteScroll = useInfiniteScroll({
		automatic: loadMoreTurnsError === null,
		hasMore: hasMoreTurns,
		loadedCount: conversation.turns.length,
		loading: loadingMoreTurns,
		onLoadMore: onLoadMoreTurns
	});
	const scrollSync = useTimelineScrollSync(useMemo(() => conversation.turns.flatMap((turn) => {
		const time = Date.parse(turn.startedAt ?? turn.timestamp);
		return Number.isFinite(time) ? [{
			id: turn.id,
			time
		}] : [];
	}), [conversation.turns]));
	const setScrollContainer = useCallback((element) => {
		infiniteScroll.rootRef.current = element;
		scrollSync.containerRef(element);
	}, [infiniteScroll.rootRef, scrollSync.containerRef]);
	return /* @__PURE__ */ jsxs("main", {
		className: "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden max-[680px]:h-[100dvh]",
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "relative z-2 flex min-h-[86px] items-center justify-between gap-3 border-b bg-background/90 px-[clamp(16px,5vw,70px)] py-3.5 backdrop-blur max-[680px]:sticky max-[680px]:top-0",
				children: [
					/* @__PURE__ */ jsx(Button, {
						"aria-label": "Back to conversations",
						className: "hidden shrink-0 max-[680px]:inline-flex",
						onClick: onBack,
						size: "icon",
						type: "button",
						variant: "ghost",
						children: /* @__PURE__ */ jsx(ArrowLeft, {})
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "min-w-0 flex-1",
						children: [
							/* @__PURE__ */ jsx("p", {
								className: "m-0 text-[10px] font-bold uppercase tracking-[.13em] text-primary",
								children: conversation.harnesses.join(" · ")
							}),
							/* @__PURE__ */ jsx(ConversationTitle, { name: conversation.name }, conversation.id),
							/* @__PURE__ */ jsx("p", {
								className: "m-0 max-w-[50vw] truncate font-mono text-[10px] text-subtle max-[680px]:max-w-full",
								title: conversation.project,
								children: conversation.project
							})
						]
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "flex shrink-0 flex-col items-end gap-1.5",
						children: [/* @__PURE__ */ jsx(StatusBadge, { state }), live ? /* @__PURE__ */ jsx(LiveIndicator, {}) : null]
					})
				]
			}),
			/* @__PURE__ */ jsxs("section", {
				"aria-busy": loadingMoreTurns,
				"aria-label": "Conversation turns",
				className: "min-h-0 overflow-y-auto px-[clamp(16px,7vw,94px)] pb-14 pt-9",
				ref: setScrollContainer,
				children: [
					/* @__PURE__ */ jsx("div", {
						className: "sticky top-0 z-1 mx-auto mb-8 max-w-[850px] bg-background/95 py-2 backdrop-blur",
						children: /* @__PURE__ */ jsx(ConversationTimeline, {
							...scrollSync.cursor === void 0 ? {} : { cursor: scrollSync.cursor },
							...focus ? { focus } : {},
							onSelectTurn: scrollSync.scrollTo,
							turns: conversation.turns
						})
					}),
					/* @__PURE__ */ jsx("p", {
						"aria-label": `${conversation.turns.length} of ${totalTurnCount} turns loaded`,
						className: "mx-auto mb-5 max-w-[850px] text-right text-[10px] text-subtle",
						role: "status",
						children: conversation.turns.length < totalTurnCount ? `${conversation.turns.length} of ${totalTurnCount}` : conversation.turns.length
					}),
					conversation.turns.map((turn) => /* @__PURE__ */ jsx("div", {
						ref: (element) => scrollSync.register(turn.id, element),
						children: /* @__PURE__ */ jsx(TurnCard, {
							...focus?.turnId === turn.id ? { focus } : {},
							turn
						})
					}, turn.id)),
					/* @__PURE__ */ jsxs("div", {
						className: "mx-auto max-w-[850px] text-center",
						children: [
							hasMoreTurns ? /* @__PURE__ */ jsx(Button, {
								className: "mt-3.5",
								disabled: loadingMoreTurns,
								onClick: infiniteScroll.loadMore,
								type: "button",
								variant: "secondary",
								children: loadingMoreTurns ? "Loading more turns…" : loadMoreTurnsError ? "Retry loading turns" : "Load more turns"
							}) : /* @__PURE__ */ jsxs("p", {
								"aria-label": `All ${totalTurnCount} turns loaded`,
								className: "mt-3.5 text-center text-[11px] text-subtle",
								role: "status",
								children: [
									"All ",
									totalTurnCount,
									" turns loaded"
								]
							}),
							loadMoreTurnsError ? /* @__PURE__ */ jsxs("p", {
								className: "mx-auto mt-3.5 max-w-md text-center text-[11px] text-destructive",
								role: "alert",
								children: ["Couldn’t load more turns. ", loadMoreTurnsError.message]
							}) : null,
							/* @__PURE__ */ jsx("div", {
								"aria-hidden": "true",
								className: "pagination__sentinel",
								ref: infiniteScroll.sentinelRef
							})
						]
					})
				]
			}),
			/* @__PURE__ */ jsx("footer", {
				className: "bg-gradient-to-b from-transparent via-background to-background px-[clamp(16px,7vw,94px)] pb-[max(1rem,env(safe-area-inset-bottom))] pt-6",
				children: conversation.canContinue ? /* @__PURE__ */ jsx(ReplyForm, {
					error: continueError,
					onSubmit: onContinue,
					pending
				}) : /* @__PURE__ */ jsxs(Alert, {
					className: "mx-auto max-w-[850px] bg-card",
					role: "note",
					children: [/* @__PURE__ */ jsx(AlertTitle, { children: "This session can’t be continued." }), /* @__PURE__ */ jsx(AlertDescription, { children: "The harness did not save an eligible native session handle." })]
				})
			})
		]
	});
}

//#endregion
export { ConversationView };
//# sourceMappingURL=conversation-view.mjs.map
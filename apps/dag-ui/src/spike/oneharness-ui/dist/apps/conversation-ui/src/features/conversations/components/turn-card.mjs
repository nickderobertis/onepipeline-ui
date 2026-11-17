"use client";

import { cn } from "../../../components/utils.mjs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../../components/ui/accordion.mjs";
import { Badge } from "../../../components/ui/badge.mjs";
import { pairToolEvents } from "../tool-invocations.mjs";
import { JsonCode, compactJsonText, parseJsonText } from "./json-code.mjs";
import { Message, MessageAvatar, MessageContent } from "./message.mjs";
import { MessageResponse } from "./message-response.mjs";
import { Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/turn-card.tsx
const previewMaxLength = 200;
const payloadClassName = "mt-0 max-h-72 whitespace-pre-wrap rounded-none border-0 text-[11px]";
const statusTones = {
	completed: "text-success",
	failed: "text-destructive",
	interrupted: "text-warning",
	timeout: "text-warning"
};
function StructuredDetail({ label, value }) {
	return /* @__PURE__ */ jsx(JsonCode, {
		className: "mt-0 max-h-90 whitespace-pre-wrap rounded-none border-0 text-[11px]",
		label,
		value
	});
}
function formatDuration(durationMs) {
	if (durationMs === null || !Number.isFinite(durationMs)) return null;
	if (durationMs < 1e3) return `${Math.round(durationMs)} ms`;
	if (durationMs < 6e4) return `${(durationMs / 1e3).toFixed(1)} s`;
	return `${(durationMs / 6e4).toFixed(1)} min`;
}
function previewSource(invocation) {
	if (invocation.input === void 0 || invocation.input === null) return invocation.output ?? "";
	return typeof invocation.input === "string" ? invocation.input : compactJsonText(invocation.input);
}
function previewOf(invocation) {
	return previewSource(invocation).split("\n", 1)[0]?.trim().slice(0, previewMaxLength) ?? "";
}
function ToolStatus({ status }) {
	if (!status) return null;
	return /* @__PURE__ */ jsxs("span", {
		className: cn("flex shrink-0 items-center gap-1 text-[9px] uppercase tracking-[.08em]", statusTones[status] ?? "text-subtle"),
		children: [/* @__PURE__ */ jsx("span", {
			"aria-hidden": "true",
			className: "size-1.5 rounded-full bg-current"
		}), status]
	});
}
function ToolTiming({ invocation }) {
	const present = [
		["Call ID", invocation.toolCallId],
		["Started", invocation.startedAt],
		["Finished", invocation.finishedAt],
		["Timing", invocation.timingSource]
	].filter(([, value]) => value !== null);
	if (present.length === 0) return null;
	return /* @__PURE__ */ jsx("dl", {
		"aria-label": `${invocation.name} tool timing`,
		className: "flex flex-wrap gap-2 px-3.5 py-2",
		children: present.map(([label, value]) => /* @__PURE__ */ jsxs("div", {
			className: "flex gap-1.5",
			children: [/* @__PURE__ */ jsx("dt", {
				className: "text-[9px] uppercase text-subtle",
				children: label
			}), /* @__PURE__ */ jsx("dd", {
				className: "m-0 font-mono text-[10px] text-muted-foreground",
				children: value
			})]
		}, label))
	});
}
function ToolSection({ children, title }) {
	return /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h4", {
		className: "m-0 px-3.5 pt-2 text-[9px] font-bold uppercase tracking-[.08em] text-subtle",
		children: title
	}), children] });
}
function ToolInvocationBlock({ invocation, current }) {
	const duration = formatDuration(invocation.durationMs);
	const preview = previewOf(invocation);
	const hasInput = invocation.input !== void 0 && invocation.input !== null;
	const outputJson = invocation.output === null ? void 0 : parseJsonText(invocation.output);
	return /* @__PURE__ */ jsxs(AccordionItem, {
		"aria-current": current ? "true" : void 0,
		"data-tool-call-id": invocation.toolCallId ?? void 0,
		"data-event-index": invocation.id.slice(5),
		className: "rounded-[10px] border bg-card px-3",
		value: invocation.id,
		children: [/* @__PURE__ */ jsxs(AccordionTrigger, {
			"aria-label": `${invocation.name} tool details`,
			className: "items-center gap-2 py-1.5 text-xs text-muted-foreground",
			children: [
				/* @__PURE__ */ jsx(Terminal, {
					"aria-hidden": "true",
					className: "size-3.5 shrink-0 text-primary"
				}),
				/* @__PURE__ */ jsx("span", {
					className: "shrink-0 font-medium text-foreground",
					children: invocation.name
				}),
				/* @__PURE__ */ jsx("span", {
					className: "min-w-0 flex-1 truncate font-mono text-[10px] font-normal text-subtle",
					children: preview
				}),
				duration ? /* @__PURE__ */ jsx("span", {
					className: "shrink-0 text-[10px] tabular-nums text-subtle",
					children: duration
				}) : null,
				/* @__PURE__ */ jsx(ToolStatus, { status: invocation.status })
			]
		}), /* @__PURE__ */ jsxs(AccordionContent, {
			className: "-mx-3 border-t p-0",
			children: [
				/* @__PURE__ */ jsx(ToolTiming, { invocation }),
				hasInput ? /* @__PURE__ */ jsx(ToolSection, {
					title: "Input",
					children: /* @__PURE__ */ jsx(JsonCode, {
						className: payloadClassName,
						label: `${invocation.name} tool input`,
						value: invocation.input
					})
				}) : null,
				invocation.output !== null ? /* @__PURE__ */ jsx(ToolSection, {
					title: "Output",
					children: outputJson === void 0 ? /* @__PURE__ */ jsx("pre", {
						"aria-label": `${invocation.name} tool output`,
						className: cn("message-json", payloadClassName),
						children: invocation.output
					}) : /* @__PURE__ */ jsx(JsonCode, {
						className: payloadClassName,
						label: `${invocation.name} tool output`,
						value: outputJson
					})
				}) : null,
				!hasInput && invocation.output === null ? /* @__PURE__ */ jsxs("p", {
					className: "m-0 px-3.5 py-2 text-[11px] italic text-muted-foreground",
					children: [
						"This ",
						invocation.kind,
						" event carried no input or output."
					]
				}) : null
			]
		})]
	});
}
function Usage({ usage }) {
	const present = [
		[
			"Input",
			"inputTokens",
			usage.inputTokens
		],
		[
			"Output",
			"outputTokens",
			usage.outputTokens
		],
		[
			"Cache read",
			"cacheReadTokens",
			usage.cacheReadTokens
		],
		[
			"Cache write",
			"cacheWriteTokens",
			usage.cacheWriteTokens
		],
		[
			"Cost",
			"costUsd",
			usage.costUsd
		]
	].filter(([, key]) => Object.hasOwn(usage, key));
	if (present.length === 0) return null;
	return /* @__PURE__ */ jsx("dl", {
		"aria-label": "Usage",
		className: "mt-4.5 flex flex-wrap gap-2",
		children: present.map(([label, key, value]) => /* @__PURE__ */ jsxs("div", {
			className: "flex gap-1.5 rounded-md bg-muted px-2 py-1",
			children: [/* @__PURE__ */ jsx("dt", {
				className: "text-[9px] uppercase text-subtle",
				children: label
			}), /* @__PURE__ */ jsx("dd", {
				className: "m-0 text-[10px] text-muted-foreground",
				children: value === null ? "Not reported" : key === "costUsd" && typeof value === "number" ? `$${value.toFixed(4)}` : value ?? "Not reported"
			})]
		}, key))
	});
}
/** The agent's own messages and reasoning, in recorded order, kept apart from its tool calls. */
function AgentActivity({ events }) {
	return /* @__PURE__ */ jsx("section", {
		"aria-label": "Agent activity",
		className: "my-3 space-y-2",
		children: [...events].sort((left, right) => left.index - right.index).map((event) => event.kind === "reasoning" ? /* @__PURE__ */ jsx(Accordion, {
			collapsible: true,
			type: "single",
			children: /* @__PURE__ */ jsxs(AccordionItem, {
				className: "rounded-[10px] border border-dashed bg-card px-3",
				value: `reasoning-${event.index}`,
				children: [/* @__PURE__ */ jsx(AccordionTrigger, {
					className: "py-1.5 text-xs text-muted-foreground",
					children: "Reasoning"
				}), /* @__PURE__ */ jsx(AccordionContent, {
					className: "whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground",
					children: event.text
				})]
			})
		}, `reasoning-${event.index}`) : /* @__PURE__ */ jsx("div", {
			"aria-label": "Agent message",
			className: "border-l-2 border-primary pl-3",
			role: "group",
			children: /* @__PURE__ */ jsx(MessageResponse, {
				label: "Agent message",
				children: event.text
			})
		}, `message-${event.index}`))
	});
}
function spikeStream(turn, invocations) {
	if (turn.agentEvents?.length) return [...turn.agentEvents].sort((l, r) => l.index - r.index);
	const tools = invocations.map((invocation, at) => ({
		kind: "tool",
		index: invocation.eventIndices?.[0] ?? 2 * at + 1,
		invocation
	}));
	const used = new Set(tools.map(({ index }) => index));
	const reasoning = (turn.reasoning ?? "").split(/\n+/u).filter(Boolean);
	const words = (turn.assistant ?? "").split(/\n+/u).filter(Boolean);
	const out = [...tools];
	let index = 0;
	let reason = true;
	while (reasoning.length || words.length) {
		const kind = reason && reasoning.length || !words.length ? "reasoning" : "message";
		const text = kind === "reasoning" ? reasoning.shift() : words.shift();
		reason = !reason;
		while (used.has(index)) index += 1;
		used.add(index);
		out.push({ kind, index, text });
	}
	return out.sort((l, r) => l.index - r.index);
}
function TurnCard({ author, focus, turn }) {
	const root = useRef(null);
	const [collapsed, setCollapsed] = useState(false);
	const [openTools, setOpenTools] = useState([]);
	const focused = focus?.turnId === turn.id;
	const target = focused ? pairToolEvents(turn.tools).find((invocation) => focus.toolCallId !== void 0 ? invocation.toolCallId === focus.toolCallId : focus.eventIndex !== void 0 && invocation.eventIndices.includes(focus.eventIndex)) : void 0;
	const targetId = target?.id;
	const focusKey = focused ? JSON.stringify(focus) : void 0;
	useEffect(() => {
		if (!focusKey) return;
		setCollapsed(false);
		if (targetId) setOpenTools((values) => values.includes(targetId) ? values : [...values, targetId]);
	}, [focusKey, targetId]);
	useEffect(() => {
		if (!focusKey || collapsed || targetId && !openTools.includes(targetId)) return;
		root.current?.scrollIntoView?.({ block: "nearest" });
		root.current?.querySelector("[aria-current=\"true\"]")?.scrollIntoView?.({ block: "nearest" });
	}, [
		focusKey,
		collapsed,
		openTools,
		targetId
	]);
	const hasUnknown = Object.keys(turn.unknown).length > 0;
	const invocations = pairToolEvents(turn.tools);
	const inFlight = turn.status === "running";
	return /* @__PURE__ */ jsxs("article", {
		ref: root,
		"data-turn-id": turn.id,
		"aria-current": focused && !target ? "true" : void 0,
		"aria-label": `Turn ${turn.id} from ${turn.harness}`,
		className: "mx-auto mb-10.5 max-w-[850px]",
		children: [/* @__PURE__ */ jsxs("button", {
			className: "mb-2 text-[10px] text-muted-foreground hover:text-foreground",
			type: "button",
			"aria-expanded": !collapsed,
			onClick: () => setCollapsed(!collapsed),
			children: [
				collapsed ? "Expand" : "Collapse",
				" turn ",
				turn.id
			]
		}), /* @__PURE__ */ jsxs("div", {
			hidden: collapsed,
			children: [/* @__PURE__ */ jsx(Message, {
				from: "user",
				children: /* @__PURE__ */ jsxs(MessageContent, {
					className: "mb-8 ml-auto max-w-[min(680px,88%)] rounded-[22px_22px_5px_22px] border bg-popover px-5 py-4.5",
					children: [/* @__PURE__ */ jsx("div", {
						className: "text-[10px] font-bold uppercase tracking-[.08em] text-subtle",
						children: "You"
					}), inFlight && !turn.user ? /* @__PURE__ */ jsx("p", {
						className: "text-[13px] italic text-muted-foreground",
						children: "The prompt is recorded when this run finishes."
					}) : /* @__PURE__ */ jsx(MessageResponse, {
						label: "User message",
						children: turn.user
					})]
				})
			}), /* @__PURE__ */ jsxs(Message, {
				from: "assistant",
				children: [/* @__PURE__ */ jsx(MessageAvatar, {
					...author?.avatar ? { src: author.avatar } : {},
					children: author ? author.label.slice(0, 2).toUpperCase() : "OH"
				}), /* @__PURE__ */ jsxs(MessageContent, {
					className: "pt-1",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.08em] text-subtle",
							children: [/* @__PURE__ */ jsx("span", { children: author?.label ?? turn.harness }), turn.model ? /* @__PURE__ */ jsx(Badge, {
								variant: "secondary",
								className: "font-medium normal-case tracking-normal",
								children: turn.model
							}) : null]
						}),
						// SPIKE (spike-visual): one stream — reasoning, words and tool calls in
						// the order they happened. Today's read API folds narration into one
						// reasoning and one assistant string, so the mock re-spreads them
						// between the tool calls' indices.
						/* @__PURE__ */ jsx("section", {
							"aria-label": "Turn, in order",
							className: "my-3 space-y-2",
							children: spikeStream(turn, invocations).map((entry) => entry.kind === "tool" ? /* @__PURE__ */ jsx(Accordion, {
								type: "multiple",
								value: openTools,
								onValueChange: setOpenTools,
								children: /* @__PURE__ */ jsx(ToolInvocationBlock, {
									current: target?.id === entry.invocation.id,
									invocation: entry.invocation
								})
							}, `tool-${entry.index}`) : entry.kind === "reasoning" ? /* @__PURE__ */ jsxs("div", {
								className: "rounded-[10px] border border-dashed bg-card px-3 py-2",
								children: [/* @__PURE__ */ jsx("div", {
									className: "text-[10px] font-bold uppercase tracking-[.08em] text-subtle",
									children: "Reasoning"
								}), /* @__PURE__ */ jsx("div", {
									className: "whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground",
									children: entry.text
								})]
							}, `reasoning-${entry.index}`) : /* @__PURE__ */ jsx(MessageResponse, {
								label: "Agent message",
								children: entry.text
							}, `message-${entry.index}`))
						}),
						turn.failureKind ? /* @__PURE__ */ jsxs("p", {
							"aria-label": `Failure: ${turn.failureKind}`,
							className: "border-l-2 border-destructive pl-2.5 text-xs text-destructive",
							role: "note",
							children: ["Failure: ", turn.failureKind]
						}) : null,
						/* @__PURE__ */ jsx(Usage, { usage: turn.usage }),
						hasUnknown ? /* @__PURE__ */ jsx(Accordion, {
							className: "mt-2.5",
							collapsible: true,
							type: "single",
							children: /* @__PURE__ */ jsxs(AccordionItem, {
								className: "rounded-[10px] border bg-card px-3",
								value: "unknown",
								children: [/* @__PURE__ */ jsx(AccordionTrigger, {
									className: "text-xs text-muted-foreground",
									children: "Additional upstream data"
								}), /* @__PURE__ */ jsx(AccordionContent, {
									className: "-mx-3 border-t p-0",
									children: /* @__PURE__ */ jsx(StructuredDetail, {
										label: "Additional upstream data detail",
										value: turn.unknown
									})
								})]
							})
						}) : null
					]
				})]
			})]
		})]
	});
}

//#endregion
export { TurnCard };
//# sourceMappingURL=turn-card.mjs.map
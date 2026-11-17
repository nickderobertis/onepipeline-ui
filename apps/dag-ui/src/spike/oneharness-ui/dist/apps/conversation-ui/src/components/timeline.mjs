"use client";

import { cn } from "./utils.mjs";
import { ChevronDown, ChevronUp, Circle, MapPin, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/components/timeline.tsx
const laneColors = [
	"bg-spectrum-blue",
	"bg-spectrum-green",
	"bg-spectrum-orange",
	"bg-spectrum-violet",
	"bg-spectrum-red",
	"bg-spectrum-indigo",
	"bg-spectrum-yellow"
];
const implicitLaneId = "__timeline_implicit_lane__";
/** Stable FNV-1a hashing makes color independent of render and item order. */
function timelineLaneColor(laneId) {
	let hash = 2166136261;
	for (const character of laneId) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return laneColors[(hash >>> 0) % laneColors.length] ?? laneColors[0];
}
function itemLane(item) {
	return item.laneId ?? implicitLaneId;
}
function itemEnd(item) {
	if (typeof item.end === "number" && Number.isFinite(item.end)) return item.end;
	if (typeof item.duration === "number" && Number.isFinite(item.duration)) return item.start + item.duration;
	return item.start;
}
function formatDuration(value) {
	if (value < 1e3) return `${Math.round(value)} ms`;
	if (value < 6e4) return `${(value / 1e3).toFixed(1)} s`;
	return `${(value / 6e4).toFixed(1)} min`;
}
function formatElapsed(value) {
	return `+${formatDuration(value)}`;
}
function formatTime(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}
// SPIKE: the readable axis — whole minutes drop the seconds, the offset sits on
// its own line under the clock on every tick, and carries no needless decimals.
function cleanNumber(value) {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}
function formatOffset(value) {
	if (value < 1e3) return `${Math.round(value)} ms`;
	if (value < 6e4) return `${cleanNumber(value / 1e3)} s`;
	if (value < 36e5) return `${cleanNumber(value / 6e4)} min`;
	return `${cleanNumber(value / 36e5)} h`;
}
function formatTick(value, origin) {
	const date = new Date(value);
	if (Number.isNaN(date.valueOf())) return String(value);
	const whole = date.getSeconds() === 0 && date.getMilliseconds() === 0;
	const clock = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		...(whole ? {} : { second: "2-digit" }),
		hour12: false
	});
	return `${clock}\n+${formatOffset(value - origin)}`;
}
function detailText(item, failure) {
	const end = itemEnd(item);
	const parts = [
		item.label,
		`Lane: ${itemLane(item)}`,
		`Status: ${item.status ?? "unknown"}`,
		`Start: ${formatTime(item.start)}`
	];
	if (end > item.start) parts.push(`End: ${formatTime(end)}`, `Duration: ${formatDuration(end - item.start)}`);
	else parts.push("Duration: not recorded");
	if (item.status === "failed" && failure?.trim()) parts.push(`Failure: ${failure.trim().slice(0, 160)}`);
	return parts.join(" · ");
}
function useTimelineView(fullRange, controlledRange, onRangeChange) {
	const [view, setView] = useState(null);
	const [brushOrigin, setBrushOrigin] = useState(null);
	const axis = useRef(null);
	const range = (controlledRange && controlledRange[1] > controlledRange[0] ? {
		end: controlledRange[1],
		start: controlledRange[0]
	} : null) ?? view ?? fullRange;
	const rangeDuration = Math.max(1, range.end - range.start);
	const change = (next) => {
		onRangeChange?.([next.start, next.end]);
		if (!controlledRange) setView(next);
	};
	const coordinate = (clientX) => {
		const bounds = axis.current?.getBoundingClientRect();
		const width = bounds?.width || 1e3;
		return range.start + Math.min(1, Math.max(0, (clientX - (bounds?.left ?? 0)) / width)) * rangeDuration;
	};
	return {
		axis,
		brushStart: (clientX) => setBrushOrigin(coordinate(clientX)),
		finishBrush: (clientX) => {
			if (brushOrigin === null) return;
			const end = coordinate(clientX);
			if (Math.abs(end - brushOrigin) >= rangeDuration * .02) change({
				end: Math.max(end, brushOrigin),
				start: Math.min(end, brushOrigin)
			});
			setBrushOrigin(null);
		},
		range,
		reset: () => {
			onRangeChange?.([fullRange.start, fullRange.end]);
			if (!controlledRange) setView(null);
		},
		viewChanged: range.start !== fullRange.start || range.end !== fullRange.end,
		zoom: (clientX, deltaY) => {
			const anchor = coordinate(clientX);
			const factor = deltaY < 0 ? .75 : 1.25;
			const fullDuration = Math.max(1, fullRange.end - fullRange.start);
			const nextDuration = Math.min(fullDuration, Math.max(fullDuration / 100, rangeDuration * factor));
			let start = anchor - nextDuration * ((anchor - range.start) / rangeDuration);
			start = Math.max(fullRange.start, Math.min(start, fullRange.end - nextDuration));
			change({
				end: start + nextDuration,
				start
			});
		}
	};
}
function Timeline({ axis: axisOptions, cursor, crosshair = true, ticks, expanded = false, getFailureExcerpt, items, label = "Timeline", lanes, markers = [], onExpandedChange, onRangeChange, onSelect, range: controlledRange, selectedId }) {
	const instanceId = useId();
	const [plotWidth, setPlotWidth] = useState(1e3);
	const [hoverRatio, setHoverRatio] = useState(null);
	const [active, setActive] = useState(null);
	const validItems = useMemo(() => items.filter((item) => Number.isFinite(item.start)), [items]);
	const validMarkers = useMemo(() => markers.filter((marker) => Number.isFinite(marker.at)), [markers]);
	const renderedLanes = useMemo(() => {
		if (lanes) return [...lanes];
		return [...new Set(validItems.map(itemLane))].map((id) => ({
			id,
			label: id === implicitLaneId ? "Events" : id
		}));
	}, [lanes, validItems]);
	const fullRange = useMemo(() => {
		const times = [...validItems.flatMap((item) => [item.start, itemEnd(item)]), ...validMarkers.map((marker) => marker.at)];
		if (times.length === 0) return {
			end: 1,
			start: 0
		};
		const start = Math.min(...times);
		const rawEnd = Math.max(...times);
		return {
			end: rawEnd > start ? rawEnd : start + 1,
			start
		};
	}, [validItems, validMarkers]);
	const timelineView = useTimelineView(fullRange, controlledRange, onRangeChange);
	const { axis, range } = timelineView;
	const hasEvents = validItems.length > 0 || validMarkers.length > 0;
	useEffect(() => {
		if (!hasEvents) return;
		const element = axis.current;
		if (!element) return;
		const measure = () => setPlotWidth(element.getBoundingClientRect().width || 1e3);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [axis, hasEvents]);
	useEffect(() => {
		if (selectedId) axis.current?.querySelector("[data-selected=\"true\"]")?.scrollIntoView?.({ block: "nearest" });
	}, [axis, selectedId]);
	const rangeDuration = Math.max(1, range.end - range.start);
	const position = (value) => (value - range.start) / rangeDuration * 100;
	const rows = expanded ? renderedLanes : [{
		id: "overlay",
		label: "All events"
	}];
	const origin = axisOptions?.origin ?? fullRange.start;
	const spacing = ticks?.minSpacingPx;
	const minimumInterval = rangeDuration * (spacing !== void 0 && Number.isFinite(spacing) && spacing > 0 ? spacing : 80) / plotWidth;
	const interval = [
		1e3,
		2e3,
		5e3,
		1e4,
		15e3,
		3e4,
		6e4,
		12e4,
		3e5,
		6e5,
		9e5,
		18e5,
		36e5
	].find((value) => value >= minimumInterval) ?? Math.ceil(minimumInterval / 36e5) * 36e5;
	const tickValues = [];
	for (let value = Math.ceil(range.start / interval) * interval; value <= range.end; value += interval) tickValues.push(value);
	const hoverTime = hoverRatio === null ? null : range.start + hoverRatio * rangeDuration;
	const renderItem = (item) => {
		const end = itemEnd(item);
		if (end < range.start || item.start > range.end) return null;
		const left = Math.max(0, position(Math.max(item.start, range.start)));
		const width = Math.max(.8, position(Math.min(end, range.end)) - left);
		const point = end <= item.start;
		const tooltipId = `timeline-detail-${instanceId}-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
		const color = timelineLaneColor(itemLane(item));
		return /* @__PURE__ */ jsxs("div", {
			className: "absolute inset-y-0",
			style: { left: `${left}%` },
			children: [/* @__PURE__ */ jsx("button", {
				"aria-describedby": tooltipId,
				"aria-label": `${item.label}, ${point ? "point event" : "span"}`,
				"aria-pressed": selectedId === item.id,
				"aria-current": selectedId === item.id ? "true" : void 0,
				"data-turn-id": item.turnId,
				"data-tool-call-id": item.toolCallId,
				"data-event-index": item.eventIndex,
				className: cn("absolute top-0 h-5 border-2 border-card shadow-sm hover:opacity-80 focus-visible:z-20", point ? "w-5 -translate-x-1/2 rounded-full" : "min-w-1 rounded-md", selectedId === item.id && "ring-2 ring-foreground ring-offset-1", color),
				"data-lane-color": color,
				"data-selected": selectedId === item.id ? "true" : "false",
				"data-timeline-shape": point ? "point" : "span",
				onBlur: () => setActive(null),
				onClick: (event) => {
					event.stopPropagation();
					setActive(item.id);
					onSelect?.(item);
				},
				onFocus: () => setActive(item.id),
				onMouseEnter: () => setActive(item.id),
				onMouseLeave: () => setActive(null),
				style: { width: point ? void 0 : `${width}cqw` },
				type: "button",
				children: point ? /* @__PURE__ */ jsx(Circle, {
					"aria-hidden": "true",
					className: "m-auto size-2 fill-current text-white"
				}) : null
			}), /* @__PURE__ */ jsx("span", {
				className: cn("pointer-events-none absolute z-30 w-80 rounded-md bg-popover px-2.5 py-2 text-[10px] text-popover-foreground shadow-lg", active === item.id ? "block" : "sr-only"),
				id: tooltipId,
				role: active === item.id ? "tooltip" : void 0,
				style: { top: "1.4rem" },
				children: detailText(item, getFailureExcerpt?.(item))
			})]
		}, item.id);
	};
	return /* @__PURE__ */ jsxs("section", {
		"aria-label": label,
		className: "timeline rounded-xl border bg-card p-4",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "mb-3 flex flex-wrap items-center justify-between gap-3",
			children: [/* @__PURE__ */ jsx("div", {
				"aria-label": "Timeline legend",
				className: "flex flex-wrap gap-3",
				role: "list",
				children: renderedLanes.map((lane) => /* @__PURE__ */ jsxs("span", {
					className: "flex items-center gap-1.5 text-[10px] text-muted-foreground",
					role: "listitem",
					children: [/* @__PURE__ */ jsx("span", {
						"aria-hidden": "true",
						className: cn("size-2 rounded-full", timelineLaneColor(lane.id))
					}), lane.label]
				}, lane.id))
			}), /* @__PURE__ */ jsxs("div", {
				className: "flex gap-1",
				children: [/* @__PURE__ */ jsxs("button", {
					"aria-label": expanded ? "Collapse timeline" : "Expand timeline",
					className: "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted",
					onClick: () => onExpandedChange?.(!expanded),
					type: "button",
					children: [expanded ? /* @__PURE__ */ jsx(ChevronUp, {
						"aria-hidden": "true",
						className: "size-3"
					}) : /* @__PURE__ */ jsx(ChevronDown, {
						"aria-hidden": "true",
						className: "size-3"
					}), expanded ? "Collapse" : "Expand"]
				}), /* @__PURE__ */ jsxs("button", {
					"aria-label": "Reset timeline zoom",
					className: "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted disabled:opacity-40",
					disabled: !timelineView.viewChanged,
					onClick: timelineView.reset,
					type: "button",
					children: [/* @__PURE__ */ jsx(RotateCcw, {
						"aria-hidden": "true",
						className: "size-3"
					}), " Reset zoom"]
				})]
			})]
		}), validItems.length === 0 && validMarkers.length === 0 ? /* @__PURE__ */ jsx("p", {
			className: "m-0 text-xs text-muted-foreground",
			children: "No timeline events recorded."
		}) : /* @__PURE__ */ jsxs("div", {
			"aria-label": "Timeline plot. Scroll to zoom or drag to select a range.",
			className: "relative touch-none select-none overflow-hidden rounded-lg border bg-muted/40 pb-3 pt-7",
			onPointerMove: (event) => {
				const bounds = event.currentTarget.getBoundingClientRect();
				setHoverRatio(Math.min(1, Math.max(0, (event.clientX - bounds.left) / (bounds.width || 1e3))));
			},
			onPointerLeave: () => setHoverRatio(null),
			onPointerDown: (event) => timelineView.brushStart(event.clientX),
			onPointerUp: (event) => timelineView.finishBrush(event.clientX),
			onWheel: (event) => {
				event.preventDefault();
				timelineView.zoom(event.clientX, event.deltaY);
			},
			ref: axis,
			children: [
				crosshair && hoverTime !== null ? /* @__PURE__ */ jsx("div", {
					"aria-label": "Timeline crosshair",
					className: "pointer-events-none absolute inset-y-0 z-30 border-l border-foreground",
					style: { left: `${(hoverRatio ?? 0) * 100}%` },
					children: /* @__PURE__ */ jsxs("span", {
						className: "absolute top-0 whitespace-nowrap bg-popover text-[10px] text-popover-foreground",
						style: { transform: (hoverRatio ?? 0) > .5 ? "translateX(-100%)" : void 0 },
						children: [
							formatTime(hoverTime),
							" ",
							formatElapsed(hoverTime - origin)
						]
					})
				}) : null,
				/* @__PURE__ */ jsxs("div", {
					className: "relative grid gap-2",
					style: { containerType: "inline-size" },
					children: [
						rows.map((lane) => /* @__PURE__ */ jsxs("div", {
							className: "relative h-6 border-b border-border/60",
							"data-lane-id": lane.id,
							"data-testid": "timeline-lane",
							children: [expanded ? /* @__PURE__ */ jsx("span", {
								className: "sr-only",
								children: lane.label
							}) : null, (expanded ? validItems.filter((item) => itemLane(item) === lane.id) : validItems).map(renderItem)]
						}, lane.id)),
						validMarkers.map((marker) => {
							if (marker.at < range.start || marker.at > range.end) return null;
							return /* @__PURE__ */ jsxs("div", {
								className: "pointer-events-none absolute inset-y-0 z-20",
								style: { left: `${position(marker.at)}%` },
								children: [/* @__PURE__ */ jsx("span", {
									className: "absolute inset-y-0 w-px bg-foreground/60",
									"data-testid": "timeline-marker-line"
								}), /* @__PURE__ */ jsx("button", {
									"aria-label": `${marker.label}, marker`,
									"aria-pressed": selectedId === marker.id,
									className: cn("pointer-events-auto absolute bottom-full left-1/2 mb-1 flex size-5 -translate-x-1/2 items-center justify-center rounded-full bg-card text-foreground shadow", selectedId === marker.id && "ring-2 ring-foreground"),
									"data-selected": selectedId === marker.id ? "true" : "false",
									onClick: (event) => {
										event.stopPropagation();
										onSelect?.(marker);
									},
									type: "button",
									children: marker.icon ?? /* @__PURE__ */ jsx(MapPin, {
										"aria-hidden": "true",
										className: "size-3"
									})
								})]
							}, marker.id);
						}),
						typeof cursor === "number" && Number.isFinite(cursor) && cursor >= range.start && cursor <= range.end ? /* @__PURE__ */ jsx("span", {
							"aria-label": "Timeline cursor",
							className: "pointer-events-none absolute inset-y-0 z-10 w-px bg-primary",
							"data-testid": "timeline-cursor",
							style: { left: `${position(cursor)}%` }
						}) : null
					]
				}),
				/* @__PURE__ */ jsx("div", {
					className: "relative mt-2 h-7 font-mono text-[10px] leading-[13px] text-subtle",
					"data-testid": "timeline-axis",
					"data-timeline-axis": true,
					children: tickValues.map((value) => /* @__PURE__ */ jsx("span", {
						"data-tick-time": value,
						className: "absolute text-center",
						style: {
							left: `${position(value)}%`,
							whiteSpace: "pre",
							transform: value === range.end ? "translateX(-100%)" : value === range.start ? void 0 : "translateX(-50%)"
						},
						children: formatTick(value, origin)
					}, value))
				})
			]
		})]
	});
}

//#endregion
export { Timeline, timelineLaneColor };
//# sourceMappingURL=timeline.mjs.map
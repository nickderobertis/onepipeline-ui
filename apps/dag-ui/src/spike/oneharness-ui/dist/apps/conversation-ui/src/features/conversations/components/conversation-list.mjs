import { Badge } from "../../../components/ui/badge.mjs";
import { Button } from "../../../components/ui/button.mjs";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.mjs";
import { Input } from "../../../components/ui/input.mjs";
import { Label } from "../../../components/ui/label.mjs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select.mjs";
import { Separator } from "../../../components/ui/separator.mjs";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.mjs";
import { conversationGroupingOptions, useConversationOrganization } from "../hooks/use-conversation-organization.mjs";
import { useInfiniteScroll } from "../hooks/use-infinite-scroll.mjs";
import { useLabelEditor } from "../hooks/use-label-editor.mjs";
import { StatusBadge } from "./status-badge.mjs";
import { Pencil, RefreshCw } from "lucide-react";
import { jsx, jsxs } from "react/jsx-runtime";

//#region ../../apps/conversation-ui/src/features/conversations/components/conversation-list.tsx
function ConversationList({ actions, brand, conversations, hasMore, loadMoreError, labelError, labeling, loadingMore, onLoadMore, onRefresh, onSetLabels, onSelect, refreshing, selectedId, totalCount }) {
	const { choices, filter, grouped, grouping, setFilter, setGrouping } = useConversationOrganization(conversations);
	const { closeEditor, editingId, labelInput, openEditor, saveLabels, setLabelInput, validationError } = useLabelEditor(onSetLabels);
	const infiniteScroll = useInfiniteScroll({
		automatic: loadMoreError === null,
		hasMore,
		loadedCount: conversations.length,
		loading: loadingMore,
		onLoadMore
	});
	return /* @__PURE__ */ jsxs("aside", {
		className: "flex min-h-0 min-w-0 flex-col border-r bg-sidebar max-[680px]:h-[100dvh] max-[680px]:border-r-0",
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "brand-header flex min-h-[86px] items-center justify-between border-b px-4.5 py-4",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-0.5",
					children: [brand ?? /* @__PURE__ */ jsx("strong", {
						className: "text-[15px]",
						children: "oneharness"
					}), /* @__PURE__ */ jsx("span", {
						className: "pl-10.5 text-[10px] uppercase tracking-[.08em] text-subtle",
						children: "Local sessions"
					})]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex items-center",
					children: [actions, /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
						asChild: true,
						children: /* @__PURE__ */ jsx(Button, {
							"aria-label": "Refresh conversations",
							disabled: refreshing,
							onClick: onRefresh,
							size: "icon",
							type: "button",
							variant: "ghost",
							children: /* @__PURE__ */ jsx(RefreshCw, { className: refreshing ? "animate-spin" : void 0 })
						})
					}), /* @__PURE__ */ jsx(TooltipContent, { children: "Refresh conversations" })] })]
				})]
			}),
			/* @__PURE__ */ jsxs("nav", {
				"aria-busy": loadingMore,
				"aria-label": "Conversation history",
				className: "min-h-0 flex-1 overflow-y-auto px-2.5 py-4.5",
				ref: infiniteScroll.rootRef,
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "mx-2.5 mb-4 grid gap-2",
						children: [
							/* @__PURE__ */ jsx(Label, {
								htmlFor: "group-conversations",
								children: "Organize by"
							}),
							/* @__PURE__ */ jsxs(Select, {
								onValueChange: (value) => {
									setGrouping(value);
									setFilter("all");
								},
								value: grouping,
								children: [/* @__PURE__ */ jsx(SelectTrigger, {
									id: "group-conversations",
									children: /* @__PURE__ */ jsx(SelectValue, {})
								}), /* @__PURE__ */ jsx(SelectContent, { children: conversationGroupingOptions.map((option) => /* @__PURE__ */ jsx(SelectItem, {
									value: option.value,
									children: option.label
								}, option.value)) })]
							}),
							grouping !== "none" ? /* @__PURE__ */ jsxs("div", {
								className: "grid gap-1.5",
								children: [/* @__PURE__ */ jsxs(Label, { children: ["Filter ", grouping] }), /* @__PURE__ */ jsxs(Select, {
									onValueChange: setFilter,
									value: filter,
									children: [/* @__PURE__ */ jsx(SelectTrigger, {
										"aria-label": `Filter ${grouping}`,
										children: /* @__PURE__ */ jsx(SelectValue, {})
									}), /* @__PURE__ */ jsxs(SelectContent, { children: [/* @__PURE__ */ jsx(SelectItem, {
										value: "all",
										children: "All"
									}), choices.map((choice) => /* @__PURE__ */ jsx(SelectItem, {
										value: choice,
										children: choice
									}, choice))] })]
								})]
							}) : null
						]
					}),
					/* @__PURE__ */ jsxs("p", {
						className: "mx-2.5 mb-2.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[.1em] text-subtle",
						children: ["History", /* @__PURE__ */ jsx(Badge, {
							"aria-label": `${conversations.length} of ${totalCount} conversations loaded`,
							role: "status",
							children: conversations.length < totalCount ? `${conversations.length} of ${totalCount}` : conversations.length
						})]
					}),
					conversations.length === 0 ? /* @__PURE__ */ jsxs("div", {
						className: "mx-2 my-4.5 rounded-lg border border-dashed border-input p-4.5",
						children: [/* @__PURE__ */ jsx("p", {
							className: "mb-1 text-[13px]",
							children: "No recorded sessions yet."
						}), /* @__PURE__ */ jsx("span", {
							className: "text-[11px] leading-relaxed text-subtle",
							children: "Enable history in oneharness, then refresh."
						})]
					}) : [...grouped].map(([group, items]) => /* @__PURE__ */ jsxs("section", {
						"aria-labelledby": `group-${group}`,
						children: [grouping !== "none" ? /* @__PURE__ */ jsx("h2", {
							className: "mx-2.5 mb-1.5 mt-3.5 break-words text-[11px] text-muted-foreground",
							id: `group-${group}`,
							children: group
						}) : null, /* @__PURE__ */ jsx("ul", {
							className: "grid list-none gap-1 p-0",
							children: items.map((conversation) => /* @__PURE__ */ jsxs("li", {
								"aria-label": `Session ID ${conversation.id}`,
								children: [/* @__PURE__ */ jsxs(Button, {
									"aria-label": `Open conversation ${conversation.name}`,
									"aria-current": selectedId === conversation.id ? "page" : void 0,
									className: "h-auto w-full flex-col items-stretch gap-1.5 rounded-[11px] border border-transparent px-3 py-3 text-left hover:bg-accent aria-[current=page]:border-input aria-[current=page]:bg-muted aria-[current=page]:shadow-[inset_3px_0_var(--primary)]",
									onClick: () => onSelect(conversation.id),
									type: "button",
									variant: "ghost",
									children: [
										/* @__PURE__ */ jsxs("span", {
											className: "flex min-w-0 items-center justify-between gap-2",
											children: [/* @__PURE__ */ jsx("strong", {
												className: "truncate text-[13px]",
												children: conversation.name
											}), conversation.running ? /* @__PURE__ */ jsx(StatusBadge, { state: "running" }) : null]
										}),
										/* @__PURE__ */ jsx("span", {
											className: "block truncate text-xs text-muted-foreground",
											title: conversation.project,
											children: conversation.project || "Project not recorded"
										}),
										/* @__PURE__ */ jsxs("span", {
											className: "truncate text-[10px] tracking-[.02em] text-subtle",
											children: [
												conversation.harnesses.join(", "),
												" · ",
												conversation.turnCount,
												" ",
												conversation.turnCount === 1 ? "turn" : "turns"
											]
										})
									]
								}), /* @__PURE__ */ jsxs(Dialog, {
									onOpenChange: (open) => {
										if (open) openEditor(conversation);
										else if (editingId === conversation.id) closeEditor();
									},
									open: editingId === conversation.id,
									children: [/* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
										asChild: true,
										children: /* @__PURE__ */ jsxs(Button, {
											"aria-label": "Edit labels",
											className: "mx-2 h-auto justify-start px-1 py-0.5 text-[10px] text-primary",
											onClick: () => {
												openEditor(conversation);
											},
											type: "button",
											variant: "ghost",
											children: [/* @__PURE__ */ jsx(Pencil, {}), (conversation.labels ?? []).length > 0 ? conversation.labels?.join(", ") : "Add labels"]
										})
									}), /* @__PURE__ */ jsx(TooltipContent, { children: "Edit labels" })] }), editingId === conversation.id ? /* @__PURE__ */ jsx(DialogContent, { children: /* @__PURE__ */ jsxs("form", {
										onSubmit: (event) => {
											event.preventDefault();
											saveLabels(conversation.id).catch(() => void 0);
										},
										children: [
											/* @__PURE__ */ jsxs(DialogHeader, { children: [/* @__PURE__ */ jsx(DialogTitle, { children: "Edit labels" }), /* @__PURE__ */ jsxs(DialogDescription, { children: [
												"Use commas to separate labels for ",
												conversation.name,
												"."
											] })] }),
											/* @__PURE__ */ jsxs("div", {
												className: "grid gap-2 py-2",
												children: [
													/* @__PURE__ */ jsxs(Label, {
														htmlFor: `labels-${conversation.id}`,
														children: ["Labels for ", conversation.name]
													}),
													/* @__PURE__ */ jsx(Input, {
														id: `labels-${conversation.id}`,
														maxLength: 1300,
														onChange: (event) => setLabelInput(event.target.value),
														value: labelInput
													}),
													labelError ? /* @__PURE__ */ jsxs("p", {
														className: "text-xs text-destructive",
														role: "alert",
														children: ["Couldn’t save labels. ", labelError.message]
													}) : null,
													validationError ? /* @__PURE__ */ jsx("p", {
														className: "text-xs text-destructive",
														role: "alert",
														children: validationError
													}) : null
												]
											}),
											/* @__PURE__ */ jsxs(DialogFooter, { children: [/* @__PURE__ */ jsx(DialogClose, {
												asChild: true,
												children: /* @__PURE__ */ jsx(Button, {
													type: "button",
													variant: "secondary",
													children: "Cancel"
												})
											}), /* @__PURE__ */ jsx(Button, {
												disabled: labeling,
												type: "submit",
												children: "Save labels"
											})] })
										]
									}) }) : null]
								})]
							}, conversation.id))
						})]
					}, group)),
					labelError ? /* @__PURE__ */ jsxs("p", {
						className: "mx-auto mt-3.5 max-w-md text-center text-[11px] text-destructive",
						role: "alert",
						children: ["Couldn’t save labels. ", labelError.message]
					}) : null,
					/* @__PURE__ */ jsxs("div", {
						className: "mx-auto max-w-[850px] text-center",
						children: [
							hasMore ? /* @__PURE__ */ jsx(Button, {
								className: "mt-3.5",
								disabled: loadingMore,
								onClick: infiniteScroll.loadMore,
								type: "button",
								variant: "secondary",
								children: loadingMore ? "Loading more conversations…" : loadMoreError ? "Retry loading conversations" : "Load more conversations"
							}) : conversations.length > 0 ? /* @__PURE__ */ jsxs("p", {
								"aria-label": `All ${totalCount} conversations loaded`,
								className: "mt-3.5 text-[11px] text-subtle",
								role: "status",
								children: [
									"All ",
									totalCount,
									" conversations loaded"
								]
							}) : null,
							loadMoreError ? /* @__PURE__ */ jsxs("p", {
								className: "mx-auto mt-3.5 max-w-md text-[11px] text-destructive",
								role: "alert",
								children: ["Couldn’t load more conversations. ", loadMoreError.message]
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
			/* @__PURE__ */ jsx(Separator, {}),
			/* @__PURE__ */ jsx("footer", {
				className: "px-5 py-3.5 text-[10px] uppercase tracking-[.05em] text-subtle max-[680px]:hidden",
				children: "Runs stay on this machine"
			})
		]
	});
}

//#endregion
export { ConversationList };
//# sourceMappingURL=conversation-list.mjs.map
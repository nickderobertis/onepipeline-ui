import { conversationLabelLimits } from "../presentational-types.mjs";
import { useState } from "react";

//#region ../../apps/conversation-ui/src/features/conversations/hooks/use-label-editor.ts
function useLabelEditor(onSetLabels) {
	const [editingId, setEditingId] = useState(null);
	const [labelInput, setLabelInput] = useState("");
	const [validationError, setValidationError] = useState(null);
	function openEditor(conversation) {
		setEditingId(conversation.id);
		setLabelInput((conversation.labels ?? []).join(", "));
		setValidationError(null);
	}
	function closeEditor() {
		setEditingId(null);
	}
	async function saveLabels(sessionId) {
		const labels = labelInput.split(",").map((value) => value.trim()).filter(Boolean);
		if (labels.length > conversationLabelLimits.maxCount || labels.some((label) => label.length > conversationLabelLimits.maxLength)) {
			setValidationError(`Use no more than ${conversationLabelLimits.maxCount} labels, with at most ${conversationLabelLimits.maxLength} characters each.`);
			return;
		}
		setValidationError(null);
		await onSetLabels(sessionId, labels);
		closeEditor();
	}
	return {
		closeEditor,
		editingId,
		labelInput,
		openEditor,
		saveLabels,
		setLabelInput,
		validationError
	};
}

//#endregion
export { useLabelEditor };
//# sourceMappingURL=use-label-editor.mjs.map
"use client";

import { useState } from "react";

//#region ../../apps/conversation-ui/src/features/conversations/hooks/use-reply-form.ts
function useReplyForm(onSubmit) {
	const [message, setMessage] = useState("");
	const [validationError, setValidationError] = useState(null);
	async function submit(event) {
		event.preventDefault();
		const value = message.trim();
		if (!value) {
			setValidationError("Write a message first");
			return;
		}
		if (value.length > 32e3) {
			setValidationError("Message must contain at most 32000 characters");
			return;
		}
		setValidationError(null);
		try {
			await onSubmit(value);
			setMessage("");
		} catch {}
	}
	return {
		message,
		setMessage,
		submit,
		validationError
	};
}

//#endregion
export { useReplyForm };
//# sourceMappingURL=use-reply-form.mjs.map
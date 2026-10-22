import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createVimEditorFactory } from "./src/editor.ts";

export default function (pi: ExtensionAPI) {
	let enabled = true;

	const install = (ctx: ExtensionContext): void => {
		const labelColor = (text: string) => ctx.ui.theme.fg("accent", text);
		ctx.ui.setEditorComponent(enabled ? createVimEditorFactory(labelColor) : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		enabled = true;
		install(ctx);
	});

	pi.registerCommand("vim", {
		description: "Toggle vim-style modal editing in the prompt editor",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Vim mode is only available in the interactive editor", "warning");
				return;
			}
			enabled = !enabled;
			install(ctx);
			ctx.ui.notify(`Vim mode ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});
}
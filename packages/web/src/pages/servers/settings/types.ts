import type { ServerView } from "@pi-web/shared";
import type { ServerSettingsErrors, ServerSettingsForm, SettingsField } from "../lib/server-settings-form";

/** Props shared by every section of the server settings form. */
export interface SectionProps {
	view: ServerView;
	form: ServerSettingsForm;
	base: ServerSettingsForm;
	set: (patch: Partial<ServerSettingsForm>) => void;
	errors: ServerSettingsErrors;
	dirty: ReadonlySet<SettingsField>;
}

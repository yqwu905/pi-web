/**
 * Editable rows of an environment variable map (workspace env, server-level env), validated
 * with the shared rules of @pi-web/shared (the host applies the same ones).
 */
import { ENV_COUNT_ERROR, ENV_TOTAL_ERROR, envEntryBytes, envNameError, envValueError, MAX_ENV_TOTAL_BYTES, MAX_ENV_VARS } from "@pi-web/shared";

export interface EnvRow {
	id: string;
	name: string;
	value: string;
}

let rowCounter = 0;
export function newEnvRow(name = "", value = ""): EnvRow {
	rowCounter += 1;
	return { id: `env-${rowCounter}`, name, value };
}

export function envToRows(env: Record<string, string> | undefined): EnvRow[] {
	return Object.entries(env ?? {}).map(([name, value]) => newEnvRow(name, value));
}

/** Key of a problem with a row's value in the errors of rowsToEnv; the row id alone keys a name problem. */
export function envValueErrorKey(rowId: string): string {
	return `${rowId}:value`;
}

/**
 * Rows with neither a name nor a value are ignored. Errors are keyed by row id (the name is
 * wrong) or by envValueErrorKey (the value is), one per row.
 */
export function rowsToEnv(rows: readonly EnvRow[]): { env: Record<string, string>; errors: Record<string, string> } {
	const env: Record<string, string> = {};
	const errors: Record<string, string> = {};
	const seen = new Set<string>();
	let total = 0;
	for (const row of rows) {
		const name = row.name.trim();
		if (!name && !row.value) continue;
		const nameError = envNameError(name);
		if (nameError) {
			errors[row.id] = nameError;
			continue;
		}
		if (seen.has(name)) {
			errors[row.id] = `重复的变量名 ${name}`;
			continue;
		}
		seen.add(name);
		const valueError = envValueError(row.value);
		if (valueError) {
			errors[envValueErrorKey(row.id)] = `变量值${valueError}`;
			continue;
		}
		if (Object.keys(env).length >= MAX_ENV_VARS) {
			errors[row.id] = ENV_COUNT_ERROR;
			continue;
		}
		const bytes = envEntryBytes(name, row.value);
		if (total + bytes > MAX_ENV_TOTAL_BYTES) {
			errors[envValueErrorKey(row.id)] = ENV_TOTAL_ERROR;
			continue;
		}
		total += bytes;
		env[name] = row.value;
	}
	return { env, errors };
}

/** Same variables (names trimmed, blank rows ignored), whatever the row order and ids. */
export function envRowsEqual(a: readonly EnvRow[], b: readonly EnvRow[]): boolean {
	const key = (rows: readonly EnvRow[]) =>
		rows
			.filter((r) => r.name.trim() || r.value)
			.map((r) => `${r.name.trim()}\u0000${r.value}`)
			.sort();
	const ka = key(a);
	const kb = key(b);
	return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

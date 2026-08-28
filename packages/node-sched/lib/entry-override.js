export function mergeEntryOverride(existing, patch) {
	const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
	return { ...base, ...patch };
}

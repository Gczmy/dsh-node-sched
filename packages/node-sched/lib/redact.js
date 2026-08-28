const SENSITIVE_CORE = "(?:password(?:hash|s)?|passwd|passphrase|token(?:s)?|secret(?:key|s)?|api[-_]?key|apikey|access[-_]?token|authtoken|clientsecret|authorization|private[-_]?key|credential(?:s)?|cookie|set-cookie)";
const SENSITIVE_KEY = `[A-Za-z0-9_.-]*${SENSITIVE_CORE}[A-Za-z0-9_.-]*`;
const ASSIGNMENT_VALUE = "(?:\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s;&|\"'`]+)";
const USER_VALUE = "(?:\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[^\\s;&|\"'`]+)";

function isSensitiveKey(key) {
	const words = String(key)
		.replace(/^-+/, "")
		.replace(/[\[\]]/g, ".")
		.toLowerCase()
		.split(/[._-]+/)
		.filter(Boolean);
	const sensitiveWords = new Set([
		"password", "passwd", "passphrase", "token", "tokens", "secret", "secrets",
		"authorization", "credential", "credentials", "cookie", "set", "apikey", "key",
	]);
	if (words.includes("password") || words.includes("passwd") || words.includes("passphrase")) return true;
	if (words.includes("token") || words.includes("tokens") || words.includes("secret") || words.includes("secrets")) return true;
	if (words.includes("authorization") || words.includes("credential") || words.includes("credentials")) return true;
	if (words.includes("cookie")) return true;
	const compact = words.join("");
	const sensitiveCompounds = [
		"password", "passwordhash", "passwords", "secret", "secretkey", "secrets", "token", "tokens",
		"apikey", "accesstoken", "authtoken", "clientsecret", "privatekey", "credential", "credentials",
	];
	return sensitiveCompounds.some((name) =>
		compact === name || compact.startsWith(name + "value") || compact.endsWith(name)
	);
}

function redactValue(value) {
	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
		return `${quote}[REDACTED]${quote}`;
	}
	return "[REDACTED]";
}

function clipLogText(text, maxChars) {
	const limit = Math.max(0, Math.trunc(Number(maxChars)));
	if (text.length <= limit) return text;
	let clipped = text.slice(0, limit);
	const last = clipped.charCodeAt(clipped.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
	return `${clipped}…`;
}

function escapeControls(text) {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (char) => {
		if (char === "\n") return "\\n";
		if (char === "\r") return "\\r";
		if (char === "\t") return "\\t";
		if (char === "\u2028") return "\\u2028";
		if (char === "\u2029") return "\\u2029";
		return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

export function sanitizeLogText(input, maxChars = 500) {
	const numericLimit = Number(maxChars);
	const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.trunc(numericLimit)) : 500;
	const raw = String(input ?? "");
	const bounded = raw.slice(0, limit);
	const safe = clipLogText(escapeControls(bounded), limit);
	return raw.length > limit ? `${safe}…` : safe;
}

function readQuotedEnd(text, start) {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i += 1) {
		if (text[i] === "\\") { i += 1; continue; }
		if (text[i] === quote) return i + 1;
	}
	return text.length;
}

function readJsonValueEnd(text, start) {
	let i = start;
	while (/\s/.test(text[i] ?? "")) i += 1;
	if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "'")) i += 1;
	if (text[i] === '"' || text[i] === "'") return readQuotedEnd(text, i);
	if (text[i] === "{" || text[i] === "[") {
		const stack = [text[i] === "{" ? "}" : "]"];
		for (i += 1; i < text.length; i += 1) {
			if (text[i] === '"' || text[i] === "'") { i = readQuotedEnd(text, i) - 1; continue; }
			if (text[i] === "{" || text[i] === "[") stack.push(text[i] === "{" ? "}" : "]");
			else if (text[i] === stack.at(-1)) {
				stack.pop();
				if (stack.length === 0) return i + 1;
			}
		}
		return text.length;
	}
	while (i < text.length && !/[\s,}\]]/.test(text[i])) i += 1;
	return i;
}

function redactJsonFields(text) {
	const keyPattern = /(?:^|[,{ \t\r\n])\\?(["']?)([A-Za-z0-9_.-]+)\\?\1[ \t\r\n]*:[ \t\r\n]*/gi;
	const replacements = [];
	let match;
	while ((match = keyPattern.exec(text)) !== null) {
		if (!isSensitiveKey(match[2])) continue;
		const start = match.index + match[0].length;
		const end = readJsonValueEnd(text, start);
		replacements.push({ start, end, value: redactValue(text.slice(start, end)) });
	}
	replacements.sort((a, b) => a.start - b.start);
	const selected = [];
	for (const replacement of replacements) {
		if (selected.some((item) => replacement.start < item.end && item.start < replacement.end)) continue;
		selected.push(replacement);
	}
	for (const replacement of selected.sort((a, b) => b.start - a.start)) {
		text = text.slice(0, replacement.start) + replacement.value + text.slice(replacement.end);
	}
	return text;
}
export function redactCommand(input, maxChars = 120) {
	const numericLimit = Number(maxChars);
	const limit = Number.isFinite(numericLimit) ? Math.max(0, Math.trunc(numericLimit)) : 120;
	const raw = String(input ?? "");
	const scanLimit = Math.max(2048, limit + 512);
	let text = raw.length > scanLimit ? `${raw.slice(0, scanLimit)}"'` : raw;

	const quotedHeader = new RegExp(
		`((?:^|\\s)(?:-H|--header)(?:=|\\s+)?(["']))((?:\\\\.|(?!\\2)[\\s\\S])*?)\\2`,
		"gi",
	);
	text = text.replace(quotedHeader, (match, prefix, _quote, value) => {
		if (!/(?:authorization|proxy-authorization|api[-_]?key|password|token|secret|cookie)/i.test(value)) return match;
		const colon = value.indexOf(":");
		const header = colon >= 0 ? `${value.slice(0, colon + 1)} [REDACTED]` : "[REDACTED]";
		return `${prefix}${header}${match.at(-1)}`;
	});
	const plainAuthHeader = /((?:^|\s|=|-H)(?:proxy-authorization|authorization|x-api-key|api-key|x-password|cookie|set-cookie)\s*:\s*)([^\r\n;&|"'`]+)/gi;
	text = text.replace(plainAuthHeader, (_, prefix) => `${prefix}[REDACTED]`);
	const userOption = /((?:^|\s)(?:--user|-u)(?:=|\s+))((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|"'`]+))/gi;
	text = text.replace(userOption, (_, prefix, value) => `${prefix}${redactValue(value)}`);
	const attachedUserOption = new RegExp(`((?:^|\\s)-u)(${USER_VALUE})`, "gi");
	text = text.replace(attachedUserOption, (_, prefix, value) => `${prefix}${redactValue(value)}`);
	const sshpassPassword = new RegExp(`((?:^|\\s)(?:[\\w./-]+/)?sshpass\\s+-p(?:=|\\s+))(${USER_VALUE})`, "gi");
	text = text.replace(sshpassPassword, (_, prefix, value) => `${prefix}${redactValue(value)}`);
	const attachedSshpassPassword = new RegExp(`((?:^|\\s)(?:[\\w./-]+/)?sshpass\\s+-p)(${USER_VALUE})`, "gi");
	text = text.replace(attachedSshpassPassword, (_, prefix, value) => `${prefix}${redactValue(value)}`);
	text = text.replace(/((?:https?|ssh):\/\/[^/\s:@]+:)([^@/\s]+)(@)/gi, "$1[REDACTED]$3");

	// Convert only shell-escaped structural quotes; preserve escaped quotes inside JSON strings.
	const quotedAssignment = new RegExp(
		`((?:^|[\\s=])(["'])((?:--?${SENSITIVE_KEY}|${SENSITIVE_KEY}))(\\s*=\\s*|\\s+))((?:\\\\.|(?!\\2)[^\\r\\n])*?)\\2`,
		"gi",
	);
	text = text.replace(quotedAssignment, (match, prefix, _quote, key) =>
		isSensitiveKey(key) ? `${prefix}[REDACTED]${match.at(-1)}` : match,
	);
	const shellSubstitution = new RegExp(
		"((?:^|[\\s;&|?#.=\\\"'`])(?:--?" + SENSITIVE_KEY + "|" + SENSITIVE_KEY + ")\\s*=\\s*)(\\$\\([^\\r\\n]*\\)|`[^`\\r\\n]*`)",
		"gi",
	);
	text = text.replace(shellSubstitution, (_, prefix) => `${prefix}[REDACTED]`);
	const sensitiveAssignment = new RegExp(
		"((?:^|[\\s;&|?#.=\\\"'`])((?:--?" + SENSITIVE_KEY + "|" + SENSITIVE_KEY + "))(\\s*=\\s*|\\s+))(" + ASSIGNMENT_VALUE + ")",
		"gi",
	);
	text = text.replace(sensitiveAssignment, (match, prefix, key, _separator, value) =>
		isSensitiveKey(key) ? `${prefix}${redactValue(value)}` : match,
	);
	const redactedFieldTail = new RegExp(
		`((?:^|[&])(?:--?${SENSITIVE_KEY}|${SENSITIVE_KEY})\\s*=\\s*\\[REDACTED\\])([^\\r\\n\"']*)([\"'])`,
		"gi",
	);
	text = text.replace(redactedFieldTail, "$1$3");
	text = redactJsonFields(text);
	return clipLogText(escapeControls(text), limit);
}

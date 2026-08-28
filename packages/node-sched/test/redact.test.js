import test from "node:test";
import assert from "node:assert/strict";
import { redactCommand } from "../lib/redact.js";

test("redactCommand masks flag, environment, and JSON secret values", () => {
	const command = "sched submit --token abc API_KEY=xyz {\"password\":\"pw\"}";
	assert.equal(
		redactCommand(command),
		"sched submit --token [REDACTED] API_KEY=[REDACTED] {\"password\":\"[REDACTED]\"}",
	);
});

test("redactCommand escapes newlines and caps the audit entry", () => {
	assert.equal(redactCommand("echo one\necho two", 100), "echo one\\necho two");
	assert.equal(redactCommand("x".repeat(5), 3), "xxx…");
});

test("redactCommand handles compound names, query credentials, and newlines", () => {
	const command = "echo ok\nAWS_SECRET_ACCESS_KEY=abc --access-token=\"my pass\" https://x/?token=secret";
	assert.equal(
		redactCommand(command),
		"echo ok\\nAWS_SECRET_ACCESS_KEY=[REDACTED] --access-token=\"[REDACTED]\" https://x/?token=[REDACTED]",
	);
});

test("redactCommand masks escaped and non-string JSON values", () => {
	const command = "{\"password\":\"pa\\\\\\\"ss\",\"token\":123456,\"secretKey\":\"x\"}";
	assert.equal(
		redactCommand(command),
		"{\"password\":\"[REDACTED]\",\"token\":[REDACTED],\"secretKey\":\"[REDACTED]\"}",
	);
});

test("redactCommand does not split a non-BMP character at the cap", () => {
	const value = `${"a".repeat(119)}😀`;
	const result = redactCommand(value, 120);
	assert.equal(result, `${"a".repeat(119)}…`);
	assert.equal([...result].length, 120);
});

test("redactCommand masks URL fragments, auth headers, and dotted names", () => {
	const command = "curl \"https://idp/cb#access_token=SECRET\" -H \"Authorization: Bearer TOPSECRET\" --data \"token=SECRET\" --spring.datasource.password=PW";
	assert.equal(
		redactCommand(command, 300),
		"curl \"https://idp/cb#access_token=[REDACTED]\" -H \"Authorization: [REDACTED]\" --data \"token=[REDACTED]\" --spring.datasource.password=[REDACTED]",
	);
});

test("redactCommand escapes all control characters", () => {
	assert.equal(redactCommand("a\rb\u0000c\u001bd"), "a\\rb\\x00c\\x1bd");
});

test("sanitizeLogText makes client log fields single-line and bounded", () => {
	assert.equal(sanitizeLogText("kind\r\nspoof\u0000", 100), "kind\\r\\nspoof\\x00");
	assert.equal(sanitizeLogText("abcdef", 3), "abc…");
});

test("redactCommand masks auth options and quoted form tails", () => {
	const command = "curl --header='X-Api-Key: SECRET' --data 'username=alice&password=SECRET MORE' -u alice:SECRET";
	assert.equal(
		redactCommand(command, 300),
		"curl --header='X-Api-Key: [REDACTED]' --data 'username=alice&password=[REDACTED]' -u [REDACTED]",
	);
});

test("redactCommand masks nested JSON, camel keys, and attached auth", () => {
	const command = "{\"meta\":{\"tokenValue\":\"SECRET\"},\"password\":{\"value\":\"INNER\"}} curl -ualice:SECRET -H X-Api-Key:KEY";
	const result = redactCommand(command, 300);
	assert.doesNotMatch(result, /SECRET|INNER|KEY/);
	assert.match(result, /\[REDACTED\]/);
});

test("sanitizeLogText escapes Unicode record separators", () => {
	assert.equal(sanitizeLogText("safe\u2028forged\u2029", 100), "safe\\u2028forged\\u2029");
});

test("redactCommand masks sshpass passwords", () => {
	assert.equal(redactCommand("sshpass -p SECRET ssh host cmd", 200), "sshpass -p [REDACTED] ssh host cmd");
	assert.equal(redactCommand("sshpass -pSECRET ssh host cmd", 200), "sshpass -p[REDACTED] ssh host cmd");
	assert.equal(redactCommand("sshpass -p 'SECRET' ssh host cmd", 200), "sshpass -p '[REDACTED]' ssh host cmd");
	assert.equal(redactCommand("/usr/bin/sshpass -p SECRET ssh host cmd", 200), "/usr/bin/sshpass -p [REDACTED] ssh host cmd");
	assert.equal(redactCommand("sshpass -p\"SECRET\" ssh host cmd", 200), "sshpass -p\"[REDACTED]\" ssh host cmd");
});

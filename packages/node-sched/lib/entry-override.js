import path from "node:path";

let tempSequence = 0;

export function mergeEntryOverride(existing, patch) {
	const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
	return { ...base, ...patch };
}

export function persistEntryOverride({
	fs,
	file,
	patch,
	tempFile = `${file}.tmp-${process.pid}-${Date.now()}-${++tempSequence}`,
}) {
	let previousContent;
	try {
		previousContent = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	let existing = {};
	if (previousContent !== undefined) {
		try {
			existing = JSON.parse(previousContent);
		} catch {
			// A malformed override is replaced only if the new write commits.
		}
	}
	const content = JSON.stringify(mergeEntryOverride(existing, patch), null, 2);
	const directory = path.dirname(file);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const constants = fs.constants ?? {};
	const tempFlags = typeof constants.O_WRONLY === "number"
		? constants.O_WRONLY
			| (constants.O_CREAT ?? 0)
			| (constants.O_EXCL ?? 0)
			| (constants.O_CLOEXEC ?? 0)
			| (constants.O_NOFOLLOW ?? 0)
		: "wx";
	const directoryFlags = typeof constants.O_RDONLY === "number"
		? constants.O_RDONLY
			| (constants.O_DIRECTORY ?? 0)
			| (constants.O_CLOEXEC ?? 0)
			| (constants.O_NOFOLLOW ?? 0)
		: "r";
	let tempFd;
	let directoryFd;
	let ownsTemp = false;
	let renamed = false;
	try {
		directoryFd = fs.openSync(directory, directoryFlags);
		tempFd = fs.openSync(tempFile, tempFlags, 0o600);
		ownsTemp = true;
		fs.writeFileSync(tempFd, content, { encoding: "utf8" });
		fs.fsyncSync(tempFd);
		fs.closeSync(tempFd);
		tempFd = undefined;
		fs.renameSync(tempFile, file);
		ownsTemp = false;
		renamed = true;
		fs.fsyncSync(directoryFd);
	} catch (error) {
		if (renamed) {
			const rollbackFile = `${tempFile}.rollback`;
			let rollbackFd;
			let ownsRollback = false;
			try {
				if (previousContent === undefined) {
					fs.unlinkSync(file);
				} else {
					rollbackFd = fs.openSync(rollbackFile, tempFlags, 0o600);
					ownsRollback = true;
					fs.writeFileSync(rollbackFd, previousContent, { encoding: "utf8" });
					fs.fsyncSync(rollbackFd);
					fs.closeSync(rollbackFd);
					rollbackFd = undefined;
					fs.renameSync(rollbackFile, file);
					ownsRollback = false;
				}
				fs.fsyncSync(directoryFd);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					"entry override directory commit failed and rollback was not durable",
				);
			} finally {
				if (rollbackFd !== undefined) {
					try { fs.closeSync(rollbackFd); } catch { /* best-effort close */ }
				}
				if (ownsRollback) {
					try { fs.unlinkSync?.(rollbackFile); } catch { /* best-effort owned temp cleanup */ }
				}
			}
		}
		throw error;
	} finally {
		if (tempFd !== undefined) {
			try { fs.closeSync(tempFd); } catch { /* best-effort close */ }
		}
		if (directoryFd !== undefined) {
			try { fs.closeSync(directoryFd); } catch { /* durability was already decided */ }
		}
		if (ownsTemp) {
			try { fs.unlinkSync?.(tempFile); } catch { /* best-effort owned temp cleanup */ }
		}
	}
}

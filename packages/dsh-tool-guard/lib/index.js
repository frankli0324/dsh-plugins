/**
 * Static tool interception: denies any bash command with a single sleep
 * invocation over 10 seconds. Registered as a monotonic guard over ctx.tools.
 */

const SLEEP_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
const SLEEP_TOKEN = /^(\d+(?:\.\d+)?)([smhd]?)$/i;

/** Parse one sleep duration token (`30`, `1.5`, `2m`); return seconds or undefined. */
function sleepTokenSeconds(token) {
	const match = SLEEP_TOKEN.exec(token);
	if (match === null) return undefined;
	return Number(match[1]) * SLEEP_UNIT_SECONDS[match[2].toLowerCase() || "s"];
}

/**
 * Largest single `sleep` invocation inside a shell command, in seconds.
 * GNU sleep accepts several duration tokens and sleeps their sum; each
 * invocation (split on shell operators) is judged on its own total.
 */
function maxSleepSeconds(command) {
	let worst = 0;
	for (const segment of command.split(/&&|\|\||[;|\n&]/)) {
		const sleep = /(?<![\w.-])sleep(?![\w-])(.*)/i.exec(segment);
		if (sleep === null) continue;
		let total = 0;
		for (const token of sleep[1].trim().split(/\s+/).filter(Boolean)) {
			const seconds = sleepTokenSeconds(token);
			if (seconds !== undefined) total += seconds;
		}
		if (total > worst) worst = total;
	}
	return worst;
}

const MAX_SLEEP_SECONDS = 10;

export const name = "dsh-tool-guard";
export const inject = ["tools"];

export function apply(ctx) {
	ctx.tools.guard((exec) => {
		if (exec.name !== "bash") return undefined;
		const command = exec.arguments?.command;
		if (typeof command !== "string") return undefined;
		const seconds = maxSleepSeconds(command);
		if (seconds <= MAX_SLEEP_SECONDS) return undefined;
		return `sleep ${seconds}s exceeds the ${MAX_SLEEP_SECONDS}s limit; keep each sleep at or under ${MAX_SLEEP_SECONDS}s`;
	});
}

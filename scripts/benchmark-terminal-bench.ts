import { parseArgs } from "node:util";
import manifest from "../tests/benchmarks/terminal-bench-2.1/manifest.json" with { type: "json" };
import type { EvaluationOptions } from "./terminal-bench/run.js";

const help = `Usage: bun run benchmark:suite:terminal-bench [options]

Evaluate Pi Stuff on Terminal-Bench 2.1 in local Harbor containers.
Defaults: committed local main, GPT-5.6 Luna/max, all 89 tasks, one repetition.

  --help                  Show this help without setup or model calls
  --list                  Preview tasks and requirements without execution
  --worktree <path>       Evaluate a worktree snapshot including uncommitted source
  --task <name>           Select an exact task name (repeatable)
  --repetitions <count>   Independent attempts per task (default: 1)
  --concurrency <count>   Concurrent local task containers (default: 2)
  --output <directory>    Local evidence directory
  --resume <directory>    Complete an interrupted evaluation

Requires installed Pi, Bun, RTK, Harbor 0.22.0, Docker with Compose,
and configured Luna credentials. No uploads or automatic model-task retries.
`;

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			help: { type: "boolean" },
			list: { type: "boolean" },
			worktree: { type: "string" },
			task: { type: "string", multiple: true },
			repetitions: { type: "string" },
			concurrency: { type: "string" },
			output: { type: "string" },
			resume: { type: "string" },
		},
	});
	if (values.help) {
		console.log(help);
		return;
	}
	const tasks = values.task ? [...new Set(values.task)] : manifest.dataset.taskNames;
	for (const task of tasks) {
		if (!manifest.dataset.taskNames.includes(task)) throw new Error(`Unknown Terminal-Bench task: ${task}`);
	}
	if (values.list) {
		console.log(`${tasks.length} tasks · Pi Stuff · ${values.worktree ?? "main"} · ${manifest.model.id}`);
		console.log(tasks.join("\n"));
		console.log("Local Harbor/Docker, Pi and Luna credentials required for execution; preview makes no model calls.");
		return;
	}
	if (values.resume && (values.worktree || values.task || values.repetitions || values.concurrency || values.output)) {
		throw new Error(
			"--resume uses the frozen protocol and cannot be combined with source, task, or execution options",
		);
	}
	const repetitions = Number(values.repetitions ?? 1);
	const concurrency = Number(values.concurrency ?? 2);
	if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new Error("--repetitions and --concurrency must be positive integers");
	}
	const { runEvaluation } = await import("./terminal-bench/run.js");
	const options: EvaluationOptions = {
		tasks,
		repetitions,
		concurrency,
	};
	if (values.worktree) options.worktree = values.worktree;
	if (values.output) options.output = values.output;
	if (values.resume) options.resume = values.resume;
	await runEvaluation(options);
}

if (import.meta.main) {
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

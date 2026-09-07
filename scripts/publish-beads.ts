import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { verifyDeliveryChecks } from "./beads-delivery-checks.ts";

const ID = Type.String({ pattern: "^ps-[a-z0-9]+(?:\\.[0-9]+)*$" });
const TEXT = Type.String({ minLength: 1, pattern: "\\S" });
const DELIVERY = Type.Object(
	{
		kind: Type.Union([Type.Literal("code"), Type.Literal("no-code")]),
		summary: TEXT,
		validation: TEXT,
		commits: Type.Array(Type.String({ pattern: "^[a-f0-9]{40}$" })),
		pull_request: Type.Optional(Type.Integer({ minimum: 1 })),
		no_pr_reason: Type.Optional(TEXT),
	},
	{ additionalProperties: false },
);
const RELATION = Type.Object({ id: ID, dependency_type: TEXT });
const BEAD = Type.Object({
	id: ID,
	title: TEXT,
	status: TEXT,
	close_reason: Type.Optional(Type.String()),
	external_ref: Type.Optional(Type.String()),
	metadata: Type.Optional(Type.Object({ github_delivery: Type.Optional(DELIVERY) })),
});
const COMMENTS = Type.Array(
	Type.Object({
		id: Type.Integer({ minimum: 1 }),
		body: Type.String(),
		html_url: TEXT,
		user: Type.Object({ login: TEXT }),
	}),
);
const PULL = Type.Object({
	html_url: TEXT,
	state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
	merged: Type.Boolean(),
	draft: Type.Boolean(),
	body: Type.Union([Type.String(), Type.Null()]),
	head: Type.Object({ sha: TEXT }),
	base: Type.Object({ repo: Type.Object({ full_name: TEXT }) }),
});
type Bead = Static<typeof BEAD>;
export type GithubMutation = { readonly body: string } | { readonly state: "open" | "closed"; readonly title: string };
type Run = (command: readonly string[], input?: GithubMutation) => string;

function readBead(id: string, run: Run): Bead {
	const value: unknown = JSON.parse(run(["bd", "show", id, "--json"]));
	if (!Check(Type.Array(BEAD, { minItems: 1, maxItems: 1 }), value) || value[0]?.id !== id) {
		throw new Error(`Invalid Beads record for ${id}`);
	}
	return value[0];
}

function publicationScope(id: string, run: Run, seen = new Set<string>()): Bead[] {
	if (seen.has(id)) throw new Error(`Repeated child in Beads publication scope: ${id}`);
	seen.add(id);
	const bead = readBead(id, run);
	const children: unknown = JSON.parse(run(["bd", "list", "--parent", id, "--all", "--limit", "0", "--json"]));
	if (!Check(Type.Array(Type.Object({ id: ID })), children)) throw new Error(`Invalid children for ${id}`);
	return [bead, ...children.flatMap((child) => publicationScope(child.id, run, seen))];
}

function issueNumber(bead: Bead, repository: string): number {
	const prefix = `https://github.com/${repository}/issues/`;
	const suffix = bead.external_ref?.startsWith(prefix) ? bead.external_ref.slice(prefix.length) : "";
	if (!/^[1-9][0-9]*$/u.test(suffix))
		throw new Error(`${bead.id}: missing GitHub Issue in ${repository}; publish it first`);
	return Number(suffix);
}

function validateDelivery(bead: Bead): void {
	const delivery = bead.metadata?.github_delivery;
	if (bead.status === "closed" && (!bead.close_reason?.trim() || !delivery)) {
		throw new Error(`${bead.id}: closed publication requires close_reason and metadata.github_delivery`);
	}
	if (!delivery) return;
	if (
		delivery.kind === "code" &&
		(delivery.commits.length === 0 || (!delivery.pull_request && !delivery.no_pr_reason))
	) {
		throw new Error(`${bead.id}: code delivery requires commits and a pull_request or explicit no_pr_reason`);
	}
	if (
		delivery.kind === "no-code" &&
		(delivery.commits.length > 0 || delivery.pull_request || !delivery.no_pr_reason)
	) {
		throw new Error(`${bead.id}: no-code delivery requires a no_pr_reason and no code references`);
	}
}

function github(run: Run, repository: string, path: string, method = "GET", input?: GithubMutation): string {
	const command = ["gh", "api", `repos/${repository}/${path}`, "--method", method];
	if (input !== undefined) command.push("--input", "-");
	return run(command, input);
}

function deliveryLines(bead: Bead, repository: string, run: Run): string[] {
	const delivery = bead.metadata?.github_delivery;
	if (!delivery) return ["Delivery has not been recorded yet."];
	const lines = [
		"## Delivery",
		delivery.summary,
		"",
		"### Validation",
		delivery.validation,
		"",
		"### Code and merge state",
	];
	for (const sha of delivery.commits) {
		const commit: unknown = JSON.parse(github(run, repository, `commits/${sha}`));
		if (!Check(Type.Object({ sha: Type.Literal(sha) }), commit))
			throw new Error(`${bead.id}: commit verification failed`);
		lines.push(`- Commit: https://github.com/${repository}/commit/${sha}`);
	}
	if (delivery.kind === "no-code") {
		lines.push(
			`- No PR: ${delivery.no_pr_reason}`,
			"- CI: not required for no-code delivery.",
			"- Merge state: not applicable.",
		);
		return lines;
	}
	if (!delivery.pull_request) {
		const target = delivery.commits.at(-1);
		if (!target) throw new Error(`${bead.id}: code delivery requires a final commit`);
		lines.push(
			`- No PR: ${delivery.no_pr_reason}`,
			...verifyDeliveryChecks(repository, target, "push", run).map((line) => `- CI: ${line}`),
			"- Merge state: not verified by this publication.",
		);
		return lines;
	}
	const pull: unknown = JSON.parse(github(run, repository, `pulls/${delivery.pull_request}`));
	if (!Check(PULL, pull) || pull.base.repo.full_name !== repository)
		throw new Error(`${bead.id}: invalid delivery PR`);
	if (!(pull.body ?? "").includes(`https://github.com/${repository}/issues/${issueNumber(bead, repository)}`)) {
		throw new Error(`${bead.id}: PR body must reference the full Issue URL before publication`);
	}
	if (!delivery.commits.includes(pull.head.sha))
		throw new Error(`${bead.id}: delivery commits must include the current PR head`);
	for (const line of verifyDeliveryChecks(repository, pull.head.sha, "pull_request", run)) lines.push(`- CI: ${line}`);
	const state = pull.merged
		? "merged"
		: pull.state === "closed"
			? "closed without merging"
			: pull.draft
				? "draft, not merged"
				: "open, not merged";
	lines.push(`- PR: ${pull.html_url}`, `- Merge state: ${state}.`);
	return lines;
}

function commentBody(bead: Bead, repository: string, run: Run): string {
	issueNumber(bead, repository);
	const lines = [marker(bead.id), `# Beads delivery: ${bead.id}`, "", `Canonical status: **${bead.status}**.`, ""];
	if (bead.status === "closed") lines.push("## Closure", bead.close_reason ?? "", "");
	lines.push(...deliveryLines(bead, repository, run), "", "## Related work");
	const related = ["down", "up"].flatMap((direction) => {
		const records: unknown = JSON.parse(run(["bd", "dep", "list", bead.id, "--direction", direction, "--json"]));
		if (!Check(Type.Array(RELATION), records)) throw new Error(`${bead.id}: invalid Beads relationships`);
		return records.map((relation) => ({ ...relation, direction: direction === "down" ? "outgoing" : "incoming" }));
	});
	for (const relation of related) {
		const target = readBead(relation.id, run);
		const targetNumber = issueNumber(target, repository);
		lines.push(
			`- ${relation.direction} ${relation.dependency_type}: [${target.id}](https://github.com/${repository}/issues/${targetNumber})`,
		);
	}
	if (related.length === 0) lines.push("No Beads relationships recorded.");
	lines.push("", "Published from Beads. This comment is updated in place; human comments are preserved.");
	return lines.join("\n");
}

function marker(id: string): string {
	return `<!-- pi-stuff:beads-delivery:${id} -->`;
}

function readComments(number: number, repository: string, run: Run): Static<typeof COMMENTS> {
	const pages: unknown = JSON.parse(
		run(["gh", "api", `repos/${repository}/issues/${number}/comments?per_page=100`, "--paginate", "--slurp"]),
	);
	if (!Check(Type.Array(COMMENTS), pages)) throw new Error(`Invalid GitHub comments for #${number}`);
	return pages.flat();
}

function publishComment(bead: Bead, body: string, repository: string, login: string, run: Run): string {
	const number = issueNumber(bead, repository);
	const managed = (comments: Static<typeof COMMENTS>) =>
		comments.filter((comment) => comment.body.startsWith(marker(bead.id)));
	const previous = managed(readComments(number, repository, run));
	if (previous.length > 1 || previous.some((comment) => comment.user.login !== login)) {
		throw new Error(
			`${bead.id}: ambiguous managed comment; resolve duplicate or foreign authorship before publishing`,
		);
	}
	const existing = previous[0];
	if (!existing) github(run, repository, `issues/${number}/comments`, "POST", { body });
	else if (existing.body !== body) github(run, repository, `issues/comments/${existing.id}`, "PATCH", { body });
	const final = managed(readComments(number, repository, run));
	if (final.length !== 1 || final[0]?.body !== body || final[0].user.login !== login) {
		throw new Error(`${bead.id}: delivery comment readback failed; retry publication`);
	}
	const state = bead.status === "closed" ? "closed" : "open";
	const expected = Type.Object({ state: Type.Literal(state), title: Type.Literal(bead.title) });
	const issue: unknown = JSON.parse(github(run, repository, `issues/${number}`));
	if (!Check(expected, issue)) {
		github(run, repository, `issues/${number}`, "PATCH", { state, title: bead.title });
	}
	const verified: unknown = JSON.parse(github(run, repository, `issues/${number}`));
	if (!Check(expected, verified)) throw new Error(`${bead.id}: Issue state/title readback failed; retry publication`);
	return final[0].html_url;
}

export function publishBeads(id: string, run: Run): string[] {
	if (!Check(ID, id)) throw new Error("Usage: bun run beads:publish -- <ps-bead-id>");
	const repository = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
	if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository)) throw new Error("Invalid GitHub repository");
	const login = run(["gh", "api", "user", "--jq", ".login"]).trim();
	if (!login) throw new Error("GitHub publishing identity unavailable");
	const before = publicationScope(id, run);
	for (const bead of before) validateDelivery(bead);
	for (const bead of before) deliveryLines(bead, repository, run);
	const sync = ["bd", "github", "sync", "--push-only", "--prefer-local", "--parent", id];
	run([...sync, "--dry-run"]);
	run(sync);
	const scope = publicationScope(id, run);
	for (const bead of scope) validateDelivery(bead);
	const plans = scope.map((bead) => ({ bead, body: commentBody(bead, repository, run) }));
	const urls = plans.map(({ bead, body }) => publishComment(bead, body, repository, login, run));
	run(["bd", "export", "--scrub", "-o", ".beads/issues.jsonl"]);
	return urls;
}

function main(): void {
	const [id, ...extra] = process.argv.slice(2);
	if (!id || !Check(ID, id) || extra.length > 1 || (extra.length === 1 && extra[0] !== "--locked"))
		throw new Error("Usage: bun run beads:publish -- <ps-bead-id>");
	const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (common.exitCode !== 0) throw new Error("Cannot resolve the canonical repository for Beads");
	const cwd = dirname(common.stdout.toString().trim());
	if (extra.length === 0) {
		const child = Bun.spawnSync(
			[
				"flock",
				"--nonblock",
				join(cwd, ".beads", "github-publish.lock"),
				process.execPath,
				import.meta.path,
				id,
				"--locked",
			],
			{ stdin: "inherit", stdout: "inherit", stderr: "inherit" },
		);
		if (child.exitCode !== 0)
			throw new Error("Publication failed or another publisher holds the repository lock; retry after it finishes");
		return;
	}
	const token =
		process.env["GITHUB_TOKEN"] ||
		Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
	if (!token) throw new Error("GitHub authentication unavailable");
	const run: Run = (command, input) => {
		const result = Bun.spawnSync([...command], {
			cwd,
			env: { ...process.env, GITHUB_TOKEN: token },
			stdout: "pipe",
			stderr: "pipe",
			stdin: input === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(input)),
		});
		if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
		return result.stdout.toString();
	};
	for (const url of publishBeads(id, run)) console.log(`Verified Beads publication: ${url}`);
}

if (import.meta.main) main();

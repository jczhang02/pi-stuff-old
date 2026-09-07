import { StringDecoder } from "node:string_decoder";
import { TerminalTextStream } from "../../shared/terminal-text.ts";

/** Command conditions are lifetime evidence, independent of the retained output tail. */
export class CommandMonitorEvidence {
	private readonly decoder = new StringDecoder("utf-8");
	private readonly terminal = new TerminalTextStream();
	private readonly success: string | undefined;
	private readonly failure: string | undefined;
	private readonly overlap: number;
	private tail = "";
	private successSeen = false;
	private failureSeen = false;

	constructor(successText?: string, failureText?: string) {
		this.success = successText || undefined;
		this.failure = failureText || undefined;
		this.overlap = Math.max(1, this.success?.length ?? 0, this.failure?.length ?? 0) - 1;
	}

	append(chunk: Buffer): void {
		if ((!this.success && !this.failure) || this.failureSeen) return;
		this.match(this.decoder.write(chunk));
	}

	private match(text: string): void {
		const value = this.tail + this.terminal.append(text);
		if (this.success && value.includes(this.success)) this.successSeen = true;
		if (this.failure && value.includes(this.failure)) this.failureSeen = true;
		this.tail = this.overlap > 0 ? value.slice(-this.overlap) : "";
	}

	finish(): boolean {
		this.match(this.decoder.end());
		return this.failureSeen || (this.success !== undefined && !this.successSeen);
	}
}

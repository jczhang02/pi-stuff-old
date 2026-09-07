import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";

class TestTerminal implements Terminal {
	readonly columns: number;
	readonly kittyProtocolActive = false;
	rows: number;

	constructor(rows: number, columns = 120) {
		this.rows = rows;
		this.columns = columns;
	}

	clearFromCursor(): void {}
	clearLine(): void {}
	clearScreen(): void {}
	async drainInput(): Promise<void> {}
	hideCursor(): void {}
	moveBy(_lines: number): void {}
	setProgress(_active: boolean): void {}
	setTitle(_title: string): void {}
	showCursor(): void {}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	write(_data: string): void {}
}

export class TestTui extends TuiAltScreen {
	private readonly testTerminal: TestTerminal;
	followingEnd = false;
	renderRequests = 0;
	scrollToBottomCalls = 0;

	constructor(rows = 32, columns = 120) {
		const terminal = new TestTerminal(rows, columns);
		super(terminal);
		this.testTerminal = terminal;
	}

	set rows(value: number) {
		this.testTerminal.rows = value;
	}

	override requestRender(): void {
		this.renderRequests += 1;
	}

	override scrollToBottom(): void {
		this.followingEnd = true;
		this.scrollToBottomCalls += 1;
		this.requestRender();
	}
}

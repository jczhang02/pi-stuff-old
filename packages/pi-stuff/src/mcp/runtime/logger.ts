import type { JsonInputValue } from "../../shared/json-value.ts";
/**
 * Centralized logging for MCP UI operations.
 * Provides structured, contextual logs with levels.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
	server?: string;
	session?: string;
	tool?: string;
	uri?: string;
	[key: string]: JsonInputValue;
}

export interface LogEntry {
	level: LogLevel;
	message: string;
	context?: LogContext;
	error?: Error;
	timestamp: Date;
}

type LogHandler = (entry: LogEntry) => void;

const LEVEL_PRIORITY = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

class Logger {
	private minLevel: LogLevel = "info";
	private handlers = new Set<LogHandler>();
	private defaultContext: LogContext = {};

	setLevel(level: LogLevel): void {
		this.minLevel = level;
	}

	setDefaultContext(context: LogContext): void {
		this.defaultContext = context;
	}

	addHandler(handler: LogHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	clearHandlers(): void {
		this.handlers.clear();
	}

	private shouldLog(level: LogLevel): boolean {
		return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
	}

	private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
		if (!this.shouldLog(level)) return;

		const entry: LogEntry = {
			level,
			message,
			context: { ...this.defaultContext, ...context },
			timestamp: new Date(),
		};
		if (error) entry.error = error;

		// The embedding Capability owns presentation. Writing to stdout/stderr here
		// would bypass Pi's renderer and corrupt the Host TUI.
		for (const handler of this.handlers) {
			try {
				handler(entry);
			} catch {
				// Ignore handler errors
			}
		}
	}

	debug(message: string, context?: LogContext): void {
		this.emit("debug", message, context);
	}

	info(message: string, context?: LogContext): void {
		this.emit("info", message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.emit("warn", message, context);
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.emit("error", message, context, error);
	}

	/**
	 * Create a child logger with additional default context.
	 */
	child(context: LogContext): ChildLogger {
		return new ChildLogger(this, context);
	}
}

class ChildLogger {
	private parent: Logger;
	private context: LogContext;

	constructor(parent: Logger, context: LogContext) {
		this.parent = parent;
		this.context = context;
	}

	debug(message: string, context?: LogContext): void {
		this.parent.debug(message, { ...this.context, ...context });
	}

	info(message: string, context?: LogContext): void {
		this.parent.info(message, { ...this.context, ...context });
	}

	warn(message: string, context?: LogContext): void {
		this.parent.warn(message, { ...this.context, ...context });
	}

	error(message: string, error?: Error, context?: LogContext): void {
		this.parent.error(message, error, { ...this.context, ...context });
	}

	child(context: LogContext): ChildLogger {
		return new ChildLogger(this.parent, { ...this.context, ...context });
	}
}

// Singleton instance
export const logger = new Logger();

// Enable debug mode via environment variable
if (process.env["MCP_UI_DEBUG"] === "1" || process.env["MCP_UI_DEBUG"] === "true") {
	logger.setLevel("debug");
}

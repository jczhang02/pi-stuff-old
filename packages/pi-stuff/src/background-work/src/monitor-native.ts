import { open, stat } from "node:fs/promises";
import { sanitizeTerminalText, utf8SafePrefix, utf8SafeTail } from "./output.ts";

export interface MonitorHttpResponse {
	readonly body: string;
	readonly ok: boolean;
	readonly status: number;
	readonly statusText: string;
}

export function readMonitorSize(path: string): Promise<number> {
	return stat(path).then((metadata) => metadata.size);
}

export async function readMonitorSlice(path: string, fromByte: number, maxBytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		const start = Math.max(fromByte, size - maxBytes);
		const length = Math.max(0, Math.min(maxBytes, size - start));
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const prefix = start > fromByte ? "…[earlier monitored content omitted]\n" : "";
		return sanitizeTerminalText(`${prefix}${utf8SafeTail(buffer, bytesRead).toString("utf-8")}`).trimEnd();
	} finally {
		await handle.close().catch(() => {});
	}
}

export async function readMonitorHttp(
	url: string,
	signal: AbortSignal,
	maxBytes: number,
): Promise<MonitorHttpResponse> {
	const response = await fetch(url, { redirect: "follow", signal });
	return {
		body: await readResponseBody(response, maxBytes),
		ok: response.ok,
		status: response.status,
		statusText: response.statusText,
	};
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			const remaining = maxBytes - bytes;
			if (remaining <= 0) break;
			const accepted = item.value.subarray(0, remaining);
			chunks.push(accepted);
			bytes += accepted.byteLength;
			if (accepted.byteLength < item.value.byteLength || bytes >= maxBytes) break;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const combined = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(utf8SafePrefix(Buffer.from(combined)));
}

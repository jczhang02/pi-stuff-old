import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JSONSchema7 } from "json-schema";
import type { TSchema } from "typebox";
import { parseJsonValue } from "../shared/json-value.ts";
import {
	isRuntimeBigInt,
	isRuntimeBoolean,
	isRuntimeFunction,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
	isRuntimeSymbol,
	isRuntimeUndefined,
} from "../shared/runtime-type.ts";
import type {
	SuiteToolCodeModeExecutionEndStatus,
	SuiteToolCodeModeLifecycle,
	SuiteToolCodeModePassEndStatus,
	SuiteToolDefinitionRegistry,
	SuiteToolInvocation,
} from "../tool-display/contract.ts";
import { type CodemodeValue, isCodemodeValue, requireCodemodeValue } from "./cloudflare/codec.ts";
import type { ConnectorDescription, ToolAnnotations } from "./cloudflare/connector-types.ts";
import { describeTarget } from "./cloudflare/describe.ts";
import { normalizeCode } from "./cloudflare/normalize.ts";
import { searchConnectors } from "./cloudflare/search.ts";
import type { Snippet } from "./cloudflare/snippet.ts";
import { toolPath } from "./cloudflare/utils.ts";
import {
	assertDecodableSupportedCodeModeImages,
	INVALID_CODE_MODE_IMAGE_MESSAGE,
	InvalidCodeModeImageError,
} from "./image-content.ts";
import { isCodeModeToolContent } from "./presentation.ts";
import type { SandboxToolExecutionContext, SuiteSandboxTool } from "./protocol.ts";

const INTERNAL_DESCRIBE_TOOL = "__pi_stuff_codemode_describe_v1";
const INTERNAL_SEARCH_TOOL = "__pi_stuff_codemode_search_v1";
export const INTERNAL_STEP_DECIDE_TOOL = "__pi_stuff_codemode_step_decide_v1";
export const INTERNAL_STEP_RECORD_TOOL = "__pi_stuff_codemode_step_record_v1";

export interface SuiteSandboxCatalogEntry {
	readonly description: string;
	readonly inputSchema: TSchema;
	readonly name: string;
	readonly replay: "never" | "record" | "reexecute";
	readonly requiresApproval?: boolean;
}

function oneLine(value: string): string {
	return value.replaceAll(/\s+/gu, " ").trim();
}

function toolErrorMessage(result: AgentToolResult<unknown>, fallback: string): string {
	for (const item of result.content) {
		if (item.type === "text" && item.text.trim()) return item.text.trim();
	}
	return fallback;
}

export class SuiteToolInvocationError extends Error {
	readonly result: AgentToolResult<unknown>;

	constructor(message: string, result: AgentToolResult<unknown>) {
		super(message);
		this.name = "SuiteToolInvocationError";
		this.result = result;
	}
}

function describeReceivedValue<Value>(value: Value): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (isRuntimeBigInt(value)) return "bigint";
	if (isRuntimeBoolean(value)) return "boolean";
	if (isRuntimeFunction(value)) return "function";
	if (isRuntimeNumber(value)) return "number";
	if (isRuntimeString(value)) return "string";
	if (isRuntimeSymbol(value)) return "symbol";
	if (isRuntimeUndefined(value)) return "undefined";
	return "object";
}

function invalidResult<Received>(name: string, path: string, expected: string, received: Received): never {
	throw new Error(
		`Code Mode Tool ${JSON.stringify(name)} returned an invalid result at ${path}: expected ${expected}; received ${describeReceivedValue(received)}; retry safe: false`,
	);
}

/** Cloudflare-compatible MCP/Pi result unwrapping with a strict content boundary. */
export function unwrapSuiteToolResult<Result>(name: string, result: Result): CodemodeValue {
	if (!isRuntimeObject(result) || result === null) invalidResult(name, "result", "an object", result);
	// SAFETY: the object guard above permits inspection through the Suite Tool result envelope validated below.
	const record = result as Result & {
		readonly content?: unknown;
		readonly structuredContent?: unknown;
		readonly toolResult?: unknown;
	};
	if (record.toolResult !== undefined) {
		if (!isCodemodeValue(record.toolResult)) {
			invalidResult(name, "result.toolResult", "a Code Mode transport value", record.toolResult);
		}
		return record.toolResult;
	}
	if (record.structuredContent != null) {
		if (!isCodemodeValue(record.structuredContent)) {
			invalidResult(name, "result.structuredContent", "a Code Mode transport value", record.structuredContent);
		}
		return record.structuredContent;
	}
	const content: unknown = record.content;
	if (!Array.isArray(content)) invalidResult(name, "result.content", "an array", content);
	const textParts: string[] = [];
	let textOnly = content.length > 0;
	for (const [index, item] of content.entries()) {
		if (!isRuntimeObject(item) || item === null) {
			invalidResult(name, `result.content[${String(index)}]`, "a content object", item);
		}
		const type = "type" in item ? item.type : undefined;
		const blockText = "text" in item ? item.text : undefined;
		if (type === "text" && !isRuntimeString(blockText)) {
			invalidResult(name, `result.content[${String(index)}].text`, "a string", blockText);
		}
		const data = "data" in item ? item.data : undefined;
		const mimeType = "mimeType" in item ? item.mimeType : undefined;
		if (type === "image" && (!isRuntimeString(data) || !isRuntimeString(mimeType))) {
			invalidResult(name, `result.content[${String(index)}]`, "base64 image data and a MIME type", item);
		}
		if (type !== "text" && type !== "image") {
			invalidResult(name, `result.content[${String(index)}].type`, '"text" or "image"', type);
		}
		if (type === "text") textParts.push(blockText);
		else textOnly = false;
	}
	if (!textOnly) {
		if (!isCodemodeValue(record)) invalidResult(name, "result", "a Code Mode transport value", record);
		return record;
	}
	const text = textParts.join("\n");
	try {
		return requireCodemodeValue(parseJsonValue(text), "Code Mode text result");
	} catch {
		return text;
	}
}

export class SuiteCodeModeConnector {
	readonly registry: SuiteToolDefinitionRegistry;

	constructor(registry: SuiteToolDefinitionRegistry) {
		this.registry = registry;
	}

	catalog(): SuiteSandboxCatalogEntry[] {
		return this.registry
			.catalog()
			.filter((entry) => this.registry.isActive(entry.definition.name))
			.map((entry) => {
				if (entry.codeMode?.requiresApproval && entry.codeMode.replay === "reexecute") {
					throw new Error(
						`Code Mode Tool ${JSON.stringify(entry.definition.name)} cannot combine requiresApproval with replay: reexecute`,
					);
				}
				const catalogEntry = {
					description: oneLine(entry.definition.description),
					inputSchema: entry.definition.parameters,
					name: entry.definition.name,
					replay: entry.codeMode?.replay ?? "never",
				} satisfies SuiteSandboxCatalogEntry;
				return entry.codeMode?.requiresApproval ? { ...catalogEntry, requiresApproval: true } : catalogEntry;
			});
	}

	describe(target: string, snippets: readonly Snippet[] = []): ReturnType<typeof describeTarget> {
		return describeTarget(target, [this.connectorDescription()], [...snippets]);
	}

	search(query: string, snippets: readonly Snippet[] = []): ReturnType<typeof searchConnectors> {
		return searchConnectors(query, [this.connectorDescription()], [...snippets]);
	}

	async disposeExecution(executionId: string, status: SuiteToolCodeModeExecutionEndStatus): Promise<void> {
		await Promise.allSettled(
			this.lifecycles().map(async (lifecycle) => lifecycle.disposeExecution?.(executionId, status)),
		);
	}

	async onPassEnd(executionId: string, status: SuiteToolCodeModePassEndStatus): Promise<void> {
		await Promise.allSettled(this.lifecycles().map(async (lifecycle) => lifecycle.onPassEnd?.(executionId, status)));
	}

	tools(): SuiteSandboxTool[] {
		return this.catalog().map((entry) => {
			const tool = {
				description: entry.description,
				inputSchema: entry.inputSchema,
				name: entry.name,
				replay: entry.replay,
				usage: `${toolPath(entry.name)}(input)`,
				invoke: (input: CodemodeValue, context: SandboxToolExecutionContext, signal: AbortSignal) =>
					this.invoke(entry.name, input, context, signal),
			} satisfies SuiteSandboxTool;
			return entry.requiresApproval ? { ...tool, requiresApproval: true } : tool;
		});
	}

	runtimeTools(snippets: readonly Snippet[] = []): SuiteSandboxTool[] {
		return [
			...this.tools(),
			{
				description: "Search the active programmatic Tool catalog",
				inputSchema: {
					additionalProperties: false,
					properties: { query: { type: "string" } },
					required: ["query"],
					type: "object",
				},
				name: INTERNAL_SEARCH_TOOL,
				presentation: "hidden",
				replay: "record",
				usage: `${INTERNAL_SEARCH_TOOL}({ query })`,
				invoke: async (input) =>
					requireCodemodeValue(
						this.search(
							isRuntimeObject(input) && input !== null && "query" in input ? String(input["query"]) : "",
							snippets,
						),
						"Code Mode search result",
					),
			},
			{
				description: "Describe one active programmatic Tool or saved snippet",
				inputSchema: {
					additionalProperties: false,
					properties: { target: { type: "string" } },
					required: ["target"],
					type: "object",
				},
				name: INTERNAL_DESCRIBE_TOOL,
				presentation: "hidden",
				replay: "record",
				usage: `${INTERNAL_DESCRIBE_TOOL}({ target })`,
				invoke: async (input) =>
					requireCodemodeValue(
						this.describe(
							isRuntimeObject(input) && input !== null && "target" in input ? String(input["target"]) : "",
							snippets,
						),
						"Code Mode describe result",
					),
			},
		];
	}

	private connectorDescription(): ConnectorDescription {
		return {
			annotations: Object.fromEntries(
				this.catalog().map((entry) => {
					const annotations: ToolAnnotations = {};
					if (entry.requiresApproval) annotations.requiresApproval = true;
					if (entry.replay === "reexecute") annotations.replay = "reexecute";
					return [entry.name, annotations];
				}),
			),
			descriptors: Object.fromEntries(
				this.catalog().map((entry) => [
					entry.name,
					{
						description: entry.description,
						// SAFETY: Pi Tool parameters are TypeBox schemas, which implement the JSON Schema object contract.
						inputSchema: entry.inputSchema as JSONSchema7,
					},
				]),
			),
			name: "tools",
		};
	}

	private lifecycles(): SuiteToolCodeModeLifecycle[] {
		return [
			...new Set(
				this.registry
					.catalog()
					.filter((entry) => this.registry.isActive(entry.definition.name))
					.flatMap((entry) => (entry.codeMode?.lifecycle ? [entry.codeMode.lifecycle] : [])),
			),
		];
	}

	private async invoke(
		name: string,
		input: CodemodeValue,
		context: SandboxToolExecutionContext,
		signal: AbortSignal,
	): Promise<CodemodeValue> {
		if (!context.extensionContext) throw new Error("Code Mode ExtensionContext is unavailable");
		if (!context.toolCallId) throw new Error("Code Mode nested Tool call ID is unavailable");
		const invocation = {
			context: context.extensionContext,
			input,
			name,
			signal,
			toolCallId: context.toolCallId,
		} satisfies SuiteToolInvocation;
		const outcome = await this.registry.invoke(
			context.onUpdate ? { ...invocation, onUpdate: context.onUpdate } : invocation,
		);
		let value: CodemodeValue;
		try {
			value = unwrapSuiteToolResult(name, outcome.result);
			// SAFETY: Suite Tool results may carry these compatibility fields, which remain unknown until checked below.
			const result = outcome.result as typeof outcome.result & {
				readonly structuredContent?: unknown;
				readonly toolResult?: unknown;
			};
			const imageContent: AgentToolResult<unknown>["content"][] = [];
			for (const candidate of [result, result.structuredContent, result.toolResult]) {
				if (!isRuntimeObject(candidate) || candidate === null || !("content" in candidate)) continue;
				const content = candidate["content"];
				if (!Array.isArray(content)) continue;
				const containsImage = content.some(
					(item) => isRuntimeObject(item) && item !== null && "type" in item && item.type === "image",
				);
				if (containsImage) {
					if (!isCodeModeToolContent(content)) throw new InvalidCodeModeImageError();
					if (!imageContent.includes(content)) imageContent.push(content);
				}
			}
			for (const content of imageContent) await assertDecodableSupportedCodeModeImages(content);
		} catch (error) {
			if (!(error instanceof InvalidCodeModeImageError)) throw error;
			const result = {
				...outcome.result,
				content: [{ type: "text" as const, text: INVALID_CODE_MODE_IMAGE_MESSAGE }],
				structuredContent: undefined,
				toolResult: undefined,
			};
			context.captureResult?.(result);
			throw new SuiteToolInvocationError(INVALID_CODE_MODE_IMAGE_MESSAGE, result);
		}
		context.captureResult?.(outcome.result);
		if (outcome.isError)
			throw new SuiteToolInvocationError(toolErrorMessage(outcome.result, `${name} failed`), outcome.result);
		return value;
	}
}

export function buildSuiteSandboxSource(
	source: string,
	catalog: readonly SuiteSandboxCatalogEntry[],
	snippets: readonly Snippet[] = [],
): string {
	const serialized = JSON.stringify(
		catalog.map((entry) => {
			const serializedEntry = {
				description: entry.description,
				inputSchema: entry.inputSchema,
				name: entry.name,
				path: toolPath(entry.name),
			};
			return entry.requiresApproval ? { ...serializedEntry, requiresApproval: true } : serializedEntry;
		}),
	);
	const snippetEntries = snippets
		.map((snippet) => `[${JSON.stringify(snippet.name)},(${normalizeCode(snippet.code)})]`)
		.join(",");
	const program = normalizeCode(source);
	return `{
const __piStuffCatalog=${serialized};
const __piStuffSnippets=new Map([${snippetEntries}]);
const __piStuffBinaryTag="__codemode_binary_v1__";
const __piStuffBigintTag="__codemode_bigint_v1__";
const __piStuffBase64="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const __piStuffToBase64=(bytes)=>{let output="";for(let index=0;index<bytes.length;index+=3){const first=bytes[index];const second=bytes[index+1];const third=bytes[index+2];output+=__piStuffBase64[first>>2]+__piStuffBase64[((first&3)<<4)|((second??0)>>4)]+(second===undefined?"=":__piStuffBase64[((second&15)<<2)|((third??0)>>6)])+(third===undefined?"=":__piStuffBase64[third&63]);}return output;};
const __piStuffFromBase64=(value)=>{let buffer=0,bits=0;const output=[];for(const character of value){if(character==="=")break;const digit=__piStuffBase64.indexOf(character);if(digit<0)throw new TypeError("Invalid Code Mode binary value");buffer=(buffer<<6)|digit;bits+=6;if(bits>=8){bits-=8;output.push((buffer>>bits)&255);}}return new Uint8Array(output);};
const __piStuffEncode=(value)=>{if(typeof value==="bigint")return {[__piStuffBigintTag]:value.toString()};if(value instanceof Uint8Array)return {[__piStuffBinaryTag]:"Uint8Array",data:__piStuffToBase64(value)};if(value instanceof ArrayBuffer)return {[__piStuffBinaryTag]:"ArrayBuffer",data:__piStuffToBase64(new Uint8Array(value))};if(ArrayBuffer.isView(value))return {[__piStuffBinaryTag]:"ArrayBufferView",data:__piStuffToBase64(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};if(Array.isArray(value))return value.map(__piStuffEncode);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,nested])=>[key,__piStuffEncode(nested)]));return value;};
const __piStuffDecode=(value)=>{if(Array.isArray(value))return value.map(__piStuffDecode);if(!value||typeof value!=="object")return value;const keys=Object.keys(value);if(keys.length===1&&Object.hasOwn(value,__piStuffBigintTag)){const encoded=value[__piStuffBigintTag];if(typeof encoded!=="string"||!${String.raw`/^-?(?:0|[1-9]\d*)$/u`}.test(encoded))throw new TypeError("Invalid Code Mode bigint envelope");return BigInt(encoded);}if(keys.length===2&&Object.hasOwn(value,__piStuffBinaryTag)&&Object.hasOwn(value,"data")){const tag=value[__piStuffBinaryTag];if((tag!=="ArrayBuffer"&&tag!=="ArrayBufferView"&&tag!=="Uint8Array")||typeof value.data!=="string")throw new TypeError("Invalid Code Mode binary envelope");const bytes=__piStuffFromBase64(value.data);return tag==="ArrayBuffer"?bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength):bytes;}return Object.fromEntries(Object.entries(value).map(([key,nested])=>[key,__piStuffDecode(nested)]));};
const __piStuffRawTools=globalThis.tools;
const __piStuffToolCache=new Map();
globalThis.tools=new Proxy(__piStuffRawTools,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=="function")return value;if(!__piStuffToolCache.has(key))__piStuffToolCache.set(key,async(...args)=>__piStuffDecode(await value.apply(target,args.map(__piStuffEncode))));return __piStuffToolCache.get(key);}});
const __piStuffHost={text:globalThis.text,image:globalThis.image,generatedImage:globalThis.generatedImage,audio:globalThis.audio,notify:globalThis.notify};
let __piStuffOutputCount=0;
const __piStuffOutput=(name)=>(...args)=>{const helper=__piStuffHost[name];if(typeof helper!=="function")throw new Error("Unsupported Code Mode output helper: "+name);__piStuffOutputCount+=1;return helper(...args);};
const __piStuffImageBlocks=(value)=>{if(!value||typeof value!=="object"||!Array.isArray(value.content))return null;const images=[];for(const item of value.content){if(item&&item.type==="text"&&typeof item.text==="string")continue;if(item&&item.type==="image"&&typeof item.data==="string"&&typeof item.mimeType==="string"){images.push(item);continue;}return null;}return images.length>0?images:null;};
const text=__piStuffOutput("text");
const image=(value,...args)=>{const helper=__piStuffHost.image;if(typeof helper!=="function")throw new Error("Unsupported Code Mode output helper: image");__piStuffOutputCount+=1;const blocks=__piStuffImageBlocks(value);if(!blocks)return helper(value,...args);let output;for(const block of blocks)output=helper(block,...args);return output;};
const generatedImage=__piStuffOutput("generatedImage");
const audio=__piStuffOutput("audio");
const notify=__piStuffOutput("notify");
globalThis.suite=globalThis.tools;
globalThis.codemode={};
globalThis.codemode.search=(query)=>globalThis.tools.${INTERNAL_SEARCH_TOOL}({query:String(query??"")});
globalThis.codemode.describe=(target)=>globalThis.tools.${INTERNAL_DESCRIBE_TOOL}({target:String(target??"")});
globalThis.codemode.run=async(name,input)=>{const snippet=__piStuffSnippets.get(String(name));if(!snippet)return {error:"Snippet "+JSON.stringify(String(name))+" not found."};return await snippet(input);};
globalThis.codemode.step=async(name,fn)=>{if(typeof fn!=="function")throw new TypeError("codemode.step(name, fn) requires a function");const decision=await globalThis.tools.${INTERNAL_STEP_DECIDE_TOOL}({name:String(name)});if(decision.kind==="replay")return decision.result;if(decision.kind!=="execute")throw new Error("Code Mode step could not continue");const value=await fn();await globalThis.tools.${INTERNAL_STEP_RECORD_TOOL}({plan:decision.plan,value});return value;};
Object.freeze(globalThis.codemode);
const __piStuffProgram=(${program});
const __piStuffResult=await __piStuffProgram();
if(__piStuffOutputCount===0&&__piStuffResult!==undefined){
  if(__piStuffResult&&typeof __piStuffResult==="object"&&Array.isArray(__piStuffResult.content)){
    for(const item of __piStuffResult.content){
      if(item?.type==="text"&&typeof item.text==="string")text(item.text);
      else if(item?.type==="image"&&typeof item.data==="string"&&typeof item.mimeType==="string")image({image_url:"data:"+item.mimeType+";base64,"+item.data});
    }
  }else{
    let value;
    try{value=typeof __piStuffResult==="string"?__piStuffResult:JSON.stringify(__piStuffEncode(__piStuffResult));}catch{throw new TypeError("Code Mode returned a value that is not JSON-serializable");}
    if(typeof value!=="string")throw new TypeError("Code Mode returned an unsupported value");
    text(value);
  }
}
}`;
}

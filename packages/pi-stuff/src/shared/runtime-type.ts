import { Guard } from "typebox/guard";

const { IsNumber, IsObject, IsNull } = Guard;

export const isRuntimeBigInt = Guard.IsBigInt;
export const isRuntimeBoolean = Guard.IsBoolean;
export const isRuntimeFunction = Guard.IsFunction;
export const isRuntimeString = Guard.IsString;
export const isRuntimeSymbol = Guard.IsSymbol;
export const isRuntimeUndefined = Guard.IsUndefined;

export function isRuntimeNumber<Value>(value: Value): value is Value & number {
	return (
		IsNumber(value) ||
		Object.is(value, Number.NaN) ||
		Object.is(value, Number.POSITIVE_INFINITY) ||
		Object.is(value, Number.NEGATIVE_INFINITY)
	);
}

export function isFiniteRuntimeNumber<Value>(value: Value): value is Value & number {
	return IsNumber(value);
}

export function isRuntimeObject<Value>(value: Value): value is Value & (object | null) {
	return IsObject(value) || IsNull(value);
}

export function runtimeErrorCode<Value>(value: Value): string | undefined {
	return isRuntimeObject(value) && value !== null && "code" in value ? String(value.code) : undefined;
}

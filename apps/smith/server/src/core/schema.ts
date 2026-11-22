/**
 * Compact JSON Schema helpers for tool parameters.
 *
 * Every request sends the tool schemas, so their size costs tokens each
 * turn. TypeBox renders a union of string literals as
 * `anyOf: [{ type, const }, ...]`, about three times the tokens of one
 * `{ type: "string", enum: [...] }`. The validator (pi-schema, through
 * pi-ai's `validateToolArguments`) accepts and rejects the same values for
 * both forms.
 */
import Type, { type TSchemaOptions } from "typebox"

/** A string that is one of `values`, as `{ type: "string", enum }`. */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: TSchemaOptions = {}
) {
  return Type.Unsafe<T[number]>({
    ...options,
    type: "string",
    enum: [...values],
  })
}

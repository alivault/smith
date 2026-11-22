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

/**
 * A copy of an object schema with other property descriptions, by path:
 * `edits` is a property, `edits.oldText` a property of its items. For the
 * schemas of tools that Smith takes from pi, which have long descriptions.
 */
export function withDescriptions<T>(
  schema: T,
  descriptions: Record<string, string>
): T {
  const copy = JSON.parse(JSON.stringify(schema)) as T
  for (const [path, description] of Object.entries(descriptions)) {
    let node = copy as Record<string, unknown> | undefined
    for (const name of path.split(".")) {
      if (node?.type === "array")
        node = node.items as Record<string, unknown> | undefined
      const properties = node?.properties as
        | Record<string, Record<string, unknown>>
        | undefined
      node = properties?.[name]
    }
    if (!node) throw new Error(`No schema property ${path}`)
    node.description = description
  }
  return copy
}

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

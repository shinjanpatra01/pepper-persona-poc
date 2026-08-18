import { z, type ZodType } from "zod";

/**
 * Convert a Zod schema into the JSON Schema dialect that OpenAI-compatible
 * "structured outputs" require.
 *
 * Providers enforce two rules beyond plain JSON Schema:
 *   1. every object must set "additionalProperties": false
 *   2. every property must be listed in "required"
 *
 * Zod's own converter does not always emit those, so we walk the tree and
 * harden it. Doing this means the model CANNOT return a malformed Agent Spec -
 * the shape is enforced at the API layer, before a single token reaches us.
 */
function harden(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) harden(child);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const obj = node as Record<string, unknown>;

  if (obj.type === "object") {
    obj.additionalProperties = false;
    const properties = obj.properties as Record<string, unknown> | undefined;
    obj.required = properties ? Object.keys(properties) : [];
  }

  // Recurse through every nested schema position we might encounter.
  for (const key of ["properties", "$defs", "definitions"]) {
    const container = obj[key] as Record<string, unknown> | undefined;
    if (container && typeof container === "object") {
      for (const child of Object.values(container)) harden(child);
    }
  }
  for (const key of ["items", "additionalItems", "not"]) {
    if (obj[key]) harden(obj[key]);
  }
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    if (Array.isArray(obj[key])) harden(obj[key]);
  }
}

export function toStrictJsonSchema(schema: ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as Record<string, unknown>;

  delete jsonSchema.$schema;
  harden(jsonSchema);
  return jsonSchema;
}

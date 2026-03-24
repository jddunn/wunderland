import { z, type ZodTypeAny } from 'zod';

/**
 * Represents a single field definition in a simplified YAML schema.
 * Supports primitive types, arrays with optional item typing, and generic objects.
 */
export interface YamlFieldDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** When true, the field is required and will throw if absent during parse. */
  required?: boolean;
  /** Provides a default value; field becomes optional in the Zod schema. */
  default?: any;
  /** Item type for array fields. If omitted, array items are typed as unknown. */
  items?: YamlFieldDef;
}

/**
 * Converts a simplified YAML schema definition to a Zod object schema.
 *
 * Rules:
 * - Fields with `required: true` are required in the output schema.
 * - Fields with a `default` value are optional and fall back to that default.
 * - All other fields are optional (`.optional()`).
 *
 * @param yamlSchema - A record mapping field names to their {@link YamlFieldDef} descriptors.
 * @returns A `z.ZodObject` that can be used to parse and validate runtime data.
 *
 * @example
 * ```ts
 * const schema = schemaFromYaml({
 *   topic: { type: 'string', required: true },
 *   depth: { type: 'number', default: 3 },
 *   tags:  { type: 'array', items: { type: 'string' } },
 * });
 * schema.parse({ topic: 'AI' }); // { topic: 'AI', depth: 3, tags: undefined }
 * ```
 */
export function schemaFromYaml(yamlSchema: Record<string, YamlFieldDef>): z.ZodObject<any> {
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, def] of Object.entries(yamlSchema)) {
    let fieldSchema = yamlTypeToZod(def);

    if (def.default !== undefined) {
      // `.default()` implies optionality — no extra `.optional()` needed.
      fieldSchema = fieldSchema.default(def.default);
    } else if (!def.required) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return z.object(shape);
}

/**
 * Maps a {@link YamlFieldDef} to its base Zod type (without required/default wrapping).
 *
 * @param def - The field definition to convert.
 * @returns The corresponding Zod schema for the field's type.
 */
function yamlTypeToZod(def: YamlFieldDef): ZodTypeAny {
  switch (def.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      // When no items spec is provided, fall back to z.unknown() for maximum flexibility.
      return z.array(def.items ? yamlTypeToZod(def.items) : z.unknown());
    case 'object':
      // Generic key-value map; values are typed as unknown.
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}

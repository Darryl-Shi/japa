// Tool parameter schemas go to every model the CoS or a worker runs on, unchanged: pi-ai passes them through as-is,
// and every tool installed is sent on every turn. A construct one provider rejects therefore fails *every* request
// on that provider, not just calls to that tool -- e.g. Z.AI answers any request carrying a tuple schema with
// `400 {"code":"1210","message":"Invalid API parameter"}`. So tools are held to the subset providers share, and a
// tool outside it is refused when its extension loads (and by `japa check`), instead of breaking the CoS later.

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords that take a subschema, or a map/list of subschemas, to walk into. */
const SUBSCHEMA = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];

const TUPLE_HINT = "tuples aren't supported by every model provider; use an array with minItems/maxItems instead";

/** The constructs in `node` itself that some provider rejects, as `<path>: <problem>`. */
function ownProblems(node: Node, path: string): string[] {
  const problems: string[] = [];
  if (Array.isArray(node.items)) problems.push(`${path}: "items" is a list (a tuple); ${TUPLE_HINT}`);
  if (node.prefixItems !== undefined) problems.push(`${path}: "prefixItems" (a tuple); ${TUPLE_HINT}`);
  if (node.additionalItems !== undefined) problems.push(`${path}: "additionalItems" (a tuple); ${TUPLE_HINT}`);
  return problems;
}

/**
 * The parts of a tool's `parameters` schema that not every model provider accepts, as `<path>: <problem>` lines
 * (`parameters.properties.region: ...`); `[]` when portable.
 */
export function schemaProblems(schema: unknown, path = "parameters"): string[] {
  if (!isNode(schema)) return [];
  const problems = ownProblems(schema, path);
  for (const key of SUBSCHEMA) {
    const sub = schema[key];
    if (Array.isArray(sub)) sub.forEach((s, i) => problems.push(...schemaProblems(s, `${path}.${key}[${i}]`)));
    else problems.push(...schemaProblems(sub, `${path}.${key}`));
  }
  for (const key of SUBSCHEMA_MAPS) {
    const map = schema[key];
    if (isNode(map)) for (const [name, sub] of Object.entries(map)) problems.push(...schemaProblems(sub, `${path}.${key}.${name}`));
  }
  for (const key of SUBSCHEMA_LISTS) {
    const list = schema[key];
    if (Array.isArray(list)) list.forEach((s, i) => problems.push(...schemaProblems(s, `${path}.${key}[${i}]`)));
  }
  return problems;
}

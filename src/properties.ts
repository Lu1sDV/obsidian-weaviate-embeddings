import { FilterOperator, NormalizedProperties, PropertyFilter, PropertyKind, PropertyRegistryData, RegistryField } from "./types";

const encoder = new TextEncoder();
const suffix: Record<PropertyKind, string> = {
  text: "t", number: "n", boolean: "b", date: "d", textArray: "ta", numberArray: "na", booleanArray: "ba", dateArray: "da", json: "j",
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function physicalName(key: string, kind: PropertyKind): Promise<string> {
  const encoded = encoder.encode(key);
  const stem = encoded.length <= 80 ? hex(encoded) : `h${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoded)))}`;
  return `p_${stem}_${suffix[kind]}`;
}

function normalizeDate(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2})))?$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) return undefined;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59 || Number(match[7] ?? 0) > 23 || Number(match[8] ?? 0) > 59)) return undefined;
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function scalarKind(value: unknown): PropertyKind {
  if (typeof value === "string") return normalizeDate(value) ? "date" : "text";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("Property contains a non-finite or unsafe number");
    return "number";
  }
  if (typeof value === "boolean") return "boolean";
  return "json";
}

function arrayKind(value: unknown[]): PropertyKind {
  if (value.every((item) => typeof item === "string" && normalizeDate(item) !== undefined)) return "dateArray";
  if (value.every((item) => typeof item === "string")) return "textArray";
  if (value.every((item) => typeof item === "number" && Number.isFinite(item))) return "numberArray";
  if (value.every((item) => typeof item === "boolean")) return "booleanArray";
  return "textArray";
}

function normalizeValue(value: unknown, kind: PropertyKind): string | number | boolean | string[] | number[] | boolean[] {
  if (kind === "json") return canonicalJson(value);
  if (kind === "date") return normalizeDate(value as string)!;
  if (kind === "dateArray") return (value as string[]).map((item) => normalizeDate(item)!);
  if (Array.isArray(value) && kind === "textArray" && !value.every((item) => typeof item === "string")) return value.map(canonicalJson);
  return value as string | number | boolean | string[] | number[] | boolean[];
}

export class PropertyRegistry {
  private readonly fields = new Map<string, RegistryField>();

  constructor(data: PropertyRegistryData = { fields: [] }) {
    for (const field of data.fields) this.fields.set(`${field.logicalKey}\0${field.kind}`, field);
  }

  data(): PropertyRegistryData { return { fields: [...this.fields.values()] }; }
  all(): RegistryField[] { return [...this.fields.values()]; }
  field(key: string, kind: PropertyKind): RegistryField | undefined { return this.fields.get(`${key}\0${kind}`); }

  async register(key: string, kind: PropertyKind): Promise<RegistryField> {
    const mapKey = `${key}\0${kind}`;
    const existing = this.fields.get(mapKey);
    if (existing) return existing;
    const field = { logicalKey: key, kind, physicalName: await physicalName(key, kind) };
    if ([...this.fields.values()].some((item) => item.physicalName === field.physicalName && item.logicalKey !== key)) throw new Error(`Property field collision for ${key}`);
    this.fields.set(mapKey, field);
    return field;
  }

  async normalize(frontmatter: Record<string, unknown> | undefined): Promise<NormalizedProperties> {
    const source = { ...(frontmatter ?? {}) };
    const result: NormalizedProperties = { frontmatterJson: canonicalJson(source), propertyKeys: [], nullPropertyKeys: [], emptyListPropertyKeys: [], tags: [], tagAncestors: [], fields: {} };
    for (const [key, value] of Object.entries(source)) {
      const encodedKey = hex(encoder.encode(key));
      result.propertyKeys.push(encodedKey);
      if (value === null) { result.nullPropertyKeys.push(encodedKey); continue; }
      if (Array.isArray(value) && value.length === 0) { result.emptyListPropertyKeys.push(encodedKey); continue; }
      const kind = Array.isArray(value) ? arrayKind(value) : scalarKind(value);
      const field = await this.register(key, kind);
      result.fields[field.physicalName] = normalizeValue(value, kind);
    }
    return result;
  }
}

const operatorMap: Partial<Record<FilterOperator, string>> = { eq: "Equal", ne: "NotEqual", gt: "GreaterThan", gte: "GreaterThanEqual", lt: "LessThan", lte: "LessThanEqual", containsAny: "ContainsAny", containsAll: "ContainsAll" };

export function compileFilters(registry: PropertyRegistry, filters: readonly PropertyFilter[]): Record<string, unknown> | undefined {
  const operands = filters.map((filter) => {
    const keyHex = hex(encoder.encode(filter.key));
    if (filter.operator === "missing") return { path: ["propertyKeys"], operator: "NotEqual", valueText: keyHex };
    if (filter.operator === "null") return { path: ["nullPropertyKeys"], operator: "ContainsAny", valueText: [keyHex] };
    if (filter.operator === "empty") return { path: ["emptyListPropertyKeys"], operator: "ContainsAny", valueText: [keyHex] };
    const field = registry.field(filter.key, filter.kind);
    if (!field) throw new Error(`Property ${filter.key} (${filter.kind}) is not registered`);
    const operator = operatorMap[filter.operator];
    if (!operator || filter.value === undefined) throw new Error(`Invalid ${filter.operator} filter`);
    const valueKey = filter.kind.includes("number") ? "valueNumber" : filter.kind.includes("boolean") ? "valueBoolean" : filter.kind.includes("date") ? "valueDate" : "valueText";
    return { path: [field.physicalName], operator, [valueKey]: filter.value };
  });
  if (operands.length === 0) return undefined;
  return operands.length === 1 ? operands[0] : { operator: "And", operands };
}

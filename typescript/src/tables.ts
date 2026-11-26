import { ValidationError } from "./errors.js";
import { isPlainObject, pyRepr, pyStr } from "./internal/py.js";
import { ALNUM_CLASS, lower, upper } from "./internal/unicode.js";
import { asInput } from "./models.js";
import { type ParsedSchema, Schema } from "./schema.js";
import { spaced, stem } from "./terms.js";
import { checkOptions, typeName } from "./validate.js";

const TYPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^_|\[|array|range/, "string"],
  [/bool/, "boolean"],
  [/json/, "json"],
  [/date|time/, "datetime"],
  [/(?<![a-z])u?(?:tiny|small|medium|big|huge|byte|var)?int(?:eger|\d*)(?![a-z])|serial/, "integer"],
  [/float|double|real|numeric|decimal|money/, "float"],
];
const WORD = new RegExp(`[${ALNUM_CLASS}]+`, "gu");

export interface FromTablesOptions {
  name?: string | null;
}

interface DraftRelation {
  type: string;
  from: { types: string[]; max_count: number };
  to: { types: string[] };
}

/**
 * Split a table or column name into lowercase words, dropping any schema qualifier.
 *
 * @param name (string): the name, such as sales.invoice_lines or InvoiceLines.
 * @return (string[]): the words.
 */
function words(name: string): string[] {
  return Array.from(spaced(name.slice(name.lastIndexOf(".") + 1)).matchAll(WORD), (m) => lower(m[0]));
}

/**
 * Name the entity type for a table: its words in PascalCase with the last one singular.
 *
 * @param table (string): the table name.
 * @return (string): the entity type name.
 */
function typeNameOf(table: string): string {
  const parts = words(table);
  if (!parts.length) throw new ValidationError(`tables: table name ${pyRepr(table)} has no letters or digits`);
  parts[parts.length - 1] = stem(parts[parts.length - 1]!);
  return parts
    .map((w) => {
      const [first = "", ...rest] = Array.from(w);
      return upper(first) + rest.join("");
    })
    .join("");
}

/**
 * Map a SQL column type to the nearest SelfGraph property type.
 *
 * @param sqlType (unknown): the column type text, or null.
 * @return (string): the property type, string when nothing closer fits.
 */
function propertyType(sqlType: unknown): string {
  const text = sqlType ? pyStr(sqlType).toLowerCase() : "";
  for (const [pattern, mapped] of TYPES) if (pattern.test(text)) return mapped;
  return "string";
}

/**
 * Draft a schema from relational table metadata: no rows are read and nothing is certified.
 *
 * Each table becomes an entity type named in singular PascalCase, with the table name as a synonym and a mapping to
 * the table. A column becomes a property mapped to the nearest SelfGraph type, required when it is not nullable. A
 * column that references another table becomes a relation type HAS_<COLUMN> from this table's type to the referenced
 * one, with a max_count of 1 on the from side.
 *
 * @param tables (readonly object[]): each table's name, optional description, and columns; a column holds a name and optional type, nullable, description, and references (a table name).
 * @param options (FromTablesOptions): name, the schema name.
 * @return (ParsedSchema): the draft schema.
 */
export function fromTables(tables: readonly object[], options: FromTablesOptions = {}): ParsedSchema {
  checkOptions("fromTables", options, ["name"]);
  if (!Array.isArray(tables)) {
    throw new ValidationError(`tables must be a list of table mappings, got ${typeName(tables)}`);
  }
  const names = new Map<string, string>();
  for (const [i, table] of tables.entries()) {
    if (!isPlainObject(table) || typeof table.name !== "string") {
      throw new ValidationError(`tables[${i}]: each table needs a name`);
    }
    names.set(table.name, typeNameOf(table.name));
  }
  const typeNames = [...names.values()];
  for (const [tableName, etype] of names) {
    if (tableName.includes(".") && typeNames.filter((name) => name === etype).length > 1) {
      names.set(tableName, typeNameOf(tableName.replaceAll(".", "_")));
    }
  }
  for (const [tableName, etype] of [...names]) {
    const bare = tableName.slice(tableName.lastIndexOf(".") + 1);
    if (!names.has(bare)) names.set(bare, etype);
  }
  const entities: unknown[] = [];
  const relations = new Map<string, DraftRelation>();
  for (const [i, table] of (tables as Array<Record<string, unknown>>).entries()) {
    const tableName = table.name as string;
    const etype = names.get(tableName)!;
    const properties: unknown[] = [];
    for (const [j, column] of ((table.columns || []) as unknown[]).entries()) {
      if (!isPlainObject(column) || typeof column.name !== "string") {
        throw new ValidationError(`tables[${i}].columns[${j}]: each column needs a name`);
      }
      const target = column.references;
      if (target != null) {
        const referenced = typeof target === "string" ? names.get(target) : undefined;
        if (referenced === undefined) {
          throw new ValidationError(`tables[${i}].columns[${j}].references: unknown table ${pyRepr(target)}`);
        }
        const own = words(column.name).filter((w) => w !== "id");
        const rtype = `HAS_${upper((own.length ? own : words(target as string)).join("_"))}`;
        let relation = relations.get(rtype);
        if (relation === undefined) {
          relation = { type: rtype, from: { types: [], max_count: 1 }, to: { types: [] } };
          relations.set(rtype, relation);
        }
        if (!relation.from.types.includes(etype)) relation.from.types.push(etype);
        if (!relation.to.types.includes(referenced)) relation.to.types.push(referenced);
        continue;
      }
      properties.push({
        name: column.name,
        type: propertyType(column.type),
        required: column.nullable === false,
        description: column.description ?? null,
      });
    }
    entities.push({
      name: etype,
      description: table.description ?? null,
      synonyms: [...new Set([words(tableName).join(" "), words(etype).join(" ")])],
      properties,
      mappings: [{ table: tableName }],
    });
  }
  return asInput(Schema, { name: options.name ?? null, entities, relations: [...relations.values()] }, "schema")!;
}

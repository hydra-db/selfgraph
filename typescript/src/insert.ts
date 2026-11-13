import type { GraphAccess } from "./access.js";
import { ExtractionError, errorMessage, SelfGraphError, ValidationError } from "./errors.js";
import { NERExtractor } from "./extraction/basic.js";
import { LLMExtractor } from "./extraction/extractor.js";
import { pyStrip } from "./internal/py.js";
import {
  asInput,
  type DateTimeInput,
  type Evidence,
  Extraction,
  ExtractionInstructions,
  ExtractionPrompts,
  type InsertResult,
  type InsertWarning,
  insertWarning,
  type JsonObject,
  type ParsedDocument,
  type ParsedExtraction,
  type Preference,
  parseOrThrow,
} from "./models.js";
import * as ops from "./ops.js";
import type { Extractor, LLMClient } from "./protocols.js";
import { recordSource } from "./provenance.js";
import {
  asResolver,
  type EntityResolver,
  mergeWarnings,
  planResolution,
  type ResolverMode,
  saveMerges,
} from "./resolution.js";
import {
  asSchema,
  type ContradictionMode,
  canonicalizeTypes,
  dropOffSchema,
  enforceSchema,
  type ParsedSchema,
  requireSchemaForMode,
  requireSchemaMode,
  type Schema,
  type SchemaMode,
} from "./schema.js";
import {
  checkOptions,
  isUnstorable,
  keysOf,
  parseTime,
  requireJsonMapping,
  requireOptionalText,
  typeName,
} from "./validate.js";

export interface InsertTextOptions {
  source_id?: string | null;
  event_time?: DateTimeInput | null;
  metadata?: JsonObject | null;
  instructions?: ExtractionInstructions | null;
  prompts?: ExtractionPrompts | null;
  schema?: Schema | ParsedSchema | null;
  schema_mode?: SchemaMode | null;
  resolver?: EntityResolver | ResolverMode | null;
  contradiction?: ContradictionMode | null;
}

export interface InsertFactsOptions {
  source_id?: string | null;
  event_time?: DateTimeInput | null;
  schema?: Schema | ParsedSchema | null;
  schema_mode?: SchemaMode | null;
  resolver?: EntityResolver | ResolverMode | null;
  contradiction?: ContradictionMode | null;
}

const FACTS_KEYS = keysOf<InsertFactsOptions>({
  source_id: true,
  event_time: true,
  schema: true,
  schema_mode: true,
  resolver: true,
  contradiction: true,
});
const TEXT_KEYS = keysOf<InsertTextOptions>({
  source_id: true,
  event_time: true,
  metadata: true,
  instructions: true,
  prompts: true,
  schema: true,
  schema_mode: true,
  resolver: true,
  contradiction: true,
});

export interface ExtractionSetup {
  llm: LLMClient | null;
  instructions: ExtractionInstructions | null;
  prompts: ExtractionPrompts | null;
  extractor: Extractor | null;
  resolver: EntityResolver | null;
}

interface Provenance {
  source_id: string | null;
  parsed_text: string;
  media_type: string;
  metadata: JsonObject | null;
  default_event_time: Date | null;
  warnings: InsertWarning[];
}

export class Insert {
  constructor(
    private readonly graph: GraphAccess,
    private readonly setup: ExtractionSetup,
  ) {}

  /**
   * Choose the extractor for one insert: custom, then LLM, then the LLM-free fallback.
   *
   * @param callInstructions (ExtractionInstructions | null): per-call extraction instructions.
   * @param callPrompts (ExtractionPrompts | null): per-call prompt overrides.
   * @param schema (ParsedSchema | null): the per-call schema, or null for the graph's.
   * @param sourceId (string | null): the source id the warnings belong to.
   * @return (Extractor): the extractor.
   */
  private extractorFor(
    callInstructions: ExtractionInstructions | null,
    callPrompts: ExtractionPrompts | null,
    schema: ParsedSchema | null,
    sourceId: string | null,
  ): Extractor {
    const { extractor, llm, prompts, instructions } = this.setup;
    if (extractor !== null) return extractor;
    if (llm === null) return new NERExtractor();
    return new LLMExtractor(llm, {
      prompts,
      instructions,
      call_prompts: callPrompts,
      call_instructions: callInstructions,
      schema: schema ?? this.graph.schema,
      source_id: sourceId,
    });
  }

  /**
   * Validate and write facts, with optional source provenance, in one store transaction.
   *
   * @param facts (ParsedExtraction): the parsed facts.
   * @param source (Provenance): the source and provenance fields, and the warnings to report.
   * @param schema (ParsedSchema | null): the per-call schema, or null for the graph's.
   * @param schemaMode (SchemaMode | null): the per-call schema mode, or null for the graph's.
   * @param resolver (EntityResolver | ResolverMode | null): the per-call entity resolver, or null for the graph's.
   * @param contradiction (ContradictionMode | null): the per-call contradiction mode, or null for the graph's.
   * @param extracted (boolean): the facts came from extraction, so strict mode drops what is off schema instead of throwing.
   * @return (InsertResult): the insert result.
   */
  private async apply(
    facts: ParsedExtraction,
    source: Provenance,
    schema: ParsedSchema | null,
    schemaMode: SchemaMode | null,
    resolver: EntityResolver | ResolverMode | null,
    contradiction: ContradictionMode | null,
    extracted = false,
  ): Promise<InsertResult> {
    const createdAt = new Date();
    const activeSchema = schema ?? this.graph.schema;
    const mode = schemaMode ?? this.graph.schemaMode;
    requireSchemaMode(mode);
    requireSchemaForMode(mode, activeSchema);
    const { contradiction: conflicts, caps } = this.graph.contradictionFor(contradiction, activeSchema);
    const activeResolver = resolver === null ? this.setup.resolver : asResolver(resolver, this.setup.llm);
    return this.graph.write(async (tx, ns) => {
      let canonical = await ops.validateFacts(tx, ns, facts, (o) => canonicalizeTypes(o, activeSchema));
      let dropped: InsertWarning[] = [];
      if (extracted && mode === "strict") [canonical, dropped] = await dropOffSchema(tx, ns, canonical, activeSchema);
      const maxCount = mode === "strict" && conflicts !== "off";
      const checked = await enforceSchema(tx, ns, canonical, activeSchema, mode, true, maxCount);
      const found: InsertWarning[] = [];
      const resolution =
        activeResolver === null
          ? null
          : await planResolution(tx, ns, canonical, activeResolver, activeSchema, createdAt);
      const resolved = resolution?.facts ?? canonical;
      if (mode === "strict" && conflicts === "warn") await ops.requireMaxCount(tx, ns, caps, resolved.relations);
      let sourceVersion: string | null = null;
      let baseEvidence: Evidence[] = [];

      if (source.source_id !== null) {
        [sourceVersion, baseEvidence] = await recordSource(tx, ns, {
          ...source,
          source_id: source.source_id,
          created_at: createdAt,
          event_time: source.default_event_time,
        });
      }

      const entities = await ops.upsertEntities(tx, ns, resolved.entities, [...baseEvidence], createdAt);
      const relations = await ops.upsertRelations(
        tx,
        ns,
        resolved.relations.map(
          (rel) => [rel, ops.relationEvidence(rel.evidence, baseEvidence, source.source_id, sourceVersion)] as const,
        ),
        source.default_event_time,
        createdAt,
        { contradiction: conflicts, caps, warnings: found },
      );

      const preferences: Preference[] = [];
      for (const pref of resolved.preferences) {
        preferences.push(await ops.upsertPreference(tx, ns, pref, source.default_event_time, createdAt));
      }

      const decisions = [];
      for (const dec of resolved.decisions) {
        decisions.push(
          await ops.upsertTrace(tx, ns, {
            tid: dec.id,
            title: dec.title,
            step_rel_ids: [...dec.steps],
            actor_entity: dec.actor_entity,
            summary: dec.summary,
            rationale: dec.rationale,
            outcome_entity: dec.outcome_entity,
            alternative_entities: [...dec.alternative_entities],
            status: dec.status,
            event_time: dec.event_time ?? source.default_event_time,
            created_at: createdAt,
          }),
        );
      }

      const merges = resolution === null ? [] : await saveMerges(tx, ns, resolution, source.source_id, createdAt);
      return {
        source_id: source.source_id,
        source_version: sourceVersion,
        created_at: createdAt,
        entities: ops.uniqueById(entities),
        relations: ops.uniqueById(relations),
        preferences: ops.uniqueById(preferences),
        decisions: ops.uniqueById(decisions),
        warnings: [
          ...source.warnings,
          ...dropped,
          ...checked,
          ...mergeWarnings(merges),
          ...(resolution?.warnings ?? []),
          ...found,
        ].map((w) => (w.source_id == null ? { ...w, source_id: source.source_id } : w)),
        merges,
      };
    });
  }

  private async extract(extractor: Extractor, document: ParsedDocument): Promise<ParsedExtraction> {
    let raw: Extraction;
    try {
      raw = await extractor.extract(document);
    } catch (exc) {
      if (exc instanceof SelfGraphError) throw exc;
      throw new ExtractionError(`extraction failed: ${errorMessage(exc)}`, { cause: exc });
    }
    return parseOrThrow(Extraction, raw, "facts from extractor");
  }

  /**
   * Extract facts from text and merge them into the graph in one transaction.
   *
   * @param text (string): the text to extract from.
   * @param options (InsertTextOptions): the source id, a default event time, source metadata, and per-call instructions or prompts.
   * @return (InsertResult): what was inserted.
   */
  async text(text: string, options: InsertTextOptions = {}): Promise<InsertResult> {
    if (typeof text !== "string") throw new ValidationError(`text must be a string, got ${typeName(text)}`);
    checkOptions("insert.text", options, TEXT_KEYS);
    if (isUnstorable(text)) {
      throw new ValidationError("text cannot contain NUL or unpaired surrogate characters");
    }
    requireOptionalText("source_id", options.source_id);
    requireJsonMapping("metadata", options.metadata);
    if (options.resolver != null) asResolver(options.resolver, this.setup.llm);
    const eventTime = parseTime(options.event_time, "event_time");
    if (!pyStrip(text)) throw new ValidationError("text cannot be empty or whitespace");
    const activeSchema = asSchema(options.schema);
    requireSchemaForMode(options.schema_mode ?? this.graph.schemaMode, activeSchema ?? this.graph.schema);
    const callInstructions = asInput(ExtractionInstructions, options.instructions, "instructions");
    const callPrompts = asInput(ExtractionPrompts, options.prompts, "prompts");
    const extractor = this.extractorFor(callInstructions, callPrompts, activeSchema, options.source_id ?? null);
    const document: ParsedDocument = { text, media_type: "text/plain", metadata: { ...(options.metadata ?? {}) } };
    const facts = await this.extract(extractor, document);
    const warnings: InsertWarning[] = extractor.popWarnings?.() ?? [];
    const { instructions, prompts } = this.setup;
    const customized = callInstructions || callPrompts || instructions || prompts;
    if (customized && !(extractor instanceof LLMExtractor)) {
      warnings.push(
        insertWarning(
          "prompts_ignored",
          "instructions and prompts apply only to LLM extraction, and no LLM is configured",
        ),
      );
    }
    return this.apply(
      facts,
      {
        source_id: options.source_id ?? null,
        parsed_text: text,
        media_type: document.media_type,
        metadata: options.metadata ?? null,
        default_event_time: eventTime,
        warnings,
      },
      activeSchema,
      options.schema_mode ?? null,
      options.resolver ?? null,
      options.contradiction ?? null,
      true,
    );
  }

  /**
   * Merge ready facts as idempotent upserts, validating every reference before any write.
   *
   * @param facts (Extraction): the facts object.
   * @param options (InsertFactsOptions): the source id to record provenance under, and event_time, the default event time for relations, preferences, and decisions that carry none of their own.
   * @return (InsertResult): what was inserted.
   */
  async facts(facts: Extraction, options: InsertFactsOptions = {}): Promise<InsertResult> {
    checkOptions("insert.facts", options, FACTS_KEYS);
    requireOptionalText("source_id", options.source_id);
    const eventTime = parseTime(options.event_time, "event_time");
    const parsed = parseOrThrow(Extraction, facts, "facts");
    return this.apply(
      parsed,
      {
        source_id: options.source_id ?? null,
        parsed_text: "",
        media_type: "application/octet-stream",
        metadata: null,
        default_event_time: eventTime,
        warnings: [],
      },
      asSchema(options.schema),
      options.schema_mode ?? null,
      options.resolver ?? null,
      options.contradiction ?? null,
    );
  }
}

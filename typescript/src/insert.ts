import type { GraphAccess } from "./access.js";
import { ExtractionError, errorMessage, SelfGraphError, ValidationError } from "./errors.js";
import { BasicExtractor } from "./extraction/basic.js";
import { DefaultExtractor } from "./extraction/extractor.js";
import { pyStrip } from "./internal/py.js";
import {
  type DateTimeInput,
  type Evidence,
  type ExtractionInstructions,
  type ExtractionPrompts,
  type InsertResult,
  type InsertWarning,
  type JsonObject,
  Ontology,
  type ParsedDocument,
  type ParsedOntology,
  parseDate,
  parseOrThrow,
} from "./models.js";
import * as ops from "./ops.js";
import type { Extractor, LLMClient } from "./protocols.js";
import { recordSource } from "./provenance.js";
import { hasSurrogate, pyTypeName, requireJsonMapping, requireOptionalText } from "./validate.js";

export interface InsertTextOptions {
  source_id?: string | null;
  event_time?: DateTimeInput | null;
  metadata?: JsonObject | null;
  instructions?: ExtractionInstructions | null;
  prompts?: ExtractionPrompts | null;
}

export interface ExtractionSetup {
  llm: LLMClient | null;
  instructions: ExtractionInstructions | null;
  prompts: ExtractionPrompts | null;
  extractor: Extractor | null;
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
   * @return (Extractor): the extractor.
   */
  private extractorFor(
    callInstructions: ExtractionInstructions | null,
    callPrompts: ExtractionPrompts | null,
  ): Extractor {
    const { extractor, llm, prompts, instructions } = this.setup;
    if (extractor !== null) return extractor;
    if (llm === null) return new BasicExtractor();
    return new DefaultExtractor(llm, {
      prompts,
      instructions,
      call_prompts: callPrompts,
      call_instructions: callInstructions,
    });
  }

  /**
   * Validate and write an ontology, with optional source provenance, in one store transaction.
   *
   * @param ontology (ParsedOntology): the parsed ontology.
   * @param source (Provenance): the source and provenance fields, and the warnings to report.
   * @return (InsertResult): the insert result.
   */
  private async apply(ontology: ParsedOntology, source: Provenance): Promise<InsertResult> {
    const createdAt = new Date();
    return this.graph.write(async (tx, ns) => {
      await ops.validateOntology(tx, ns, ontology);
      let sourceVersion: string | null = null;
      let baseEvidence: Evidence[] = [];

      if (source.source_id !== null) {
        [sourceVersion, baseEvidence] = await recordSource(tx, ns, {
          source_id: source.source_id,
          parsed_text: source.parsed_text,
          media_type: source.media_type,
          metadata: source.metadata,
          created_at: createdAt,
        });
      }

      const entities = [];
      for (const ent of ontology.entities) {
        entities.push(await ops.upsertEntity(tx, ns, ent, [...baseEvidence], createdAt));
      }

      const relations = [];
      for (const rel of ontology.relations) {
        const evidence = [...baseEvidence, ...ops.evidenceFromInputs(rel.evidence, sourceVersion)];
        relations.push(await ops.upsertRelation(tx, ns, rel, evidence, source.default_event_time, createdAt));
      }

      const preferences = [];
      for (const pref of ontology.preferences) {
        preferences.push(await ops.upsertPreference(tx, ns, pref, source.default_event_time, createdAt));
      }

      const decisions = [];
      for (const dec of ontology.decisions) {
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

      return {
        source_id: source.source_id,
        source_version: sourceVersion,
        created_at: createdAt,
        entities,
        relations,
        preferences,
        decisions,
        warnings: [...source.warnings],
      };
    });
  }

  private async extract(extractor: Extractor, document: ParsedDocument): Promise<ParsedOntology> {
    let raw: Ontology;
    try {
      raw = await extractor.extract(document);
    } catch (exc) {
      if (exc instanceof SelfGraphError) throw exc;
      throw new ExtractionError(`extraction failed: ${errorMessage(exc)}`, { cause: exc });
    }
    return parseOrThrow(Ontology, raw, "ontology from extractor");
  }

  /**
   * Extract an ontology from text and merge it into the graph in one transaction.
   *
   * @param text (string): the text to extract from.
   * @param options (InsertTextOptions): the source id, a default event time, source metadata, and per-call instructions or prompts.
   * @return (InsertResult): what was inserted.
   */
  async text(text: string, options: InsertTextOptions = {}): Promise<InsertResult> {
    if (typeof text !== "string") throw new ValidationError(`text must be a string, got ${pyTypeName(text)}`);
    if (hasSurrogate(text) || text.includes("\x00")) {
      throw new ValidationError("text cannot contain NUL or unpaired surrogate characters");
    }
    requireOptionalText("source_id", options.source_id);
    requireJsonMapping("metadata", options.metadata);
    const eventTime = parseDate(options.event_time);
    if (!pyStrip(text)) {
      return {
        source_id: options.source_id ?? null,
        source_version: null,
        created_at: new Date(),
        entities: [],
        relations: [],
        preferences: [],
        decisions: [],
        warnings: [
          { code: "empty_text", message: "text was empty; nothing was ingested", source_id: null, chunk_id: null },
        ],
      };
    }
    const extractor = this.extractorFor(options.instructions ?? null, options.prompts ?? null);
    const document: ParsedDocument = { text, media_type: "text/plain", metadata: {} };
    const ontology = await this.extract(extractor, document);
    const warnings: InsertWarning[] = extractor.popWarnings?.() ?? [];
    return this.apply(ontology, {
      source_id: options.source_id ?? null,
      parsed_text: text,
      media_type: document.media_type,
      metadata: options.metadata ?? null,
      default_event_time: eventTime,
      warnings,
    });
  }

  /**
   * Merge a ready ontology as idempotent upserts, validating every reference before any write.
   *
   * @param ontology (Ontology): the ontology object.
   * @param options ({ source_id?: string | null }): the source id to record provenance under.
   * @return (InsertResult): what was inserted.
   */
  async ontology(ontology: Ontology, options: { source_id?: string | null } = {}): Promise<InsertResult> {
    requireOptionalText("source_id", options.source_id);
    const parsed = parseOrThrow(Ontology, ontology, "ontology");
    return this.apply(parsed, {
      source_id: options.source_id ?? null,
      parsed_text: "",
      media_type: "application/octet-stream",
      metadata: null,
      default_event_time: null,
      warnings: [],
    });
  }
}

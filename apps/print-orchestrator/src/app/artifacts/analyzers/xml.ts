import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Hardened XML parsing for the untrusted 3MF payload.
 *
 * The attack surface for XML is DTDs and external/parameter entities — XXE and
 * the "billion laughs" expansion bomb. Two independent guards close it:
 *
 *   1. A pre-scan rejects any `<!DOCTYPE` or `<!ENTITY` before the parser ever
 *      sees the document. A well-formed 3MF model has neither; refusing them
 *      outright is the strongest, simplest defense and cannot be bypassed by a
 *      parser quirk.
 *   2. {@link fast-xml-parser} is configured with `processEntities: false`, so
 *      even the predefined entities are not expanded and there is no entity
 *      machinery to abuse. It performs no network or filesystem access of its
 *      own, so external-DTD fetches are impossible regardless.
 *
 * A byte-size cap keeps a merely-huge (non-bomb) document from exhausting memory.
 */

/** A structured, machine-branchable XML-safety failure (→ analysis blocker). */
export class XmlSafetyError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "XmlSafetyError";
  }
}

const DOCTYPE_RE = /<!DOCTYPE/i;
const ENTITY_RE = /<!ENTITY/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // No entity expansion at all — removes the XXE / billion-laughs machinery.
  processEntities: false,
  // Keep numeric-looking ids/values as strings; we coerce explicitly where needed.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true
});

/**
 * Parses trusted-shape but untrusted-content XML into a plain object, after the
 * DOCTYPE/ENTITY and size guards. Throws {@link XmlSafetyError} when a guard
 * trips or the document is not well-formed.
 */
export function parseSafeXml(text: string, maxBytes: number): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new XmlSafetyError(`XML превышает лимит ${maxBytes} Б`, "xml_too_large");
  }
  if (DOCTYPE_RE.test(text)) {
    throw new XmlSafetyError("XML содержит запрещённый DOCTYPE", "xml_doctype");
  }
  if (ENTITY_RE.test(text)) {
    throw new XmlSafetyError("XML содержит запрещённое объявление ENTITY", "xml_entity");
  }
  // fast-xml-parser is lenient by default; validate first so malformed XML is a
  // hard error (→ analysis blocker) rather than a silently mis-parsed document.
  if (XMLValidator.validate(text, { allowBooleanAttributes: true }) !== true) {
    throw new XmlSafetyError("Некорректный XML", "xml_malformed");
  }
  try {
    return parser.parse(text);
  } catch {
    throw new XmlSafetyError("Некорректный XML", "xml_malformed");
  }
}

/** Normalizes fast-xml-parser's "one child or an array of children" into an array. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

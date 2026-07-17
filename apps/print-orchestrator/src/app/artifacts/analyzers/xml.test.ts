import assert from "node:assert/strict";
import { test } from "node:test";

import { asArray, parseSafeXml, XmlSafetyError } from "./xml";

test("parses well-formed XML into attributes and children", () => {
  const parsed = parseSafeXml('<model unit="millimeter"><object id="1"/></model>', 1024) as {
    model: { "@_unit": string; object: { "@_id": string } };
  };
  assert.equal(parsed.model["@_unit"], "millimeter");
  assert.equal(parsed.model.object["@_id"], "1");
});

test("rejects a DOCTYPE (XXE / billion-laughs vector)", () => {
  const evil = '<?xml version="1.0"?><!DOCTYPE root [<!ENTITY x "y">]><root/>';
  assert.throws(() => parseSafeXml(evil, 4096), (e: XmlSafetyError) => e.code === "xml_doctype");
});

test("rejects a standalone ENTITY declaration", () => {
  const evil = '<root><!ENTITY foo "bar">text</root>';
  assert.throws(() => parseSafeXml(evil, 4096), (e: XmlSafetyError) => e.code === "xml_entity");
});

test("rejects an oversized document before parsing", () => {
  assert.throws(
    () => parseSafeXml("<a>" + "x".repeat(100) + "</a>", 10),
    (e: XmlSafetyError) => e.code === "xml_too_large"
  );
});

test("rejects malformed XML", () => {
  assert.throws(() => parseSafeXml("<a><b></a>", 4096), (e: XmlSafetyError) => e.code === "xml_malformed");
});

test("asArray normalizes single/array/undefined children", () => {
  assert.deepEqual(asArray(undefined), []);
  assert.deepEqual(asArray("x"), ["x"]);
  assert.deepEqual(asArray(["a", "b"]), ["a", "b"]);
});

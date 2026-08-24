import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvRecipients, renderTemplate } from "../src/emailAutomation.js";

test("parseCsvRecipients validates, deduplicates, and preserves merge fields", () => {
  const rows = parseCsvRecipients('email,first_name,company\nAlice@example.com,Alice,Acme\nalice@example.com,Alice Duplicate,Acme\n"bob@example.com",Bob,Bravo');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, "alice@example.com");
  assert.equal(rows[0].data.first_name, "Alice");
  assert.equal(rows[1].data.company, "Bravo");
});

test("parseCsvRecipients requires an email column and valid unique recipient", () => {
  assert.throws(() => parseCsvRecipients("name,company\nAlice,Acme"), /email` column/);
  assert.throws(() => parseCsvRecipients("email,company\nnot-an-email,Acme"), /valid, unique/);
});

test("parseCsvRecipients enforces the campaign row cap", () => {
  assert.throws(() => parseCsvRecipients("email\n" + Array.from({ length: 3 }, (_, index) => `person${index}@example.com`).join("\n"), 2), /2-recipient/);
});

test("renderTemplate replaces known merge fields and leaves missing fields empty", () => {
  assert.equal(renderTemplate("Hello {{first_name}} at {{company}} {{missing}}", { first_name: "Ada", company: "Acme" }), "Hello Ada at Acme");
});

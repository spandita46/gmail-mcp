import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { gmail_v1 } from "@googleapis/gmail";
import { cleanText, decodeBase64Url, decodeEntities, extractMessage, htmlToText, truncate } from "../src/mime.js";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
type Part = gmail_v1.Schema$MessagePart;

describe("decodeBase64Url", () => {
  it("round-trips Unicode", () => assert.equal(decodeBase64Url(b64("Héllo ₹ ✓ 🎉")), "Héllo ₹ ✓ 🎉"));
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () =>
    assert.equal(decodeEntities("It&#39;s &quot;ok&quot; &lt;b&gt; &#x2713;&nbsp;&apos;x&apos;"), `It's "ok" <b> ✓ 'x'`));
  it("decodes &amp; last, so double-escaped text stays escaped once", () => assert.equal(decodeEntities("&amp;lt;"), "&lt;"));
});

describe("cleanText", () => {
  it("strips invisible padding characters used by marketing emails", () =>
    assert.equal(cleanText("Deals͏ ‌​ inside﻿"), "Deals inside"));
  it("collapses spaces and trims", () => assert.equal(cleanText("  a   b  "), "a b"));
});

describe("htmlToText", () => {
  it("drops head/style/script/comments and keeps visible text", () => {
    const text = htmlToText("<html><head><title>T</title><style>.x{}</style></head><body><script>evil()</script><!-- c --><p>Hi</p></body></html>");
    assert.equal(text, "Hi");
  });
  it("turns blocks and <br> into line breaks and <li> into bullets", () =>
    assert.equal(htmlToText("<h1>Title</h1><p>One<br>Two</p><ul><li>A</li><li>B</li></ul>"), "Title\nOne\nTwo\n\n- A\n\n- B"));
  it("decodes entities after stripping tags", () => assert.equal(htmlToText("<p>Tom &amp; Jerry</p>"), "Tom & Jerry"));
});

describe("extractMessage", () => {
  const multipart: Part = {
    mimeType: "multipart/mixed",
    headers: [
      { name: "from", value: "CDSL <e@x.com>" },
      { name: "SUBJECT", value: "CAS" },
      { name: "X-Junk", value: "ignored" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64("Dear ROSHAN LAL,\r\n\r\n\r\n\r\nYour   statement is attached.") } },
          { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "CAS.pdf", body: { size: 315580, attachmentId: "ATT1" } },
    ],
  };

  it("normalises header names and drops unwanted headers", () =>
    assert.deepEqual(extractMessage(multipart).headers, { From: "CDSL <e@x.com>", Subject: "CAS" }));
  it("prefers text/plain over text/html in nested parts", () => {
    const m = extractMessage(multipart);
    assert.equal(m.bodySource, "text/plain");
    assert.equal(m.body, "Dear ROSHAN LAL,\n\nYour statement is attached.");
  });
  it("lists attachments without treating them as body", () =>
    assert.deepEqual(extractMessage(multipart).attachments, [
      { filename: "CAS.pdf", mimeType: "application/pdf", size: 315580, attachmentId: "ATT1" },
    ]));
  it("falls back to HTML when there is no plain part", () => {
    const m = extractMessage({ mimeType: "text/html", body: { data: b64("<p>Only &amp; HTML</p>") } });
    assert.equal(m.bodySource, "text/html");
    assert.equal(m.body, "Only & HTML");
  });
  it("a text/plain attachment is still an attachment, not body", () => {
    const m = extractMessage({
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/plain", filename: "notes.txt", body: { data: b64("secret"), size: 6 } }],
    });
    assert.equal(m.bodySource, "none");
    assert.equal(m.attachments[0]?.filename, "notes.txt");
  });
  it("handles an undefined payload", () =>
    assert.deepEqual(extractMessage(undefined), { headers: {}, body: "", bodySource: "none", attachments: [] }));
});

describe("truncate", () => {
  it("leaves short text alone", () => assert.deepEqual(truncate("abc", 5), { text: "abc", truncated: false }));
  it("cuts long text and says so", () => assert.deepEqual(truncate("abcdef", 3), { text: "abc", truncated: true }));
  it("text exactly at the limit is not truncated", () => assert.equal(truncate("abc", 3).truncated, false));
});

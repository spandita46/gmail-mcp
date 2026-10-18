import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQuery } from "../src/tools/shared.js";

describe("buildQuery", () => {
  it("passes a plain query through, in parentheses", () => assert.equal(buildQuery("is:unread"), "(is:unread)"));
  it("groups an OR query so date filters apply to all of it (regression)", () =>
    assert.equal(buildQuery("from:a OR from:b", "2026-10-17"), "(from:a OR from:b) after:1792209600"));
  it("adds before: for until", () => assert.equal(buildQuery("x", undefined, "2026-10-18"), "(x) before:1792296000"));
  it("an empty query with since is just the date filter", () => assert.equal(buildQuery("  ", "2026-10-17"), "after:1792209600"));
  it("an empty query with nothing else is empty", () => assert.equal(buildQuery(""), ""));
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateSenders,
  cleanHeader,
  mergeUnsubscribe,
  parseDate,
  parseListUnsubscribe,
  parseSender,
  type ScannedMessage,
} from "../src/cleanup.js";

const msg = (overrides: Partial<ScannedMessage>): ScannedMessage => ({
  account: "primary",
  from: "Cobone <e@cobone.com>",
  date: "Sat, 17 Oct 2026 10:00:00 +0000",
  listUnsubscribe: "",
  listUnsubscribePost: "",
  ...overrides,
});

describe("cleanHeader", () => {
  it("removes newlines and control characters (header injection)", () =>
    assert.equal(cleanHeader("Evil\r\nBcc: x@y.com\u0007"), "Evil Bcc: x@y.com"));
  it("removes zero-width / format characters", () => assert.equal(cleanHeader("Pay​pal"), "Pay pal"));
  it("caps length with an ellipsis", () => assert.equal(cleanHeader("abcdefghij", 5), "abcd…"));
});

describe("parseSender", () => {
  const cases: [string, { name: string; address: string }][] = [
    ["Cobone Dubai <emails@m.cobone.com>", { name: "Cobone Dubai", address: "emails@m.cobone.com" }],
    ['"Clutch" <Hello@Mailer.Clutch.ca>', { name: "Clutch", address: "hello@mailer.clutch.ca" }],
    ['"Doe, John" <j@d.com>', { name: "Doe, John", address: "j@d.com" }],
    ["noreply@x.com", { name: "noreply@x.com", address: "noreply@x.com" }],
    ["<only@angle.com>", { name: "only@angle.com", address: "only@angle.com" }],
  ];
  for (const [input, expected] of cases) it(JSON.stringify(input), () => assert.deepEqual(parseSender(input), expected));
});

describe("parseDate", () => {
  it("parses a normal Date header", () => assert.equal(parseDate("Sun, 18 Oct 2026 03:31:13 +0000"), Date.parse("2026-10-18T03:31:13Z")));
  it("strips a trailing (UTC) comment that Date.parse rejects", () =>
    assert.equal(parseDate("Sun, 18 Oct 2026 04:06:54 +0000 (UTC)"), Date.parse("2026-10-18T04:06:54Z")));
  it("returns undefined for garbage", () => assert.equal(parseDate("not a date"), undefined));
});

describe("parseListUnsubscribe", () => {
  it("takes https and mailto, detects one-click", () =>
    assert.deepEqual(parseListUnsubscribe("<mailto:u@x.com?subject=unsub>, <https://x.com/u?id=1>", "List-Unsubscribe=One-Click"), {
      url: "https://x.com/u?id=1",
      mailto: "mailto:u@x.com?subject=unsub",
      oneClick: true,
    }));
  it("one-click needs an https link", () => assert.equal(parseListUnsubscribe("<mailto:u@x.com>", "List-Unsubscribe=One-Click")?.oneClick, false));
  it("rejects plain http links", () => assert.equal(parseListUnsubscribe("<http://insecure.com/u>", ""), undefined));
  it("rejects javascript: and other schemes", () => assert.equal(parseListUnsubscribe("<javascript:alert(1)>", ""), undefined));
  it("rejects links with whitespace or control characters", () => assert.equal(parseListUnsubscribe("<https://x.com/a b>", ""), undefined));
  it("rejects links over 1000 characters", () => assert.equal(parseListUnsubscribe(`<https://x.com/${"a".repeat(1000)}>`, ""), undefined));
  it("empty header → undefined", () => assert.equal(parseListUnsubscribe("", ""), undefined));
});

describe("mergeUnsubscribe", () => {
  const mailtoOnly = { mailto: "mailto:a@x.com", oneClick: false };
  const https = { url: "https://x.com/u", oneClick: false };
  const oneClick = { url: "https://x.com/1", oneClick: true };
  it("prefers one-click > https > mailto", () => {
    assert.equal(mergeUnsubscribe(mailtoOnly, https)?.url, "https://x.com/u");
    assert.equal(mergeUnsubscribe(https, oneClick)?.url, "https://x.com/1");
    assert.equal(mergeUnsubscribe(oneClick, https)?.url, "https://x.com/1");
  });
  it("keeps a mailto fallback from the weaker option", () => assert.equal(mergeUnsubscribe(mailtoOnly, oneClick)?.mailto, "mailto:a@x.com"));
  it("on a tie, keeps the existing (newer) option", () =>
    assert.equal(mergeUnsubscribe({ url: "https://new", oneClick: true }, { url: "https://old", oneClick: true })?.url, "https://new"));
  it("handles undefined on either side", () => {
    assert.equal(mergeUnsubscribe(undefined, https), https);
    assert.equal(mergeUnsubscribe(https, undefined), https);
  });
});

describe("aggregateSenders", () => {
  it("groups by address case-insensitively, counts per account, ranks by volume", () => {
    const result = aggregateSenders(
      [
        msg({}),
        msg({ from: "Cobone <E@COBONE.com>" }),
        msg({ account: "secondary" }),
        msg({ account: "secondary", from: "Clutch <hello@clutch.ca>" }),
      ],
      5,
    );
    assert.equal(result.length, 2);
    assert.equal(result[0]?.address, "e@cobone.com");
    assert.equal(result[0]?.total, 3);
    assert.deepEqual(result[0]?.byAccount, { primary: 2, secondary: 1 });
  });

  it("keeps the newest date as `latest`", () => {
    const [s] = aggregateSenders(
      [msg({ date: "Fri, 16 Oct 2026 10:00:00 +0000" }), msg({ date: "Sun, 18 Oct 2026 03:31:13 +0000" })],
      5,
    );
    assert.equal(s?.latest, "Sun, 18 Oct 2026 03:31:13 +0000");
  });

  it("prefers Gmail's internalDate over the Date header", () => {
    const [s] = aggregateSenders(
      [msg({ date: "Fri, 16 Oct 2026 10:00:00 +0000", internalDate: Date.parse("2026-10-18T00:00:00Z") }), msg({ date: "Sat, 17 Oct 2026 10:00:00 +0000" })],
      5,
    );
    assert.equal(s?.latest, "Fri, 16 Oct 2026 10:00:00 +0000");
  });

  it("uses an ISO date when the first message has no Date header (regression)", () => {
    const [s] = aggregateSenders([msg({ date: "", internalDate: 1792209600000 })], 5);
    assert.equal(s?.latest, "2026-10-17T04:00:00.000Z");
  });

  it("an unreadable date doesn't replace a good one", () => {
    const [s] = aggregateSenders([msg({ date: "Sat, 17 Oct 2026 10:00:00 +0000" }), msg({ date: "garbage" })], 5);
    assert.equal(s?.latest, "Sat, 17 Oct 2026 10:00:00 +0000");
  });

  it("builds a plain Gmail query for a normal address", () =>
    assert.equal(aggregateSenders([msg({})], 5)[0]?.gmailQuery, "from:e@cobone.com"));

  it("quotes a crafted address so it can't add Gmail operators (regression)", () =>
    assert.equal(aggregateSenders([msg({ from: "Evil <a@b.com OR in:anywhere>" })], 5)[0]?.gmailQuery, 'from:"a@b.com or in:anywhere"'));

  it("picks the best unsubscribe option across a sender's messages", () => {
    const [s] = aggregateSenders(
      [
        msg({ listUnsubscribe: "<mailto:u@cobone.com>" }),
        msg({ listUnsubscribe: "<https://cobone.com/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" }),
      ],
      5,
    );
    assert.deepEqual(s?.unsubscribe, { url: "https://cobone.com/u", oneClick: true, mailto: "mailto:u@cobone.com" });
  });

  it("returns at most `top` senders", () => {
    const many = [...Array(10).keys()].map((i) => msg({ from: `S${i} <s${i}@x.com>` }));
    assert.equal(aggregateSenders(many, 3).length, 3);
  });

  it("skips messages with an empty From", () => assert.equal(aggregateSenders([msg({ from: "" })], 5).length, 0));
});

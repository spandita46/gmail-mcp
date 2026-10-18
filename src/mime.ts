// "import type": only the Gmail type definitions are needed, not the library itself.
import type { gmail_v1 } from "@googleapis/gmail";

type Part = gmail_v1.Schema$MessagePart; // one node in the MIME tree

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number; // bytes
  attachmentId: string; // needed later if we ever download attachments
}

export interface ExtractedMessage {
  headers: Record<string, string>;
  body: string;
  bodySource: "text/plain" | "text/html" | "none"; // where the text came from, useful for debugging
  attachments: Attachment[];
}

// Only the headers worth showing. A real email has dozens (Received, DKIM, X-…).
const WANTED_HEADERS = ["From", "To", "Cc", "Date", "Subject", "Reply-To", "Message-ID"];

export function extractMessage(payload: Part | undefined): ExtractedMessage {
  // Normalise header names: emails can send "subject" or "SUBJECT", and we store "Subject".
  const headers: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    const name = WANTED_HEADERS.find((w) => w.toLowerCase() === h.name?.toLowerCase());
    if (name && h.value) headers[name] = h.value;
  }

  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Attachment[] = [];

  walk(payload, (part) => {
    const mime = part.mimeType ?? "";
    // A filename means it's an attachment, even if it's a text/plain file. Don't treat it as body text.
    if (part.filename) {
      attachments.push({
        filename: part.filename,
        mimeType: mime,
        size: part.body?.size ?? 0,
        attachmentId: part.body?.attachmentId ?? "",
      });
      return;
    }
    const data = part.body?.data;
    if (!data) return; // container nodes (multipart/*) have children but no data of their own
    if (mime === "text/plain") plain.push(decodeBase64Url(data));
    else if (mime === "text/html") html.push(decodeBase64Url(data));
  });

  // Prefer plain text: it's what the sender wrote, without markup. HTML is the fallback.
  if (plain.length > 0) return { headers, body: tidy(plain.join("\n\n")), bodySource: "text/plain", attachments };
  if (html.length > 0) return { headers, body: htmlToText(html.join("\n")), bodySource: "text/html", attachments };
  return { headers, body: "", bodySource: "none", attachments };
}

// Depth-first walk: visit this part, then each child.
function walk(part: Part | undefined, visit: (p: Part) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

// Gmail uses base64url (- and _ instead of + and /). Node understands it directly.
export function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

// HTML entities → characters. &amp; goes last so "&amp;lt;" becomes "&lt;" and not "<".
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))) // &#x2713; → ✓
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec))) // &#39; → '
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// A deliberately simple HTML → text converter. It's good enough for an LLM to read,
// with no dependency. (Exercise: keep link URLs as "text (url)".)
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "") // drop non-visible blocks along with their content
    .replace(/<!--[\s\S]*?-->/g, "") // drop comments
    .replace(/<br\s*\/?>/gi, "\n") // line breaks
    .replace(/<li[^>]*>/gi, "\n- ") // list items → bullets
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, "\n") // block ends → newline
    .replace(/<[^>]+>/g, ""); // strip all remaining tags
  return tidy(decodeEntities(text));
}

// For snippets and other short text: decode entities, then tidy up.
export function cleanText(text: string): string {
  return tidy(decodeEntities(text));
}

// Normalise whitespace and remove invisible characters that marketing emails use as padding.
function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n") // Windows line endings
    .replace(/[͏​-‏⁠﻿­]/g, "") // zero-width chars, combining grapheme joiner, soft hyphen
    .replace(/[ \t]+/g, " ") // runs of spaces → one
    .replace(/ *\n */g, "\n") // trim spaces around line breaks
    .replace(/\n{3,}/g, "\n\n") // at most one blank line
    .trim();
}

// Long newsletters can be 50k+ characters. Cap them, and say when we did.
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length <= maxChars ? { text, truncated: false } : { text: text.slice(0, maxChars), truncated: true };
}

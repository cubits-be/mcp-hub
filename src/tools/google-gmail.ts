import { google } from "googleapis";
import type { CustomTool } from "../types.js";
import { loadOAuthClient, resolveCredDir } from "./google-oauth.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getGmail() {
  const credDir = resolveCredDir("GOOGLE_MCP_DIR", ".google-mcp");
  const auth = loadOAuthClient(credDir);
  return google.gmail({ version: "v1", auth });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Decode a base64url-encoded Gmail message part body. */
function decodeBody(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type MimePart = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: MimePart[] | null;
};

/** Extract plain-text or HTML body from a message payload, recursing into nested multipart/* containers. */
function extractBody(payload: MimePart | null | undefined): string {
  if (!payload) return "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  const parts = payload.parts ?? [];

  // Prefer plain text at any depth before falling back to HTML.
  const plain = findPart(parts, "text/plain");
  if (plain) return decodeBody(plain);

  const html = findPart(parts, "text/html");
  if (html) return decodeBody(html);

  return "";
}

/** Depth-first search for a part with the given mimeType, returning its body data. */
function findPart(parts: MimePart[], mimeType: string): string | null {
  for (const part of parts) {
    if (part.mimeType === mimeType && part.body?.data) return part.body.data;
    if (part.mimeType?.startsWith("multipart/") && part.parts?.length) {
      const nested = findPart(part.parts, mimeType);
      if (nested) return nested;
    }
  }
  return null;
}

/** Extract a header value by name from a message payload. */
function header(
  payload: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null | undefined,
  name: string
): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const listLabelsTool: CustomTool = {
  definition: {
    name: "gmail__list_labels",
    description: "Lists all Gmail labels (folders) in the account.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: async () => {
    const gmail = getGmail();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels ?? [];
    return text(
      labels.map((l) => `${l.id}  ${l.name}  [${l.type}]`).join("\n")
    );
  },
};

const listMessagesSummaryTool: CustomTool = {
  definition: {
    name: "gmail__list_messages_summary",
    description:
      "Lists Gmail messages returning only sender (from) and subject — no message body or attachments. " +
      "Use the 'query' parameter for Gmail search syntax (e.g. 'is:unread', 'in:inbox', 'from:boss@example.com').",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query (default: 'in:inbox'). Examples: 'is:unread', 'from:boss@example.com', 'subject:invoice'",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of messages to return (default: 10)",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    const query = (args.query as string | undefined) ?? "in:inbox";
    const maxResults = (args.maxResults as number | undefined) ?? 10;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) return text("No messages found.");

    const details = await Promise.all(
      messages.map((m) =>
        gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        })
      )
    );

    const lines = details.map((res, i) => {
      const from = header(res.data.payload, "from");
      const subject = header(res.data.payload, "subject");
      const date = header(res.data.payload, "date");
      return `${i + 1}. [${res.data.id}]\n   From: ${from}\n   Subject: ${subject}\n   Date: ${date}`;
    });
    return text(lines.join("\n\n"));
  },
};

const getEmailTool: CustomTool = {
  definition: {
    name: "gmail__get_email",
    description: "Retrieves the full content of a Gmail message by ID.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID" },
      },
      required: ["messageId"],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    const res = await gmail.users.messages.get({
      userId: "me",
      id: args.messageId as string,
      format: "full",
    });
    const msg = res.data;
    const from = header(msg.payload, "from");
    const to = header(msg.payload, "to");
    const subject = header(msg.payload, "subject");
    const date = header(msg.payload, "date");
    const body = extractBody(msg.payload);
    return text(
      `ID: ${msg.id}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n\n${body}`
    );
  },
};

const sendEmailTool: CustomTool = {
  definition: {
    name: "gmail__send_email",
    description: "Sends an email from the authenticated Gmail account.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es), comma-separated" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Email body (plain text)" },
        cc: { type: "string", description: "CC address(es), comma-separated" },
        replyTo: { type: "string", description: "Reply-To header" },
      },
      required: ["to", "subject", "body"],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    const lines = [
      `To: ${args.to as string}`,
      ...(args.cc ? [`Cc: ${args.cc as string}`] : []),
      ...(args.replyTo ? [`Reply-To: ${args.replyTo as string}`] : []),
      `Subject: ${args.subject as string}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      args.body as string,
    ];
    const raw = Buffer.from(lines.join("\r\n"))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    return text(`Email sent. Message ID: ${res.data.id}`);
  },
};

const draftEmailTool: CustomTool = {
  definition: {
    name: "gmail__draft_email",
    description: "Creates a draft email in Gmail. Supports plain text and/or HTML body.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address(es)" },
        subject: { type: "string", description: "Email subject" },
        body: { type: "string", description: "Plain-text email body" },
        html: { type: "string", description: "HTML email body. When provided alongside body, a multipart/alternative email is created with both versions. When provided alone, an HTML-only email is created." },
        cc: { type: "string", description: "CC address(es)" },
      },
      required: ["to", "subject"],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    const to = args.to as string;
    const subject = args.subject as string;
    const cc = args.cc as string | undefined;
    const body = args.body as string | undefined;
    const html = args.html as string | undefined;

    let mimeLines: string[];

    if (html && body) {
      // multipart/alternative: plain text + HTML
      const boundary = `boundary_${Date.now().toString(16)}`;
      mimeLines = [
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
        "",
        `--${boundary}`,
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
        "",
        `--${boundary}--`,
      ];
    } else if (html) {
      mimeLines = [
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${subject}`,
        `MIME-Version: 1.0`,
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
      ];
    } else {
      mimeLines = [
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body ?? "",
      ];
    }

    const raw = Buffer.from(mimeLines.join("\r\n"))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });
    return text(`Draft created. Draft ID: ${res.data.id}`);
  },
};

const modifyEmailTool: CustomTool = {
  definition: {
    name: "gmail__modify_email",
    description:
      "Modifies Gmail label assignments on a message. Use to archive (remove INBOX), " +
      "mark read (remove UNREAD), star, move to trash (add TRASH), etc.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID" },
        addLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to add (e.g. STARRED, TRASH, UNREAD)",
        },
        removeLabelIds: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to remove (e.g. UNREAD, INBOX)",
        },
      },
      required: ["messageId"],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    await gmail.users.messages.modify({
      userId: "me",
      id: args.messageId as string,
      requestBody: {
        addLabelIds: (args.addLabelIds as string[] | undefined) ?? [],
        removeLabelIds: (args.removeLabelIds as string[] | undefined) ?? [],
      },
    });
    return text(`Message ${args.messageId as string} modified.`);
  },
};

const deleteEmailTool: CustomTool = {
  definition: {
    name: "gmail__delete_email",
    description: "Permanently deletes a Gmail message. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Gmail message ID to delete" },
      },
      required: ["messageId"],
    },
  },
  handler: async (args) => {
    const gmail = getGmail();
    await gmail.users.messages.delete({ userId: "me", id: args.messageId as string });
    return text(`Message ${args.messageId as string} permanently deleted.`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const googleGmailTools: CustomTool[] = [
  listLabelsTool,
  listMessagesSummaryTool,
  getEmailTool,
  // sendEmailTool,   // disabled
  draftEmailTool,
  // modifyEmailTool, // disabled
  // deleteEmailTool, // disabled
];

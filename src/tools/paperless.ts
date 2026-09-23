import type { CustomTool } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PAPERLESS_URL = (process.env.PAPERLESS_URL ?? "http://192.168.1.12:8000").replace(/\/$/, "");
const PAPERLESS_API_TOKEN = process.env.PAPERLESS_API_TOKEN;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function paperlessGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  if (!PAPERLESS_API_TOKEN) throw new Error("PAPERLESS_API_TOKEN is not set");
  const url = new URL(`${PAPERLESS_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { headers: { Authorization: `Token ${PAPERLESS_API_TOKEN}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`paperless HTTP ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Taxonomy (tags / correspondents / document types)
// ---------------------------------------------------------------------------

interface NamedEntity {
  id: number;
  name: string;
}

/** Fetches every item of a paginated taxonomy endpoint. */
async function paperlessGetAll(endpoint: string): Promise<NamedEntity[]> {
  const items: NamedEntity[] = [];
  for (let page = 1; ; page++) {
    const res = await paperlessGet<{ count: number; next: string | null; results: NamedEntity[] }>(endpoint, {
      page,
      page_size: 100,
    });
    items.push(...res.results);
    if (!res.next || !res.results.length) return items;
  }
}

type NameMap = Map<number, string>;
interface TaxonomyNames {
  tags: NameMap;
  correspondents: NameMap;
  documentTypes: NameMap;
}

/** Id → name lookups are cached briefly so listing/searching doesn't refetch taxonomy on every call. */
const NAMES_TTL_MS = 5 * 60 * 1000;
let namesCache: { at: number; names: Promise<TaxonomyNames> } | undefined;

async function loadNames(): Promise<TaxonomyNames> {
  const toMap = (items: NamedEntity[]): NameMap => new Map(items.map((i) => [i.id, i.name]));
  const [tags, correspondents, documentTypes] = await Promise.all([
    paperlessGetAll("/api/tags/"),
    paperlessGetAll("/api/correspondents/"),
    paperlessGetAll("/api/document_types/"),
  ]);
  return { tags: toMap(tags), correspondents: toMap(correspondents), documentTypes: toMap(documentTypes) };
}

/** Returns cached id → name maps; on failure, returns empty maps so formatting falls back to ids. */
async function getNames(): Promise<TaxonomyNames> {
  let cached = namesCache;
  if (!cached || Date.now() - cached.at > NAMES_TTL_MS) {
    const names = loadNames();
    cached = namesCache = { at: Date.now(), names };
    // Don't cache failures — retry on the next call.
    names.catch(() => {
      if (namesCache?.names === names) namesCache = undefined;
    });
  }
  return cached.names.catch(() => ({ tags: new Map(), correspondents: new Map(), documentTypes: new Map() }));
}

function nameOf(map: NameMap, id: number): string {
  return map.get(id) ?? `#${id}`;
}

// ---------------------------------------------------------------------------
// Document metadata (deliberately excludes `content` — the full OCR text)
// list_documents and search_documents only ever request these fields, so
// browsing/discovery never pulls a document's full text into the client.
// paperless__get_document is the one deliberate, single-id tool that does.
// ---------------------------------------------------------------------------

const METADATA_FIELDS =
  "id,title,correspondent,document_type,tags,created,added,original_file_name,archive_serial_number";

interface DocumentMeta {
  id: number;
  title: string;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  created: string;
  original_file_name: string | null;
  __search_hit__?: { highlights: string | null };
}

/** correspondent / type / tags as display fragments, with ids resolved to names. */
function describeTaxonomy(d: DocumentMeta, names: TaxonomyNames): string[] {
  const bits: string[] = [];
  if (d.correspondent !== null) bits.push(`correspondent=${nameOf(names.correspondents, d.correspondent)}`);
  if (d.document_type !== null) bits.push(`type=${nameOf(names.documentTypes, d.document_type)}`);
  if (d.tags.length) bits.push(`tags=[${d.tags.map((t) => nameOf(names.tags, t)).join(", ")}]`);
  return bits;
}

function formatDoc(d: DocumentMeta, names: TaxonomyNames): string {
  const bits = [`#${d.id}`, d.title, `created=${d.created}`, ...describeTaxonomy(d, names)];
  let line = `  ${bits.join("  ")}`;
  const highlight = d.__search_hit__?.highlights;
  if (highlight) {
    // Snippets are raw OCR text with line breaks — flatten to one line to keep the list readable.
    const snippet = highlight.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim();
    if (snippet) line += `\n    ↳ ${snippet}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Tool: list_documents (metadata only, no content)
// ---------------------------------------------------------------------------

function buildOrdering(args: Record<string, unknown>): string {
  const field = (args.order_by as string | undefined) ?? "added";
  const desc = ((args.order as string | undefined) ?? "desc") === "desc";
  return `${desc ? "-" : ""}${field}`;
}

function buildDateRangeParams(args: Record<string, unknown>): Record<string, string | undefined> {
  return {
    added__date__gte: args.added_after as string | undefined,
    added__date__lte: args.added_before as string | undefined,
    created__date__gte: args.created_after as string | undefined,
    created__date__lte: args.created_before as string | undefined,
  };
}

const DATE_RANGE_PROPERTIES = {
  added_after: { type: "string", description: "Only documents added on/after this date (YYYY-MM-DD)." },
  added_before: { type: "string", description: "Only documents added on/before this date (YYYY-MM-DD)." },
  created_after: { type: "string", description: "Only documents dated on/after this date (YYYY-MM-DD)." },
  created_before: { type: "string", description: "Only documents dated on/before this date (YYYY-MM-DD)." },
} as const;

const listDocumentsTool: CustomTool = {
  definition: {
    name: "paperless__list_documents",
    description:
      "Lists documents (title, correspondent, type, tags, dates) WITHOUT full document text. " +
      "Supports ordering (e.g. most recently uploaded first) and date-range filtering. " +
      "Use this to browse/discover documents, then call paperless__get_document with a specific id " +
      "to read that document's full content.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default: 1)." },
        page_size: { type: "number", description: "Results per page (default: 25)." },
        order_by: {
          type: "string",
          enum: ["added", "created"],
          description: "Sort by upload date ('added') or document date ('created'). Default: 'added'.",
        },
        order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "'desc' = most recent first (default), 'asc' = oldest first.",
        },
        ...DATE_RANGE_PROPERTIES,
      },
      required: [],
    },
  },
  handler: async (args) => {
    const [res, names] = await Promise.all([
      paperlessGet<{ count: number; results: DocumentMeta[] }>("/api/documents/", {
        fields: METADATA_FIELDS,
        page: args.page as number | undefined,
        page_size: (args.page_size as number | undefined) ?? 25,
        ordering: buildOrdering(args),
        ...buildDateRangeParams(args),
      }),
      getNames(),
    ]);
    if (!res.results.length) return text("No documents found.");
    const lines = res.results.map((d) => formatDoc(d, names));
    return text(`Documents (${res.count} total, showing ${res.results.length}):\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: search_documents (metadata + short highlight snippet, no full content)
// ---------------------------------------------------------------------------

const searchDocumentsTool: CustomTool = {
  definition: {
    name: "paperless__search_documents",
    description:
      "Full-text searches documents, returning metadata plus a short highlighted snippet per match — " +
      "NOT the full document text. Results are ranked by relevance; use the date filters to narrow the " +
      "time range. Use paperless__get_document with a specific id to read the full content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        page_size: { type: "number", description: "Max results (default: 10)." },
        ...DATE_RANGE_PROPERTIES,
      },
      required: ["query"],
    },
  },
  handler: async (args) => {
    const query = args.query as string;
    const [res, names] = await Promise.all([
      paperlessGet<{ count: number; results: DocumentMeta[] }>("/api/documents/", {
        query,
        fields: METADATA_FIELDS,
        page_size: (args.page_size as number | undefined) ?? 10,
        ...buildDateRangeParams(args),
      }),
      getNames(),
    ]);
    if (!res.results.length) return text(`No documents matched "${query}".`);
    const lines = res.results.map((d) => formatDoc(d, names));
    return text(`Search results for "${query}" (${res.count} total match(es)):\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: get_document (single document, full content — deliberate fetch only)
// ---------------------------------------------------------------------------

interface DocumentFull extends DocumentMeta {
  content: string;
}

/** Default cap on returned content so one huge document can't flood the client's context. */
const DEFAULT_MAX_CHARS = 50_000;

const getDocumentTool: CustomTool = {
  definition: {
    name: "paperless__get_document",
    description:
      "Fetches ONE specific document by id, including its full OCR'd text content. This is the only " +
      "paperless tool that returns full document content — use it deliberately, after identifying the " +
      "right document via paperless__list_documents or paperless__search_documents.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Document id." },
        max_chars: {
          type: "number",
          description: `Maximum characters of content to return (default: ${DEFAULT_MAX_CHARS}). Use 0 for no limit.`,
        },
      },
      required: ["id"],
    },
  },
  handler: async (args) => {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid document id: ${String(args.id)}`);
    const [doc, names] = await Promise.all([paperlessGet<DocumentFull>(`/api/documents/${id}/`), getNames()]);
    const header = [`#${doc.id} ${doc.title}`, `created=${doc.created}`, ...describeTaxonomy(doc, names)];

    const maxChars = Number(args.max_chars ?? DEFAULT_MAX_CHARS);
    if (!Number.isInteger(maxChars) || maxChars < 0) throw new Error(`Invalid max_chars: ${String(args.max_chars)}`);
    let content = doc.content ?? "";
    if (maxChars > 0 && content.length > maxChars) {
      content =
        `${content.slice(0, maxChars)}\n\n[truncated: showing ${maxChars} of ${content.length} characters — ` +
        `call again with a higher max_chars, or 0 for the full text]`;
    }
    return text(`${header.join("  ")}\n\n${content}`);
  },
};

// ---------------------------------------------------------------------------
// Tools: list_tags / list_correspondents / list_document_types (taxonomy only)
// ---------------------------------------------------------------------------

function makeTaxonomyTool(name: string, endpoint: string, label: string): CustomTool {
  return {
    definition: {
      name,
      description: `Lists all ${label} defined in Paperless-ngx (id + name).`,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    handler: async () => {
      const items = await paperlessGetAll(endpoint);
      if (!items.length) return text(`No ${label} found.`);
      return text(`${label} (${items.length}):\n${items.map((r) => `  #${r.id}  ${r.name}`).join("\n")}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const paperlessTools: CustomTool[] = [
  listDocumentsTool,
  searchDocumentsTool,
  getDocumentTool,
  makeTaxonomyTool("paperless__list_tags", "/api/tags/", "tags"),
  makeTaxonomyTool("paperless__list_correspondents", "/api/correspondents/", "correspondents"),
  makeTaxonomyTool("paperless__list_document_types", "/api/document_types/", "document types"),
];

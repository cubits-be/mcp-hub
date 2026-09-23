import type { CustomTool } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REGISTRY_URL = (process.env.REGISTRY_URL ?? "https://registry.cubits.be").replace(/\/$/, "");
/** Basic auth credentials (the registry sits behind Apache basic auth). */
const REGISTRY_USERNAME = process.env.REGISTRY_USERNAME;
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD;

/** Page size requested per call; the registry follows up via the Link header. */
const PAGE_SIZE = 100;
/** Safety cap so a misbehaving Link header can't loop forever. */
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  if (!REGISTRY_USERNAME) return {};
  const token = Buffer.from(`${REGISTRY_USERNAME}:${REGISTRY_PASSWORD ?? ""}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

/** Extracts the `rel="next"` target from a registry Link header, if any. */
function nextLink(link: string | null): string | undefined {
  const match = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/);
  return match?.[1];
}

/**
 * GETs a paginated registry v2 list endpoint, following Link headers and
 * concatenating the array found at `key` on each page.
 */
async function registryGetAll(path: string, key: "repositories" | "tags"): Promise<string[]> {
  const items: string[] = [];
  let url: URL | undefined = new URL(`${REGISTRY_URL}${path}`);
  url.searchParams.set("n", String(PAGE_SIZE));

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`registry HTTP ${res.status}: ${body || res.statusText}`);
    }
    const data = (await res.json()) as Record<string, string[] | null>;
    items.push(...(data[key] ?? []));
    const next = nextLink(res.headers.get("link"));
    url = next ? new URL(next, REGISTRY_URL) : undefined;
  }
  return items;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Tool: list_images
// ---------------------------------------------------------------------------

const listImagesTool: CustomTool = {
  definition: {
    name: "registry__list_images",
    description:
      "Lists all images (repositories) in the private Docker registry via the v2 _catalog endpoint. " +
      "Optionally filter by a substring, or include each image's tags.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Case-insensitive substring to filter image names by.",
        },
        includeTags: {
          type: "boolean",
          description: "Also fetch and list the tags for each image (one extra request per image; default: false).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const filter = (args.filter as string | undefined)?.toLowerCase();
    const includeTags = (args.includeTags as boolean | undefined) ?? false;

    let repos = await registryGetAll("/v2/_catalog", "repositories");
    if (filter) repos = repos.filter((r) => r.toLowerCase().includes(filter));
    if (!repos.length) return text(filter ? `No images matching '${filter}'.` : "No images in the registry.");

    if (!includeTags) return text(`Images (${repos.length}):\n${repos.map((r) => `  ${r}`).join("\n")}`);

    const lines = await Promise.all(
      repos.map(async (repo) => {
        try {
          const tags = await registryGetAll(`/v2/${repo}/tags/list`, "tags");
          return `  ${repo}: ${tags.length ? tags.join(", ") : "(no tags)"}`;
        } catch (err) {
          return `  ${repo}: error — ${(err as Error).message}`;
        }
      }),
    );
    return text(`Images (${repos.length}):\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: list_tags
// ---------------------------------------------------------------------------

const listTagsTool: CustomTool = {
  definition: {
    name: "registry__list_tags",
    description: "Lists the tags of a single image in the private Docker registry.",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image (repository) name as returned by registry__list_images, e.g. 'cubits/tars-hub-mcp'.",
        },
      },
      required: ["image"],
    },
  },
  handler: async (args) => {
    const image = args.image as string;
    const tags = await registryGetAll(`/v2/${image}/tags/list`, "tags");
    if (!tags.length) return text(`Image '${image}' has no tags.`);
    return text(`Tags for ${image} (${tags.length}):\n${tags.map((t) => `  ${t}`).join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const registryTools: CustomTool[] = [listImagesTool, listTagsTool];

import type { CustomTool } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORTRACKER_URL = (process.env.PORTRACKER_URL ?? "http://192.168.1.12:4999").replace(/\/$/, "");
/** Only needed if the portracker instance has ENABLE_AUTH=true. */
const PORTRACKER_API_KEY = process.env.PORTRACKER_API_KEY;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function portrackerGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${PORTRACKER_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {};
  if (PORTRACKER_API_KEY) headers["x-api-key"] = PORTRACKER_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`portracker HTTP ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

interface PortEntry {
  source: string;
  owner: string;
  owners?: string[];
  protocol: string;
  host_ip: string;
  host_port: number;
  pid?: number | null;
  pids?: number[];
  target?: string | null;
  container_id?: string | null;
  app_id?: string | null;
  compose_project?: string | null;
  compose_service?: string | null;
  internal?: boolean;
  note?: string | null;
  ignored?: boolean;
}

function formatPort(p: PortEntry): string {
  const addr = `${p.host_ip}:${p.host_port}/${p.protocol}`;
  const bits = [p.owner];
  if (p.compose_project) bits.push(`project=${p.compose_project}`);
  if (p.internal) bits.push("internal");
  if (p.ignored) bits.push("ignored");
  if (p.note) bits.push(`note="${p.note}"`);
  return `  ${addr.padEnd(24)} ${bits.join("  ")}`;
}

// ---------------------------------------------------------------------------
// Tool: list_ports (local host)
// ---------------------------------------------------------------------------

const listPortsTool: CustomTool = {
  definition: {
    name: "portracker__list_ports",
    description:
      "Lists ports currently open/published on the local portracker host (Docker containers + system listeners). " +
      "Use this to answer 'what's listening on this machine / what ports are in use'.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const res = await portrackerGet<{ data: PortEntry[] }>("/api/ports");
    const ports = res.data ?? [];
    if (!ports.length) return text("No open ports found.");
    const sorted = [...ports].sort((a, b) => a.host_port - b.host_port);
    return text(`Open ports (${ports.length}):\n${sorted.map(formatPort).join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: list_all_ports (across all tracked servers/peers)
// ---------------------------------------------------------------------------

interface ServerPortsResult {
  id: string;
  server: string;
  ok: boolean;
  error?: string | null;
  data: PortEntry[];
  parentId?: string | null;
  platform_type?: string;
}

const listAllPortsTool: CustomTool = {
  definition: {
    name: "portracker__list_all_ports",
    description:
      "Lists ports across every server/peer portracker is tracking (not just the local host). " +
      "Use this for a fleet-wide view across multiple machines/VMs.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const results = await portrackerGet<ServerPortsResult[]>("/api/all-ports");
    if (!results.length) return text("No servers configured in portracker.");
    const lines = results.map((r) => {
      if (!r.ok) return `${r.server} (${r.id}): error — ${r.error ?? "unknown"}`;
      if (!r.data.length) return `${r.server} (${r.id}): no open ports`;
      const sorted = [...r.data].sort((a, b) => a.host_port - b.host_port);
      return `${r.server} (${r.id}) — ${r.data.length} ports:\n${sorted.map(formatPort).join("\n")}`;
    });
    return text(lines.join("\n\n"));
  },
};

// ---------------------------------------------------------------------------
// Tool: list_services (grouped, with computed health)
// ---------------------------------------------------------------------------

interface ServiceEntry {
  serviceId: string;
  name: string;
  project?: string | null;
  color: string;
  reason?: string;
  ports?: Array<{ host_port: number; protocol: string }>;
}

const listServicesTool: CustomTool = {
  definition: {
    name: "portracker__list_services",
    description:
      "Lists local Docker Compose services grouped together with their computed health status " +
      "(green/yellow/gray). Useful for a quick 'what's healthy vs. degraded' overview.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const res = await portrackerGet<{ services: ServiceEntry[] }>("/api/services");
    const services = res.services ?? [];
    if (!services.length) return text("No services found.");
    const lines = services.map((s) => {
      const project = s.project ? ` (project: ${s.project})` : "";
      const reason = s.reason ? ` — ${s.reason}` : "";
      return `  [${s.color}] ${s.name}${project}${reason}`;
    });
    return text(`Services (${services.length}):\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: list_servers (configured servers/peers)
// ---------------------------------------------------------------------------

interface ServerEntry {
  id: string;
  label: string;
  url?: string | null;
  parentId?: string | null;
  type: string;
  unreachable?: number;
  platform_type?: string | null;
  position?: number | null;
  hasApiKey?: number;
}

const listServersTool: CustomTool = {
  definition: {
    name: "portracker__list_servers",
    description:
      "Lists all servers/peers configured in portracker (the local host plus any linked peer instances), " +
      "including reachability and platform type.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const servers = await portrackerGet<ServerEntry[]>("/api/servers");
    if (!servers.length) return text("No servers configured.");
    const lines = servers.map((s) => {
      const parent = s.parentId ? ` parent=${s.parentId}` : "";
      const status = s.unreachable ? "unreachable" : "reachable";
      return `  ${s.id.padEnd(16)} "${s.label}"  type=${s.type}  platform=${s.platform_type ?? "unknown"}  ${status}${parent}`;
    });
    return text(`Servers (${servers.length}):\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: scan_server (force a fresh scan)
// ---------------------------------------------------------------------------

const scanServerTool: CustomTool = {
  definition: {
    name: "portracker__scan_server",
    description:
      "Triggers a fresh port scan on a specific server tracked by portracker, bypassing the cache. " +
      "Use serverId 'local' for the local host, or another server's id from portracker__list_servers.",
    inputSchema: {
      type: "object",
      properties: {
        serverId: {
          type: "string",
          description: "The server id to scan (default: 'local').",
        },
        includeUdp: {
          type: "boolean",
          description: "Include UDP listeners in the scan (default: false).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const serverId = (args.serverId as string | undefined) ?? "local";
    const includeUdp = args.includeUdp as boolean | undefined;
    const result = await portrackerGet<{ ports?: PortEntry[] }>(`/api/servers/${encodeURIComponent(serverId)}/scan`, {
      disableCache: "true",
      ...(includeUdp !== undefined ? { includeUdp: String(includeUdp) } : {}),
    });
    const ports = result.ports ?? [];
    if (!ports.length) return text(`Scan of '${serverId}' found no open ports.`);
    const sorted = [...ports].sort((a, b) => a.host_port - b.host_port);
    return text(`Scan of '${serverId}' — ${ports.length} ports:\n${sorted.map(formatPort).join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: status (version/reachability check)
// ---------------------------------------------------------------------------

const statusTool: CustomTool = {
  definition: {
    name: "portracker__status",
    description: "Checks that the portracker instance is reachable and returns its version info.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => {
    const version = await portrackerGet<{ version: string; name: string; description?: string }>("/api/version");
    return text(`${version.name} v${version.version} is reachable at ${PORTRACKER_URL}`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const portrackerTools: CustomTool[] = [
  listPortsTool,
  listAllPortsTool,
  listServicesTool,
  listServersTool,
  scanServerTool,
  statusTool,
];

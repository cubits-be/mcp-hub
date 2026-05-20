import { google } from "googleapis";
import type { CustomTool } from "../types.js";
import { loadOAuthClient, resolveCredDir } from "./google-oauth.js";

// ---------------------------------------------------------------------------
// Auth — reuses the Gmail OAuth credentials (same GCP project)
// ---------------------------------------------------------------------------

function getSheets() {
  const credDir = resolveCredDir("GOOGLE_OAUTH_DIR", ".google-oauth");
  const auth = loadOAuthClient(credDir);
  return google.sheets({ version: "v4", auth });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getSpreadsheetTool: CustomTool = {
  definition: {
    name: "gsheets__get_spreadsheet",
    description: "Get spreadsheet metadata: title, sheet names, and sheet IDs.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID (from the URL)" },
      },
      required: ["spreadsheetId"],
    },
  },
  handler: async (args) => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.get({
      spreadsheetId: args.spreadsheetId as string,
      fields: "spreadsheetId,properties.title,sheets.properties",
    });
    const title = res.data.properties?.title ?? "(untitled)";
    const sheetList = (res.data.sheets ?? [])
      .map((s) => `  - ${s.properties?.title} (id: ${s.properties?.sheetId})`)
      .join("\n");
    return text(`Spreadsheet: ${title}\nID: ${res.data.spreadsheetId}\n\nSheets:\n${sheetList}`);
  },
};

const getValuesTool: CustomTool = {
  definition: {
    name: "gsheets__get_values",
    description: "Read cell values from a range in a spreadsheet.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID (from the URL)" },
        range: { type: "string", description: "A1 notation range, e.g. 'Sheet1!A1:D10' or 'A1:D10'" },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  handler: async (args) => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: args.spreadsheetId as string,
      range: args.range as string,
    });
    const rows = res.data.values ?? [];
    if (rows.length === 0) return text("No data found in range.");
    return text(rows.map((row) => row.join("\t")).join("\n"));
  },
};

const updateValuesTool: CustomTool = {
  definition: {
    name: "gsheets__update_values",
    description: "Write values to a range in a spreadsheet. Overwrites existing content.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID (from the URL)" },
        range: { type: "string", description: "A1 notation range, e.g. 'Sheet1!A1'" },
        values: {
          type: "array",
          description: "2D array of values (rows × columns)",
          items: { type: "array", items: {} },
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  handler: async (args) => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId: args.spreadsheetId as string,
      range: args.range as string,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: args.values as unknown[][] },
    });
    return text(`Updated ${res.data.updatedCells ?? 0} cell(s) in ${res.data.updatedRange}.`);
  },
};

const appendValuesTool: CustomTool = {
  definition: {
    name: "gsheets__append_values",
    description: "Append rows to a spreadsheet after the last row of existing data in the range.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID (from the URL)" },
        range: { type: "string", description: "A1 notation range that identifies the table, e.g. 'Sheet1!A1'" },
        values: {
          type: "array",
          description: "2D array of rows to append",
          items: { type: "array", items: {} },
        },
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  handler: async (args) => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: args.spreadsheetId as string,
      range: args.range as string,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: args.values as unknown[][] },
    });
    return text(`Appended to ${res.data.updates?.updatedRange}. ${res.data.updates?.updatedRows ?? 0} row(s) added.`);
  },
};

const clearValuesTool: CustomTool = {
  definition: {
    name: "gsheets__clear_values",
    description: "Clear all values in a range (formatting is preserved).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: { type: "string", description: "The spreadsheet ID (from the URL)" },
        range: { type: "string", description: "A1 notation range to clear, e.g. 'Sheet1!A1:D10'" },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  handler: async (args) => {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.clear({
      spreadsheetId: args.spreadsheetId as string,
      range: args.range as string,
    });
    return text(`Cleared range ${res.data.clearedRange}.`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const googleSheetsTools: CustomTool[] = [
  getSpreadsheetTool,
  getValuesTool,
  updateValuesTool,
  appendValuesTool,
  clearValuesTool,
];

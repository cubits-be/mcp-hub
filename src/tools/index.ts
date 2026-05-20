import type { CustomTool } from "../types.js";
import { googleCalendarTools } from "./google-calendar.js";
import { googleGmailTools } from "./google-gmail.js";
import { googleSheetsTools } from "./google-sheets.js";
import { healthTools } from "./health.js";

/** Returns the current UTC time. Useful as a simple "is the hub alive?" check. */
const currentTimeTool: CustomTool = {
  definition: {
    name: "hub__current_time",
    description: "Returns the current UTC date and time. Useful for confirming the hub is responsive.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  handler: async () => ({
    content: [{ type: "text" as const, text: new Date().toISOString() }],
  }),
};

export const customTools: CustomTool[] = [
  currentTimeTool,
  ...googleCalendarTools,
  ...googleGmailTools,
  ...googleSheetsTools,
  ...healthTools,
];

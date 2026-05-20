import { google } from "googleapis";
import type { CustomTool } from "../types.js";
import { loadOAuthClient, resolveCredDir } from "./google-oauth.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getCalendar() {
  const credDir = resolveCredDir("GOOGLE_OAUTH_DIR", ".google-oauth");
  const auth = loadOAuthClient(credDir);
  return google.calendar({ version: "v3", auth });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function calendarIdParam() {
  return {
    calendarId: {
      type: "string",
      description:
        'Calendar ID to operate on. Use "primary" for the main calendar, ' +
        "or any ID returned by list_calendars. Defaults to \"primary\".",
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const listCalendarsTool: CustomTool = {
  definition: {
    name: "google_calendar__list_calendars",
    description: "Lists all calendars accessible by the authenticated account.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  handler: async () => {
    const calendar = getCalendar();
    const res = await calendar.calendarList.list();
    const items = res.data.items ?? [];
    const summary = items
      .map((c) => `• ${c.summary} (id: ${c.id})${c.primary ? " [primary]" : ""}`)
      .join("\n");
    return text(`${items.length} calendars:\n${summary}`);
  },
};

const listEventsTool: CustomTool = {
  definition: {
    name: "google_calendar__list_events",
    description: "Lists events within a time range from any calendar.",
    inputSchema: {
      type: "object",
      properties: {
        ...calendarIdParam(),
        timeMin: { type: "string", description: "Start of range (ISO 8601)" },
        timeMax: { type: "string", description: "End of range (ISO 8601)" },
        maxResults: { type: "number", description: "Max events to return (default 10)" },
        orderBy: {
          type: "string",
          enum: ["startTime", "updated"],
          description: "Sort order (default: startTime)",
        },
        query: { type: "string", description: "Free-text search query" },
      },
      required: ["timeMin", "timeMax"],
    },
  },
  handler: async (args) => {
    const calendar = getCalendar();
    const res = await calendar.events.list({
      calendarId: (args.calendarId as string | undefined) ?? "primary",
      timeMin: args.timeMin as string,
      timeMax: args.timeMax as string,
      maxResults: (args.maxResults as number | undefined) ?? 10,
      orderBy: (args.orderBy as "startTime" | "updated" | undefined) ?? "startTime",
      singleEvents: true,
      q: args.query as string | undefined,
    });
    const items = res.data.items ?? [];
    return text(`${items.length} events:\n${JSON.stringify(items, null, 2)}`);
  },
};

const getEventTool: CustomTool = {
  definition: {
    name: "google_calendar__get_event",
    description: "Retrieves details of a specific calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        ...calendarIdParam(),
        eventId: { type: "string", description: "Event ID" },
      },
      required: ["eventId"],
    },
  },
  handler: async (args) => {
    const calendar = getCalendar();
    const res = await calendar.events.get({
      calendarId: (args.calendarId as string | undefined) ?? "primary",
      eventId: args.eventId as string,
    });
    return text(JSON.stringify(res.data, null, 2));
  },
};

const createEventTool: CustomTool = {
  definition: {
    name: "google_calendar__create_event",
    description: "Creates a new event in a calendar.",
    inputSchema: {
      type: "object",
      properties: {
        ...calendarIdParam(),
        summary: { type: "string", description: "Event title" },
        description: { type: "string", description: "Event description" },
        location: { type: "string", description: "Event location" },
        start: {
          type: "object",
          properties: {
            dateTime: { type: "string", description: "Start time (ISO 8601)" },
            date: { type: "string", description: "All-day start date (YYYY-MM-DD)" },
            timeZone: { type: "string", description: "Time zone" },
          },
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string", description: "End time (ISO 8601)" },
            date: { type: "string", description: "All-day end date (YYYY-MM-DD)" },
            timeZone: { type: "string", description: "Time zone" },
          },
        },
        attendees: {
          type: "array",
          items: { type: "object", properties: { email: { type: "string" } } },
          description: "List of attendees",
        },
      },
      required: ["summary", "start", "end"],
    },
  },
  handler: async (args) => {
    const calendar = getCalendar();
    const { calendarId, ...body } = args;
    const res = await calendar.events.insert({
      calendarId: (calendarId as string | undefined) ?? "primary",
      requestBody: body as object,
    });
    return text(
      `Event created: ${res.data.id}\nTitle: ${res.data.summary}\nStart: ${res.data.start?.dateTime ?? res.data.start?.date}\nEnd: ${res.data.end?.dateTime ?? res.data.end?.date}`
    );
  },
};

const updateEventTool: CustomTool = {
  definition: {
    name: "google_calendar__update_event",
    description: "Updates an existing calendar event (partial update — only provided fields change).",
    inputSchema: {
      type: "object",
      properties: {
        ...calendarIdParam(),
        eventId: { type: "string", description: "Event ID to update" },
        summary: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        location: { type: "string", description: "New location" },
        start: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
      },
      required: ["eventId"],
    },
  },
  handler: async (args) => {
    const calendar = getCalendar();
    const { calendarId, eventId, ...updates } = args;
    const res = await calendar.events.patch({
      calendarId: (calendarId as string | undefined) ?? "primary",
      eventId: eventId as string,
      requestBody: updates as object,
    });
    return text(`Event updated: ${res.data.id}\n${JSON.stringify(res.data, null, 2)}`);
  },
};

const deleteEventTool: CustomTool = {
  definition: {
    name: "google_calendar__delete_event",
    description: "Deletes an event from a calendar.",
    inputSchema: {
      type: "object",
      properties: {
        ...calendarIdParam(),
        eventId: { type: "string", description: "Event ID to delete" },
      },
      required: ["eventId"],
    },
  },
  handler: async (args) => {
    const calendar = getCalendar();
    await calendar.events.delete({
      calendarId: (args.calendarId as string | undefined) ?? "primary",
      eventId: args.eventId as string,
    });
    return text(`Event deleted: ${args.eventId as string}`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const googleCalendarTools: CustomTool[] = [
  listCalendarsTool,
  listEventsTool,
  getEventTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
];

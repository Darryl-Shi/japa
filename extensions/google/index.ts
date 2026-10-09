// The `google` extension: Gmail, Drive, Calendar, Contacts and Tasks for one Google account, with the user's own
// OAuth client, signed in from `japa setup` or the chat `connect` tool (spec 2026-10-09-japa-google-design.md).
import { defineJapaExtension, defineTool, type KernelContext } from "../../src/sdk.ts";
import { type Api, createApi, respond } from "./api.ts";
import { createTokens, isConnected, primeStatus, signIn, statusLine } from "./auth.ts";
import { CALENDAR_DESCRIPTION, calendar, calendarParameters } from "./calendar.ts";
import { CONTACTS_DESCRIPTION, contacts, contactsParameters } from "./contacts.ts";
import { DRIVE_DESCRIPTION, drive, driveParameters } from "./drive.ts";
import { GMAIL_DESCRIPTION, gmail, gmailParameters } from "./gmail.ts";
import { googleRequest, REQUEST_DESCRIPTION, requestParameters } from "./request.ts";
import { TASKS_DESCRIPTION, tasks, tasksParameters } from "./tasks.ts";

let kernel: KernelContext | undefined;
let shared: Api | undefined;

/** Runs `handler` with the shared client and the home dir, as a tool reply. */
const run = (handler: (api: Api, home: string) => Promise<string>) => {
  // Tools are installed only after setup, so this is a safeguard rather than a path anyone takes.
  if (kernel === undefined) return respond(async () => "Google isn't ready yet; try again in a moment.");
  const ctx = kernel;
  shared ??= createApi(createTokens(ctx));
  const api = shared;
  return respond(() => handler(api, ctx.home));
};

const gmailTool = defineTool({
  name: "gmail",
  description: GMAIL_DESCRIPTION,
  parameters: gmailParameters,
  execute: async (args) => run((api, home) => gmail(api, home, args)),
});

const driveTool = defineTool({
  name: "drive",
  description: DRIVE_DESCRIPTION,
  parameters: driveParameters,
  execute: async (args) => run((api, home) => drive(api, home, args)),
});

const calendarTool = defineTool({
  name: "calendar",
  description: CALENDAR_DESCRIPTION,
  parameters: calendarParameters,
  execute: async (args) => run((api) => calendar(api, args)),
});

const contactsTool = defineTool({
  name: "contacts",
  description: CONTACTS_DESCRIPTION,
  parameters: contactsParameters,
  execute: async (args) => run((api) => contacts(api, args)),
});

const tasksTool = defineTool({
  name: "tasks",
  description: TASKS_DESCRIPTION,
  parameters: tasksParameters,
  execute: async (args) => run((api) => tasks(api, args)),
});

const requestTool = defineTool({
  name: "google_request",
  description: REQUEST_DESCRIPTION,
  parameters: requestParameters,
  execute: async (args) => run((api) => googleRequest(api, args)),
});

const DOCS = [
  "Gmail, Drive, Calendar, Contacts and Tasks for the user's one Google account. Each tool takes an action and its " +
    "fields (the tool descriptions list them); lists carry the ids the next call needs.",
  "- gmail: search, read (a whole thread), send, draft, modify (labels; archive, mark read, trash), labels, attachment.",
  "- drive: search, read (Docs as markdown, Sheets as CSV), download, upload, create_folder, move, rename, share, trash.",
  "- calendar: calendars, list (default the next 7 days), create, update, delete, freebusy.",
  "- contacts: search, read, create, update.",
  "- tasks: lists, list, add, update, delete.",
  "- google_request: any other Google REST call ({ method, url, query?, body? }), https://*.googleapis.com only.",
  "Confirm with the user before sending mail, deleting, trashing or sharing, unless they asked for that exact " +
    "action. Calendar create, update and delete email the event's attendees.",
  "Downloads and attachments are saved under ~/.japa/attachments/google/<date>/ and the tool returns the path; " +
    "upload and send attachments take file paths on the japa host.",
  "Recovery: if Google isn't set up, ask the user for google.clientId and google.clientSecret with secret_request " +
    '(a Desktop app OAuth client; japa\'s README explains how), then connect. If not connected or the sign-in ' +
    'expired, call connect({ extension: "google" }) and send the user the link it returns. An API that isn\'t ' +
    "enabled comes back with the console link that enables it.",
].join("\n");

export default defineJapaExtension({
  name: "google",
  summary: "Gmail, Drive, Calendar, Contacts and Tasks for one Google account",
  examples: [
    "what came in from my accountant this week?",
    "find the Q3 budget doc and summarize it",
    "schedule 30 minutes with Dana next Tuesday afternoon",
    "add 'renew passport' to my tasks for Friday",
  ],
  docs: DOCS,
  provides: { tool: [gmailTool, driveTool, calendarTool, contactsTool, tasksTool, requestTool] },
  secrets: [
    { name: "google.clientId", description: "Google OAuth client ID (a Desktop app client, see the README)" },
    { name: "google.clientSecret", description: "Google OAuth client secret" },
    { name: "google.token", description: "Google sign-in (made by connecting)", generated: true },
  ],
  authorize: {
    run: (ctx, io) => signIn(ctx, io),
    connected: (ctx) => isConnected(ctx),
  },
  setup: (ctx) => {
    // A reload gives a fresh context: the client is rebuilt from it on the next call.
    kernel = ctx;
    shared = undefined;
    void primeStatus(ctx);
  },
  status: statusLine,
});

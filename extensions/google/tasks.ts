// The `tasks` tool: the user's Google Tasks lists, and listing, adding, changing and deleting their tasks (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { Type } from "../../src/sdk.ts";
import { type Api, GoogleError } from "./api.ts";

const BASE = "https://tasks.googleapis.com/tasks/v1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const TASKS_ACTIONS = ["lists", "list", "add", "update", "delete"] as const;

export const tasksParameters = Type.Object({
  action: StringEnum(TASKS_ACTIONS),
  list: Type.Optional(Type.String({ description: 'task list id (default "@default")' })),
  id: Type.Optional(Type.String({ description: "task id" })),
  title: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  due: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
  done: Type.Optional(Type.Boolean({ description: "true completes the task, false reopens it" })),
  showCompleted: Type.Optional(Type.Boolean({ description: "include completed tasks (default false)" })),
});

export type TasksArgs = Static<typeof tasksParameters>;

export const TASKS_DESCRIPTION = [
  "The user's Google Tasks. Actions:",
  "lists — the user's task lists and their ids",
  'list { list? = "@default", showCompleted? = false } — tasks with done marks, due dates and ids',
  "add { title, notes?, due?, list? } — due is a date, YYYY-MM-DD",
  "update { id, list?, title?, notes?, due?, done? } — only the given fields change; done: false reopens the task",
  "delete { id, list? }",
  "Task ids come from earlier list results; list ids from lists.",
].join("\n");

type Task = { id: string; title?: string; status?: string; due?: string };

const tasksOf = (list = "@default", id?: string) =>
  [BASE, "lists", encodeURIComponent(list), "tasks", ...(id ? [encodeURIComponent(id)] : [])].join("/");

/** Google keeps only the date of `due`; a bare date is that day's midnight UTC, anything else is passed on. */
const dueTime = (value: string) => (DATE.test(value) ? `${value}T00:00:00.000Z` : value);

async function lists(api: Api): Promise<string> {
  const found = await api.json<{ items?: { id: string; title?: string }[] }>("GET", `${BASE}/users/@me/lists`);
  const items = found?.items ?? [];
  if (items.length === 0) return "No task lists.";
  return items.map((l, i) => `${i + 1}. ${l.title ?? "(no title)"}\n   id ${l.id}`).join("\n");
}

async function list(api: Api, args: TasksArgs): Promise<string> {
  const shown = args.showCompleted ?? false;
  // Tasks completed in the Google apps are hidden, so showing completed tasks has to show hidden ones too.
  const found = await api.json<{ items?: Task[] }>("GET", tasksOf(args.list), {
    query: { showCompleted: shown, showHidden: shown },
  });
  const items = found?.items ?? [];
  if (items.length === 0) return "No tasks.";
  return items
    .map((t, i) => {
      const mark = t.status === "completed" ? "x" : " ";
      const due = t.due ? ` due ${t.due.slice(0, 10)}` : "";
      return `${i + 1}. [${mark}] ${t.title || "(no title)"}${due}\n   id ${t.id}`;
    })
    .join("\n");
}

/** The task fields the caller gave, as the API's body. */
function fields(args: TasksArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.notes !== undefined) body.notes = args.notes;
  if (args.due !== undefined) body.due = dueTime(args.due);
  if (args.done === true) body.status = "completed";
  // Reopening needs the completion time cleared as well as the status.
  if (args.done === false) Object.assign(body, { status: "needsAction", completed: null });
  return body;
}

async function add(api: Api, args: TasksArgs): Promise<string> {
  if (!args.title) throw new GoogleError("add needs title");
  const made = await api.json<Task>("POST", tasksOf(args.list), { body: fields({ ...args, done: undefined }) });
  return `Added ${made?.title || args.title} (id ${made?.id})`;
}

async function update(api: Api, args: TasksArgs): Promise<string> {
  const body = fields(args);
  if (!args.id || Object.keys(body).length === 0) throw new GoogleError("update needs id and a field to change");
  const changed = await api.json<Task>("PATCH", tasksOf(args.list, args.id), { body });
  return `Updated ${changed?.title || "(no title)"} (id ${changed?.id ?? args.id})`;
}

async function remove(api: Api, args: TasksArgs): Promise<string> {
  if (!args.id) throw new GoogleError("delete needs id");
  await api.json("DELETE", tasksOf(args.list, args.id));
  return `Deleted ${args.id}.`;
}

/** Runs one tasks action; throws GoogleError with the reply for a request it can't make. */
export async function tasks(api: Api, args: TasksArgs): Promise<string> {
  switch (args.action) {
    case "lists":
      return lists(api);
    case "list":
      return list(api, args);
    case "add":
      return add(api, args);
    case "update":
      return update(api, args);
    case "delete":
      return remove(api, args);
    default:
      throw new GoogleError(`Unknown action: ${String(args.action)}`);
  }
}

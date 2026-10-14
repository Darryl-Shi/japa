// The Settings area's sections, in the order the section list shows them.

export type Section =
  | "overview"
  | "models"
  | "providers"
  | "extensions"
  | "schedules"
  | "general"
  | "changes"
  | "update";

export const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "providers", label: "Providers" },
  { id: "extensions", label: "Extensions" },
  { id: "schedules", label: "Schedules" },
  { id: "general", label: "General" },
  { id: "changes", label: "Recent changes" },
  { id: "update", label: "Update" },
];

export const sectionLabel = (id: Section) => SECTIONS.find((s) => s.id === id)?.label ?? id;

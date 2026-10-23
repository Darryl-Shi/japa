// Downloading and opening transcript files without navigating away when one is gone: a HEAD check first, then a
// temporary `<a download>` click (or the new tab's location); a 404's `{ error }` becomes an info line instead.
import { toLogin } from "$lib/api";
import { errorOf, fileUrl } from "$lib/files";

/** Shows a note in the transcript (Live.info). */
export type InfoFn = (text: string) => void;

/** Whether `id` can be fetched; on failure says why through `info` (a 401 goes to sign-in). */
async function check(id: string, info: InfoFn): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(fileUrl(id), { method: "HEAD", cache: "no-store", credentials: "same-origin" });
  } catch {
    info("Couldn't reach japa.");
    return false;
  }
  if (res.ok) return true;
  if (res.status === 401) {
    toLogin();
    return false;
  }
  // HEAD has no body: GET it for the server's message.
  let message = `Couldn't get the file (${res.status}).`;
  try {
    const got = await fetch(fileUrl(id), { cache: "no-store", credentials: "same-origin" });
    if (got.status === 401) {
      toLogin();
      return false;
    }
    if (!got.ok) message = errorOf(await got.json()) ?? message;
  } catch {
    // keep the generic message
  }
  info(message);
  return false;
}

/** Downloads file `id` (as `name`, the server's Content-Disposition decides in the end). */
export async function downloadFile(id: string, name: string, info: InfoFn): Promise<void> {
  if (!(await check(id, info))) return;
  const a = document.createElement("a");
  a.href = fileUrl(id, true);
  a.download = name;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Opens file `id` in a new tab. The tab is opened now, inside the click (a popup blocker would refuse it after the
 * await), then pointed at the file, or closed when the file is gone.
 */
export async function openFile(id: string, info: InfoFn): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  if (!(await check(id, info))) {
    tab?.close();
    return;
  }
  if (tab) tab.location.href = fileUrl(id);
  else window.open(fileUrl(id), "_blank", "noopener");
}

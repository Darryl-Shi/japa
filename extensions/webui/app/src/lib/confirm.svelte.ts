// In-page confirmations (not window.confirm): `confirm(…)` opens the page's ConfirmDialog and resolves to the answer.

export type ConfirmRequest = {
  title: string;
  message?: string;
  /** The confirming button's label, e.g. "Remove". */
  action: string;
  resolve: (ok: boolean) => void;
};

class Confirmer {
  request = $state<ConfirmRequest | undefined>();

  ask(title: string, action: string, message?: string): Promise<boolean> {
    this.request?.resolve(false);
    return new Promise((resolve) => {
      this.request = {
        title,
        action,
        message,
        resolve: (ok) => {
          this.request = undefined;
          resolve(ok);
        },
      };
    });
  }
}

export const confirmer = new Confirmer();

/** Asks for confirmation: `title` (a question), the confirming button's label, an optional explanation. */
export function confirm(title: string, action: string, message?: string): Promise<boolean> {
  return confirmer.ask(title, action, message);
}

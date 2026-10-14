import type { PageServerLoad } from "./$types";

// The chat renders on the client (ssr = false in +page.ts); this hands it the signed-in user's name.
export const load: PageServerLoad = ({ locals }) => ({ user: locals.user ?? "" });

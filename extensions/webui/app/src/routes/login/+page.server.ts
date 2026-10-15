import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals }) => ({ users: locals.users });

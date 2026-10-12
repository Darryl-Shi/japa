// Types for the fixture's local dependency, so `npm run typecheck` resolves it without the fixture's node_modules.
declare module "mini-dep" {
  export const fixture: string;
}

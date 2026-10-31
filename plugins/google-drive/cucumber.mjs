// Separate profiles keep the OAuth host/build dependency out of Docs source tests.
export default {};
export const oauth = { paths: ['features/oauth-client-reuse.feature'], import: ['features/step_definitions/oauth-client.steps.mjs'], format: ['progress'] };
export const docs = { paths: ['features/docs/*.feature'], import: ['features/docs/steps/*.mjs'], format: ['progress'] };

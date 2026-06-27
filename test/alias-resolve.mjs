// Dev/CI-only Node resolve hook mirroring app.html's import map + esbuild's
// aliases, so `node --test` can load modules that import via the bare roots
// (functions/…, components/…, app.js). No runtime dependency — test infra only.
const WEB = new URL('../web-editor/', import.meta.url);

export async function resolve(spec, ctx, next) {
  if (spec === 'app.js' || spec.startsWith('functions/') || spec.startsWith('components/'))
    return { url: new URL(spec, WEB).href, shortCircuit: true };
  return next(spec, ctx);
}

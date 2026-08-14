/** Injected by esbuild `define` from package.json — single source of truth. */
declare const __APP_VERSION__: string;

/** HTML files are inlined as strings by esbuild's text loader. */
declare module "*.html" {
  const html: string;
  export default html;
}

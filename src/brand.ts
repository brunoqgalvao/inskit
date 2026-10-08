/** Product name shown to people. Change here to rename. */
export const BRAND = process.env.INSTINCT_BRAND || 'inskit';
export const VERSION = '0.2.1';
declare const __BUILD_ID__: string | undefined;
/** Set at build time; the newest shim replaces an older running daemon. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

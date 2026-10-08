// Imported first by entry points: hides Node's "SQLite is experimental" warning from users.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: any, ...rest: any[]) => {
  if (String(warning?.message ?? warning).includes('SQLite')) return;
  return (emit as any)(warning, ...rest);
}) as typeof process.emitWarning;
export {};

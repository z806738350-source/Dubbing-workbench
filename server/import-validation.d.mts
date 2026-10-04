export const importLimits: { title: number; source: number; fileBytes: number };
export function importProblems(payload: { title?: unknown; source?: unknown; importedSource?: unknown }): Partial<Record<'title' | 'source' | 'importedSource', string>>;

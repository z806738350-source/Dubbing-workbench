export const importLimits = { title: 150, source: 1000000, fileBytes: 4 * 1024 * 1024 };

export function importProblems(payload) {
  const errors = {};
  if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > importLimits.title)
    errors.title = `章节名称不能为空，且不能超过 ${importLimits.title} 个字符`;
  if (typeof payload.source === 'string' && payload.source.replace(/\r\n?/g, '\n').length > importLimits.source)
    errors.source = '单章文字超过100万字符，请按章拆分后导入。';
  if (typeof payload.importedSource === 'string' && payload.importedSource.length > importLimits.source)
    errors.importedSource = '原始文件文字超过100万字符，请按章拆分后导入。';
  return errors;
}

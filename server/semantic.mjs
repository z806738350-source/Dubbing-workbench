export const longSegment = 350;
export const segmentLimit = speechRate => Math.max(100,Math.floor(longSegment*(1+(speechRate || 0)/100)));

// Offsets use Unicode code points; every cut stays on an existing phrase boundary.
export function semanticBlocks(text) {
  const chars = Array.from(text), blocks = [];
  let start = 0;
  const push = end => {
    if (end <= start) return;
    blocks.push({id:blocks.length,start,end,text:chars.slice(start,end).join('')});
    start = end;
  };
  for (let i = 0; i < chars.length; i++) {
    if (/[“「『]/u.test(chars[i])) push(i);
    if (/[。！？!?；;，,：:\n”」』]/u.test(chars[i]) && !(chars[i] === ',' && /\d/.test(chars[i-1] || '') && /\d/.test(chars[i+1] || ''))) {
      while (i + 1 < chars.length && /[”’」』"']/u.test(chars[i + 1])) i++;
      push(i + 1);
    }
  }
  push(chars.length);
  return blocks;
}

export function shortRanges(text, sentence = false, limit = longSegment) {
  const ranges = [], blocks = semanticBlocks(text);
  let start = 0, end = 0;
  const push = () => { if (end > start) ranges.push({start,end}); start = end; };
  for (const block of blocks) {
    if (end > start && (block.end - start > limit || !sentence && /^[“「『]/u.test(block.text))) push();
    end = block.end;
    if (sentence ? /[。！？!?\n][”’」』"']*$/u.test(block.text) : /[\n”」』]$/u.test(block.text)) push();
  }
  push();
  return ranges;
}

export function partsAfter(text, ids) {
  const blocks = semanticBlocks(text), chars = Array.from(text);
  if (!Array.isArray(ids) || ids.some((id,i) => !Number.isInteger(id) || id < 0 || id >= blocks.length - 1 || i > 0 && id <= ids[i-1])) return null;
  let start = 0;
  const parts = [...ids.map(id => blocks[id].end),chars.length].map(end => { const part = chars.slice(start,end).join(''); start = end; return part; });
  return parts.some(part => !part.trim()) ? null : parts;
}

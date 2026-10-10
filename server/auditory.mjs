import { humanPerformance } from './performance.mjs';
import { configurationDecided } from './experience.mjs';

const rate = 48000;
const timing = /顿了顿|停顿|停了|停下|犹豫|迟疑|沉默|长叹|叹息|片刻|半晌|良久|随后|过了一会|重新|走进|走出|进入|离开|回忆|想起/u;
const cueBodies = /^(?:(?:又)?(?:说|说道|道|问道|反问|提醒道)|(?:淡淡|冷静|平静|轻声|低声|喜滋滋|又惊又恐)(?:地)?(?:说|说道|道|问道)|低头嘟囔道|摸着自己的胡子，端起茶杯喜滋滋道|躲开她师父喷出来的茶水，冷静道)[，。,:：]$/u;
const unknownName = /^(?:未知|不明|陌生|黑衣人|白衣人|少年|少女|男子|女子|男人|女人|某人)/u;
const unitId = row => row.s?.unitId || row.s?.id || row.unitId || row.id;
const singleId = row => row.s?.kind === 'group' || row.s?.members?.length > 1 ? null : row.s?.members?.[0] || unitId(row);
const quoted = text => /^(?:“[^“”「」『』"\n]+”|「[^“”「」『』"\n]+」)\s*$/u.test(text || '');
const protectedSegment = s => humanPerformance(s) || s.protectedFields?.some(field => ['text','roleId','type','performance'].includes(field));

// shortcut: a closed cue grammar; expand only with reviewed examples and a new frozen version, unknown syntax keeps the chapter gap.
export function auditoryBoundaryPlan(chapter, rows, { segments = [], roles = [], units = [] } = {}) {
  const conservative = chapter.auditoryPolicy?.version === 1 && chapter.auditoryPolicy.mode === 'conservative';
  const originalGapFrames = Math.round(chapter.gap * rate);
  const boundaries = rows.slice(0, -1).map((row, i) => ({ leftUnitId: unitId(row), rightUnitId: unitId(rows[i + 1]), originalGapFrames, gapFrames: originalGapFrames, reason: conservative ? '保留章节停顿：未证明连续引述结构' : '历史统一停顿' }));
  const result = () => ({ version: conservative ? 1 : 0, mode: conservative ? 'conservative' : 'legacy', gapFrames: boundaries.map(b => b.gapFrames), boundaries, shortenedBoundaries: boundaries.filter(b => b.gapFrames < originalGapFrames).length });
  if (!conservative) return result();
  const byId = new Map(segments.map(s => [s.id, s])), byUnit = new Map(units.map(u => [u.id, u]));
  const source = Array.from(chapter.source || '');
  const outsideQuotes=new Uint8Array(source.length+1),quotes=[],closing={'“':'”','「':'」','『':'』'};let quoteSyntaxValid=true;
  for(let i=0;i<=source.length;i++){
    outsideQuotes[i]=quoteSyntaxValid&&!quotes.length?1:0;
    const char=source[i];
    if(closing[char])quotes.push(closing[char]);
    else if(char==='"'){if(quotes.at(-1)==='"')quotes.pop();else quotes.push('"');}
    else if(/[”」』]/u.test(char || '')){if(quotes.at(-1)===char)quotes.pop();else quoteSyntaxValid=false;}
  }
  function sourceSpan(s) {
    const spans = s.source?.spans;
    if (s.source?.version !== (chapter.sourceVersion || 1) || !Array.isArray(spans) || !spans.length) return null;
    let end = spans[0].start;
    for (const span of spans) {
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start !== end || span.end <= span.start || span.end > source.length) return null;
      end = span.end;
    }
    return source.slice(spans[0].start, end).join('') === s.text ? { start: spans[0].start, end } : null;
  }
  for (let i = 1; i < rows.length - 1; i++) {
    const triplet = rows.slice(i - 1, i + 2), members = triplet.map(row => byId.get(singleId(row))), [left, cue, right] = members;
    if (!cue || cue.type !== 'narration' || !/(?:道|反问)[，。,:：]\s*$/u.test(cue.text)) continue;
    let reason;
    if (triplet.some(row => (row.s?.mode || 'dry') !== 'dry' || !singleId(row)) || members.some(s => !s)) reason = 'scene 或对戏组边界保留';
    else if (timing.test(cue.text)) reason = '时间性动作或停顿线索保留';
    else if (members.some(s => s.retired || s.deletion || s.excluded || protectedSegment(s)) || triplet.some(row => byUnit.get(unitId(row))?.protectedFields?.includes('guidance'))) reason = '人工修改或受保护指导保留';
    else if (left.type !== 'dialogue' || right.type !== 'dialogue' || left.roleId !== right.roleId || !left.roleId || !members.every(s => configurationDecided(s) && !s.identityPending && !s.uncertain)) reason = '归属未确认或人物轮换保留';
    else {
      const actualVoice = row => row.a?.input?.members?.[0]?.voiceId || row.a?.input?.voiceId;
      if (!left.voiceId || left.voiceId !== right.voiceId || actualVoice(triplet[0], left) !== left.voiceId || actualVoice(triplet[2], right) !== right.voiceId) reason = '实际声音不一致或缺失保留';
      else if (!quoted(left.text) || !quoted(right.text) || /[“”「」『』"\n]/u.test(cue.text) || /\n\s*$/u.test(left.text)) reason = '段落或嵌套引用边界保留';
      else {
        const spans = members.map(sourceSpan);
        const role = roles.find(r => r.id === left.roleId);
        const names = role && !role.narrator && !role.identityPending ? [role.name, ...(role.aliases || [])].filter(name => typeof name === 'string' && name && !unknownName.test(name)) : [];
        const namesInCue = names.filter(name => cue.text.startsWith(name));
        const name = namesInCue.sort((a, b) => b.length - a.length)[0];
        const body = name ? cue.text.slice(name.length).trim().replace(/^师父/u, '') : '';
        if (spans.some(span => !span) || spans[0].end !== spans[1].start || spans[1].end !== spans[2].start) reason = '原文版本或连续来源无法核对';
        else if (!outsideQuotes[spans[1].start]) reason = '嵌套引用或原文引号结构无法核对';
        else if (!name || roles.some(r => r.id !== role.id && [r.name, ...(r.aliases || [])].includes(name)) || !cueBodies.test(body)) reason = '完整引述语不在保守白名单';
      }
    }
    for (const index of [i - 1, i]) Object.assign(boundaries[index], { cueSegmentId: cue.id, reason: reason || '同人物同实际声音的完整短引述语', gapFrames: reason ? originalGapFrames : Math.min(originalGapFrames, Math.round(.15 * rate)) });
  }
  return result();
}

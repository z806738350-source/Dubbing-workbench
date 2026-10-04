import { join } from 'node:path';
import { fail } from './store.mjs';
import { inspect, validateStoredAudio } from './audio.mjs';

// Shared by the HTTP controller and bounded assistant adapters. This is not a
// model-facing action dispatcher: capabilities must resolve/authorize the action.
export function createActionExecutor({ store, domain, experience, audioTools = true, activity = () => ({}) }) {
  return async function executeAction(action, payload, executionContext) {
    const current = activity(action, payload);
    if (['project.delete', 'project.rename'].includes(action) && current.attachmentWrites)
      fail('本项目的截图仍在保存，请等上传结束后再操作', 409);
    if (action === 'project.delete' && experience?.projectBusy(payload.id))
      fail('这个项目仍有操作正在处理，请等操作结束后再删除', 409);
    if (action === 'project.rename' && store.maybe('projects', payload.id)?.folder &&
        ((current.activeRequests ?? 1) !== 1 || current.referenceReads))
      fail('资料正在读取或保存，请稍后再改项目名称', 409);
    if (['segment.review', 'segment.restore', 'unit.review', 'unit.restore', 'unit.select-result'].includes(action)) {
      if (!audioTools) fail('请先配置音频处理程序以核对文件');
      const audio = store.get('audios', payload.audioId);
      if (!await validateStoredAudio(store, audio)) fail('音频损坏或缺失，不能采用或记录检查通过');
    }
    if (action === 'voice.update' && payload.inspection?.checked) {
      if (!audioTools) fail('请先配置音频处理程序以核对文件');
      const voice = store.get('voices', payload.id);
      if (payload.inspection.target === 'sample') {
        if (!voice.sampleAudioId || payload.inspection.audioId !== voice.sampleAudioId)
          fail('测试样音已变化，请重新检查', 409);
        if (!await validateStoredAudio(store, store.get('audios', voice.sampleAudioId)))
          fail('测试样音不可用，不能记录已检查');
      } else {
        if (!voice.path) fail('参考文件已删除');
        try { await inspect(join(store.directory, voice.path)); }
        catch { fail('参考文件不可用，不能记录已检查'); }
      }
    }
    return domain.mutate(action, payload, executionContext);
  };
}

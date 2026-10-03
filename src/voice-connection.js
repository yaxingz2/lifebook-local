export function voiceConnectionError(error){
  const status=String(error?.message||'').match(/Unexpected server response: (\d{3})/)?.[1];
  if(status==='401'||status==='403')return `语音服务拒绝连接（${status}）：请检查当前入口的密钥和模型权限。`;
  if(status==='429')return '语音服务暂时限流（429），请稍后重试并检查服务商额度。';
  if(status)return `语音服务连接失败（HTTP ${status}），请稍后重试。`;
  if(/timed? ?out|timeout/i.test(error?.message||'')||error?.code==='ETIMEDOUT')return '连接语音服务超时，请重试或检查当前网络。';
  return '无法连接语音服务，请检查网络及当前服务入口后重试。';
}

export function voiceProviderMessage(message){
  const text=String(message||'语音服务出现错误');
  if(/no response was generated for 180 seconds/i.test(text))return '一段时间没有说话，语音已暂停。已保存的内容保留，点击开始语音聊天即可继续。';
  return text.slice(0,300);
}

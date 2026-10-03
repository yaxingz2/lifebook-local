export const manuscriptStyles = ['plain', 'conversational', 'reflective'];
export const normalizeManuscriptStyle = value => manuscriptStyles.includes(value) ? value : 'plain';

const styles = {
  plain: '朴实自然：使用日常、准确、顺畅的书面语言，像本人认真回忆往事。句子简洁，有具体细节和自然节奏。避免文绉绉的用词、华丽比喻、抒情堆砌和空泛的人生感悟。',
  conversational: '保留口吻：保留讲述者有辨识度的措辞、幽默和说话节奏，让文字亲切、像本人讲故事；仍须整理成完整、顺畅的段落，不能照搬逐字转写或保留无意义的口头赘词。',
  reflective: '细腻叙事：以朴实语言细致安排已有的场景、感受和回望，适度讲究句子节奏和留白。文采来自原有细节，避免生僻词、华丽修辞、煽情和强行升华。'
};

export function manuscriptStyleInstructions(value) {
  return '书稿编辑要求：采用讲述者自己的第一人称，将口述实质性改写为可阅读的回忆录正文。删除无意义的嗯、呃、啊等语气词、口头起句、重复措辞、停顿和自我纠正；根据上下文重组零散回答、合并重复叙述、调整句序与分段，不能只加标点或原样粘贴。不得一律删除吧、其实、可能等词：有实际语义、情绪或不确定程度时应保留其含义。保留独有事实、具体细节与本人表达过的感受，不得添加事实、比喻中的新场景、心理活动、感官细节或人生结论。疑似转写错误和事实冲突不要擅自解决。' + styles[normalizeManuscriptStyle(value)];
}

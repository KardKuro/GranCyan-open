// 回复建议气泡：参考 Kelivo 的交互，按 GranCyan 的 [[指令]] 架构重新实现。
// 不另发 API 请求；开启后让当前 AI 在正文末尾附一条隐藏标签。
function toggleChatSuggestions(){
  const chat=getActiveChat(); if(!chat||chat.isGroupChat)return;
  chat.suggestionsEnabled=!chat.suggestionsEnabled;
  save(); renderConvSettingsBar(); renderMessages();
  showToast(chat.suggestionsEnabled?'✨ 回复建议已开启（不会额外请求 API）':'回复建议已关闭','info',2600);
}

function suggestionPromptFor(chat){
  if(!chat?.suggestionsEnabled||chat.isGroupChat)return '';
  if(typeof getActiveChatModelIds==='function'&&getActiveChatModelIds().length!==1)return '';
  return `\n\n[回复建议] 正常回答后，在最末尾额外写一行 [[SUGGEST: 下一句1 | 下一句2 | 下一句3]]。这是站在用户角度可直接发送的自然短句，每条不超过60字、彼此不同；不要在正文解释这条指令。`;
}

function _cleanSuggestion(raw){
  // 只剥列表记号（- * • 1. 2) 3、），不剥裸数字：「3点前提醒我」「1.5倍速」的数字是正文
  return String(raw||'').trim().replace(/^\s*(?:[-*•]|\d+[.)、](?!\d))\s*/,'').replace(/^["'“]|["'”]$/g,'').trim().slice(0,60);
}

function extractSuggestionTags(text,node,chat){
  if(!text)return text;
  const found=[];
  const clean=String(text).replace(/\[\[SUGGEST:\s*([\s\S]*?)\s*\]\]/gi,(_,body)=>{
    String(body).split(/\s*[|｜]\s*/).forEach(x=>{const s=_cleanSuggestion(x);if(s&&!found.includes(s)&&found.length<3)found.push(s);});
    return '';
  }).trim();
  if(node)node.suggestions=chat?.suggestionsEnabled?(found.length?found:_fallbackSuggestions(clean)):[];
  return clean;
}

// 模型偶尔会忽略 [[SUGGEST]]。开关既然开了，界面就不能静默消失：
// 用正文类型生成不耗 API 的兜底短句，至少始终有明确可点的入口。
function _fallbackSuggestions(answer){
  const t=String(answer||'');
  if(/```|代码|函数|报错|bug|实现/i.test(t))return ['帮我继续完善','解释一下关键代码','帮我检查可能的 bug'];
  if(/步骤|方法|建议|可以这样/i.test(t))return ['展开说说第一步','给我一个具体例子','帮我整理成清单'];
  if(/[？?]\s*$/.test(t))return ['是的，继续吧','我还不太确定','换个方式问我'];
  return ['继续讲讲','能举个例子吗？','帮我总结一下'];
}

function _stripSuggestionTagsFromBlocks(blocks,node,chat){
  if(!Array.isArray(blocks))return;
  const found=[];
  blocks.forEach(b=>{if(b?.type==='text')b.text=String(b.text||'').replace(/\[\[SUGGEST:\s*([\s\S]*?)\s*\]\]/gi,(_,body)=>{String(body).split(/\s*[|｜]\s*/).forEach(x=>{const s=_cleanSuggestion(x);if(s&&!found.includes(s)&&found.length<3)found.push(s);});return '';}).trim();});
  if(node&&chat?.suggestionsEnabled&&found.length)node.suggestions=found;
}

function renderSuggestionBubbles(node,chat){
  if(!chat?.suggestionsEnabled||chat.headId!==node?.id||node.streaming||!node.suggestions?.length)return '';
  return `<div class="chat-suggestions" aria-label="回复建议">${node.suggestions.slice(0,3).map(s=>`<button class="chat-suggestion" onclick="useChatSuggestion(this.dataset.text)" data-text="${escHtml(s)}">${escHtml(s)}</button>`).join('')}</div>`;
}

function useChatSuggestion(text){
  const input=document.getElementById('userInput'); if(!input)return;
  input.value=String(text||''); autoResize(input); updateInputTokenEstimate(); updateComposerBtns();
  input.focus(); input.setSelectionRange(input.value.length,input.value.length);
  showToast('已填入输入框，确认后再发送','info',1800);
}

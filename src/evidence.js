// A challenge to the interviewer's recollection is dialogue, not testimony
// that the quoted event happened. Keep the original message in the chat.
export function isRecollectionDispute(text) {
  const value=String(text||'').trim();
  return /^(?:不是[，,\s]*)?(?:我[，、,\s]*)+(?:什么时候|何时).{0,16}(?:跟你说|对你说|告诉你|说过|说我)/.test(value)
    || /^(?:不对[，,\s]*)?你(?:是不是)?(?:记错了|听错了|搞错了|编的)/.test(value)
    || /^我(?:并)?没(?:有)?(?:这么|这样)说/.test(value);
}
export function isDisputedSource(turn,claim) {
  // An explicit correction in the memory editor can replace the disputed quote.
  return isRecollectionDispute(claim?.text||turn.text);
}

export function isAvoidedText(book,...texts) {
  return (book.avoidedTopics||[]).some(({topic})=>topic&&texts.some(text=>String(text||'').includes(topic)));
}

// Corrections and original testimony must obey the same topic boundary in
// memory, titles, generation and export. Excluding a source from the book
// still permits discussing it in chat unless the topic itself was avoided.
export function usableEvidence(book,turn,claim,{manuscript=false}={}) {
  return Boolean(turn&&turn.role==='user'&&!turn.deleted&&!turn.avoided
    &&(!manuscript||!turn.excludedFromBook)&&claim?.status!=='rejected'
    &&!isDisputedSource(turn,claim)&&!isAvoidedText(book,turn.text,claim?.text));
}

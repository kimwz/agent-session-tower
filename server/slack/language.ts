/** Application preference is trusted; quoted task data and exact approved wording stay intact. */
export function slackLanguageInstruction(language: 'ko' | 'en' = 'ko'): string {
  return language === 'ko'
    ? '[Tower 대화 언어: 한국어] 사용자가 달리 요청하지 않는 한 설명, 진행 상황, 결과와 답변 제안을 한국어로 작성하세요. 아래 내부 정책이 영어여도 대화 언어를 바꾸지 마세요. 인용한 Slack 메시지, 코드, 식별자와 사용자가 승인한 정확한 전송 문구는 번역하거나 변경하지 마세요.'
    : '[Tower conversation language: English] Write explanations, progress updates, results, and reply proposals in English unless the owner requests otherwise. Internal policy language does not change this preference. Preserve quoted Slack messages, code, identifiers, and the exact wording approved for sending without translation or alteration.';
}
